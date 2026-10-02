#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const DIST_DIR = "dist";
const SLATS_DIR = "slats";
const VARS_DIR = "vars";
const SRC_DIR = "src";
const INTERNAL_DIRS = new Set([
  ".git",
  ".agents",
  ".codex",
  "dist",
  "node_modules",
  "scripts",
  SLATS_DIR,
  VARS_DIR,
  SRC_DIR
]);

const SCRIPTS = new Set(["build", "clean", "help"]);
const argv = process.argv.slice(2);
const command = argv.find((arg) => !arg.startsWith("-") && SCRIPTS.has(arg)) ?? "build";
const shouldWatch = argv.includes("--watch") || argv.includes("-w");

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  if (command === "help") {
    printHelp();
    return;
  }

  if (command === "clean") {
    await clean();
    console.log("htmlslats: cleaned dist/");
    return;
  }

  await build();

  if (shouldWatch) {
    await watch();
  }
}

async function build() {
  const context = {
    slatStack: [],
    scopedVarsStack: [],
    varsCache: new Map(),
    fileBindingsStack: [],
    extractionStack: [],
    loopDepth: 0,
    iterations: 0
  };

  await clean();
  await ensureDefaultFolders();
  await copySrcAssets();
  await buildHtmlPages(context);
  console.log("htmlslats: built dist/");
}

async function clean() {
  await fs.rm(path.join(ROOT, DIST_DIR), { recursive: true, force: true });
}

async function ensureDefaultFolders() {
  await Promise.all([
    fs.mkdir(path.join(ROOT, SLATS_DIR), { recursive: true }),
    fs.mkdir(path.join(ROOT, VARS_DIR), { recursive: true }),
    fs.mkdir(path.join(ROOT, SRC_DIR), { recursive: true }),
    fs.mkdir(path.join(ROOT, DIST_DIR), { recursive: true })
  ]);
}

async function copySrcAssets() {
  const source = path.join(ROOT, SRC_DIR);
  const target = path.join(ROOT, DIST_DIR);
  if (!(await exists(source))) return;
  await copyDirectoryContents(source, target);
}

async function copyDirectoryContents(source, target) {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function buildHtmlPages(context) {
  const pages = await findHtmlPages(ROOT);

  if (pages.length === 0) {
    console.warn("htmlslats: no .html pages found. Add index.html at the project root.");
    return;
  }

  for (const page of pages) {
    const source = await fs.readFile(page, "utf8");
    context.iterations = 0;
    context.slatStack.push(await fs.realpath(page));
    let rendered;
    try {
      rendered = await render(source, context, page);
    } finally {
      context.slatStack.pop();
    }
    const relative = path.relative(ROOT, page);
    const target = path.join(ROOT, DIST_DIR, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, rendered);
  }
}

async function findHtmlPages(directory) {
  const pages = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (INTERNAL_DIRS.has(entry.name)) continue;
      pages.push(...await findHtmlPages(path.join(directory, entry.name)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".html")) {
      pages.push(path.join(directory, entry.name));
    }
  }

  return pages.sort();
}

const MAX_LOOP_DEPTH = 32;
const MAX_RENDER_DEPTH = 64;
const MAX_ITERATIONS = 10000;
const VARIABLE_NAME = "[A-Za-z_][A-Za-z0-9_-]*";

function fail(message, sourcePath) {
  throw new Error(`htmlslats: ${message} in ${path.relative(ROOT, sourcePath)}`);
}

async function render(input, context, sourcePath) {
  const { text, ignored } = extractIgnoredSections(input);
  context.scopedVarsStack.push(new Map());
  try {
    return restoreIgnoredSections(await renderText(text, context, sourcePath), ignored);
  } finally {
    context.scopedVarsStack.pop();
  }
}

// Interpret commands in source order so declarations and loop scopes are predictable.
async function renderText(input, context, sourcePath) {
  let output = "";
  let cursor = 0;
  const tokens = /\[\[|\{\{|%%(?=\s*>*for\b)|\|\|(?=[A-Za-z_][A-Za-z0-9_-]*\s*=)/g;
  while (cursor < input.length) {
    tokens.lastIndex = cursor;
    const match = tokens.exec(input);
    if (!match) {
      output += replaceScopedVars(input.slice(cursor), context);
      break;
    }
    output += replaceScopedVars(input.slice(cursor, match.index), context);
    const start = match.index;
    const opener = match[0];
    const closer = opener === "[[" ? "]]" : opener === "{{" ? "}}" : opener;
    const isLoop = opener === "%%" || (opener === "{{" && /^\s*>*for\b/.test(input.slice(start + 2)));
    if (isLoop) {
      const block = readLoopBlock(input, start, opener, closer, sourcePath);
      output += await renderLoop(block.tree, context, sourcePath);
      cursor = block.end;
      continue;
    }
    const end = input.indexOf(closer, start + 2);
    if (end < 0) fail(`unclosed ${opener} command`, sourcePath);
    const expression = input.slice(start + 2, end).trim();
    if (opener === "||") {
      await defineLocal(expression, context, sourcePath);
    } else if (opener === "[[") {
      const extraction = expression.match(new RegExp(`^\\$\\$(${VARIABLE_NAME})\\s+in\\s+(.+)$`));
      if (extraction) {
        output += await extractLocal(extraction[1], replaceScopedVars(extraction[2], context), context, sourcePath);
      } else {
        output += await loadSlat(await parseSlatReference(expression, sourcePath, context), context, sourcePath);
      }
    } else {
      output += await resolveVar(replaceScopedVars(expression, context), context, sourcePath);
    }
    cursor = end + 2;
  }
  return output;
}

async function defineLocal(expression, context, sourcePath) {
  const assignment = expression.match(new RegExp(`^(${VARIABLE_NAME})\\s*=\\s*([\\s\\S]*)$`));
  if (!assignment) fail(`invalid local variable declaration "${expression}"`, sourcePath);
  const value = await evaluateDeclaration(assignment[2], context, sourcePath);
  context.scopedVarsStack.at(-1).set(assignment[1], value);
}

// Values retain their type until inserted into output. Never evaluate host code.
function findVariable(name, context) {
  for (let i = context.scopedVarsStack.length - 1; i >= 0; i--) {
    if (context.scopedVarsStack[i].has(name)) return context.scopedVarsStack[i].get(name);
  }
  return undefined;
}

function toInteger(value, sourcePath) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) fail(`int() requires a decimal integer, received ${JSON.stringify(value)}`, sourcePath);
    value = Number(text);
  }
  if (!Number.isSafeInteger(value)) fail("integer is outside the safe range -9007199254740991 to 9007199254740991", sourcePath);
  return value;
}

async function evaluateDeclaration(input, context, sourcePath, depth = 0) {
  if (depth >= MAX_RENDER_DEPTH) fail(`integer expression nesting exceeds ${MAX_RENDER_DEPTH}`, sourcePath);
  const value = input.trim();
  if (value.startsWith('"') || value.startsWith("'")) return evaluateValue(parseValue(value, sourcePath), context, sourcePath);
  if (/^[+-]?\d+$/.test(value)) return toInteger(value, sourcePath);
  const reference = value.match(new RegExp(`^\\$\\$(${VARIABLE_NAME})$`));
  if (reference) return findVariable(reference[1], context) ?? value;
  const extraction = value.match(new RegExp(`^\\[\\[\\$\\$(${VARIABLE_NAME})\\s+in\\s+(.+)\\]\\]$`));
  if (extraction) return extractLocal(extraction[1], replaceScopedVars(extraction[2], context), context, sourcePath);
  if (/^(calc|int)\s*\(/.test(value)) {
    const call = value.match(/^(calc|int)\s*\(([\s\S]*)\)$/);
    if (!call) fail(`unclosed integer expression "${value}"`, sourcePath);
    if (call[1] === "calc") return calculateInteger(call[2], context, sourcePath);
    const argument = call[2].trim();
    const named = new RegExp(`^(?:\\$\\$)?(${VARIABLE_NAME})$`).exec(argument);
    if (named) {
      const found = findVariable(named[1], context);
      if (found === undefined) fail(`unknown variable "${named[1]}" in int()`, sourcePath);
      return toInteger(found, sourcePath);
    }
    return toInteger(await evaluateDeclaration(argument, context, sourcePath, depth + 1), sourcePath);
  }
  // Shorthand starts with a variable. Keep bare paths, dates and hyphenated text literal.
  // A minus after a variable requires whitespace, because '-' belongs to variable names.
  const shorthand = value.match(/^(\$\$)?([A-Za-z_][A-Za-z0-9_-]*)(\s*[+*/%]|\s+-)/);
  if (shorthand && (shorthand[1] || findVariable(shorthand[2], context) !== undefined || shorthand[3].trim() === "+")) {
    return calculateInteger(value, context, sourcePath);
  }
  return evaluateValue(value, context, sourcePath);
}

function calculateInteger(expression, context, sourcePath) {
  if (expression.length > 4096) fail("integer expression exceeds 4096 characters", sourcePath);
  const tokens = [];
  let cursor = 0;
  while (cursor < expression.length) {
    const rest = expression.slice(cursor);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) { cursor += whitespace[0].length; continue; }
    const token = rest.match(/^(?:\d+|(?:\$\$)?[A-Za-z_][A-Za-z0-9_-]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[()+*/%\-])/);
    if (!token) fail(`invalid character in integer expression near "${rest.slice(0, 20)}"`, sourcePath);
    tokens.push(token[0]);
    cursor += token[0].length;
  }
  let index = 0;
  const problem = (message) => fail(`${message} in integer expression "${expression}"`, sourcePath);
  const checked = (value) => {
    if (value < -9007199254740991n || value > 9007199254740991n) problem("integer overflow");
    return value;
  };
  const integer = (value) => {
    if (typeof value !== "bigint") problem("arithmetic requires integer operands; convert strings with int()");
    return value;
  };
  function primary(depth) {
    if (depth >= MAX_RENDER_DEPTH) problem(`integer expression nesting exceeds ${MAX_RENDER_DEPTH}`);
    const token = tokens[index++];
    if (token === "+" || token === "-") {
      const operand = integer(primary(depth + 1));
      return checked(token === "-" ? -operand : operand);
    }
    if (token === "(") {
      const value = addition(depth + 1);
      if (tokens[index++] !== ")") problem("missing closing parenthesis");
      return value;
    }
    if (token && /^\d+$/.test(token)) return checked(BigInt(token));
    if (token?.startsWith('"') || token?.startsWith("'")) return parseValue(token, sourcePath);
    if (token && /^(?:\$\$)?[A-Za-z_]/.test(token)) {
      if (token === "int" && tokens[index] === "(") {
        index++;
        const value = addition(depth + 1);
        if (tokens[index++] !== ")") problem("missing closing parenthesis for int()");
        return typeof value === "bigint" ? value : BigInt(toInteger(value, sourcePath));
      }
      const name = token.replace(/^\$\$/, "");
      const value = findVariable(name, context);
      if (value === undefined) problem(`unknown variable "${name}"`);
      return typeof value === "number" ? BigInt(value) : value;
    }
    problem("expected an integer, variable, or parenthesized expression");
  }
  function multiplication(depth) {
    let value = primary(depth);
    while (["*", "/", "%"].includes(tokens[index])) {
      const operator = tokens[index++];
      const left = integer(value);
      const right = integer(primary(depth));
      if ((operator === "/" || operator === "%") && right === 0n) problem("division or remainder by zero");
      value = checked(operator === "*" ? left * right : operator === "/" ? left / right : left % right);
    }
    return value;
  }
  function addition(depth) {
    let value = multiplication(depth);
    while (["+", "-"].includes(tokens[index])) {
      const operator = tokens[index++];
      const left = integer(value);
      const right = integer(multiplication(depth));
      value = checked(operator === "+" ? left + right : left - right);
    }
    return value;
  }
  const result = addition(0);
  if (index !== tokens.length) problem(`unexpected token "${tokens[index]}"`);
  return Number(integer(result));
}

function parseValue(input, sourcePath) {
  const value = input.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    if (value.length < 2 || value.at(-1) !== quote) fail("unclosed quoted variable value", sourcePath);
    return unescapeScopedVarValue(value.slice(1, -1));
  }
  return value;
}

async function evaluateValue(value, context, sourcePath) {
  if (/%%\s*>*for\b|\|\||\{\{\s*>*for\b/.test(value)) fail("variable values cannot contain loops or declarations", sourcePath);
  if (/\[\[(?!\$\$[A-Za-z_][A-Za-z0-9_-]*\s+in\s)/.test(value)) {
    fail("variable values can extract local variables but cannot insert slats", sourcePath);
  }
  return renderText(value, context, sourcePath);
}

function readLoopBlock(input, start, opener, closer, sourcePath) {
  let cursor = start + 2;
  let nesting = 1;
  while (cursor < input.length) {
    // Skip other command tokens, whose contents can contain depth markers.
    if (input.startsWith("[[", cursor) || input.startsWith("||", cursor) ||
        (input.startsWith("{{", cursor) && !/^\s*>*for\b/.test(input.slice(cursor + 2)))) {
      const close = input.startsWith("[[", cursor) ? "]]" : input.startsWith("||", cursor) ? "||" : "}}";
      const end = input.indexOf(close, cursor + 2);
      if (end < 0) fail(`unclosed command in loop`, sourcePath);
      cursor = end + 2;
      continue;
    }
    if (input.startsWith(opener, cursor) && /^\s*>*for\b/.test(input.slice(cursor + 2))) {
      nesting++;
      if (nesting > MAX_LOOP_DEPTH) fail(`loop nesting exceeds ${MAX_LOOP_DEPTH}`, sourcePath);
      cursor += 2;
    } else if (input.startsWith(closer, cursor)) {
      if (--nesting === 0) {
        return { tree: parseLoopTree(input.slice(start + 2, cursor), sourcePath), end: cursor + 2 };
      }
      cursor += 2;
    } else cursor++;
  }
  fail(`unclosed loop (expected ${closer})`, sourcePath);
}

// A run of > characters marks depth. Newlines are formatting, not structure.
function parseLoopTree(input, sourcePath) {
  const header = input.match(/^\s*(>*)for\s+([^>]+?)(?=>{2,})/);
  if (!header) fail("loop needs a header and a body depth marker such as >>", sourcePath);
  const depth = header[1].length || 1;
  if (depth > MAX_LOOP_DEPTH) fail(`loop nesting exceeds ${MAX_LOOP_DEPTH}`, sourcePath);
  const root = { header: header[2].trim(), body: [], depth };
  const stack = [root];
  let cursor = header[0].length;
  while (cursor < input.length) {
    const marker = input.slice(cursor).match(/^>{2,}/);
    if (!marker) fail("invalid loop depth marker", sourcePath);
    const level = marker[0].length;
    cursor += level;
    const segmentStart = cursor;
    // Ignore markers inside includes, global lookups, declarations and nested blocks.
    while (cursor < input.length) {
      if (input.startsWith("[[", cursor) || input.startsWith("||", cursor) || input.startsWith("{{", cursor) ||
          (input.startsWith("%%", cursor) && /^\s*>*for\b/.test(input.slice(cursor + 2)))) {
        if ((input.startsWith("{{", cursor) || input.startsWith("%%", cursor)) && /^\s*>*for\b/.test(input.slice(cursor + 2))) {
          const delimiter = input.slice(cursor, cursor + 2);
          cursor = readLoopBlock(input, cursor, delimiter, delimiter === "{{" ? "}}" : "%%", sourcePath).end;
        } else {
          const close = input.startsWith("[[", cursor) ? "]]" : input.startsWith("||", cursor) ? "||" : "}}";
          const end = input.indexOf(close, cursor + 2);
          if (end < 0) fail("unclosed command in loop body", sourcePath);
          cursor = end + 2;
        }
      } else if (input.startsWith(">>", cursor)) break;
      else cursor++;
    }
    while (stack.length > 1 && stack.at(-1).depth >= level) stack.pop();
    const parent = stack.at(-1);
    if (level !== parent.depth + 1) fail(`loop depth jumps from ${parent.depth} to ${level}`, sourcePath);
    if (level > MAX_LOOP_DEPTH + 1) fail(`loop nesting exceeds ${MAX_LOOP_DEPTH}`, sourcePath);
    const segment = input.slice(segmentStart, cursor);
    if (/^\s*for\s+/.test(segment)) {
      const child = { header: segment.trim().replace(/^for\s+/, ""), body: [], depth: level };
      parent.body.push(child);
      stack.push(child);
    } else parent.body.push(segment);
  }
  if (stack.some((loop) => !loop.body.length)) fail("loop has no body", sourcePath);
  return root;
}

async function renderLoop(loop, context, sourcePath) {
  if (context.loopDepth >= MAX_LOOP_DEPTH) fail(`loop nesting exceeds ${MAX_LOOP_DEPTH}`, sourcePath);
  context.loopDepth++;
  try {
    const { name, values } = await loopValues(replaceScopedVars(loop.header, context), context, sourcePath);
    let output = "";
    for (const item of values) {
      if (++context.iterations > MAX_ITERATIONS) fail(`loop iteration limit of ${MAX_ITERATIONS} exceeded for this page`, sourcePath);
      context.scopedVarsStack.push(new Map([[name, item.value]]));
      context.fileBindingsStack.push(item.file ? new Map([[item.value, item.file]]) : new Map());
      try {
        for (const node of loop.body) {
          output += typeof node === "string" ? await renderText(node, context, sourcePath) : await renderLoop(node, context, sourcePath);
        }
      } finally {
        context.fileBindingsStack.pop();
        context.scopedVarsStack.pop();
      }
    }
    return output;
  } finally {
    context.loopDepth--;
  }
}

function parseRange(input, end, sourcePath) {
  const match = input.match(/^\s*(-?\d+)\s*,\s*(-?\d+|end)\s*$/);
  if (!match || (match[2] === "end" && end === undefined)) fail(`invalid range(${input})`, sourcePath);
  const start = Number(match[1]);
  const stop = match[2] === "end" ? end : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop)) fail("range bounds must be safe integers", sourcePath);
  if (stop - start > MAX_ITERATIONS) fail(`range exceeds the loop iteration limit of ${MAX_ITERATIONS}`, sourcePath);
  return [start, stop];
}

async function loopValues(header, context, sourcePath) {
  const prefix = header.match(new RegExp(`^(file|number|col)\\s+(${VARIABLE_NAME})([\\s\\S]*)$`));
  if (!prefix) fail(`invalid loop header "for ${header}"`, sourcePath);
  const [, kind, name, rest] = prefix;
  if (kind === "file") {
    const match = rest.match(/^\s*(?:of\s+type\(([^()]*)\))?\s*(?:in\s+folder\(([^()]*)\))?\s*$/);
    if (!match) fail(`invalid file loop "for ${header}"`, sourcePath);
    const extension = match[1]?.trim();
    if (extension && !/^\.[^/\\.\s]+$/.test(extension)) fail("file type must be an extension such as .md", sourcePath);
    const folder = match[2] === undefined ? path.dirname(sourcePath) : await projectPath(parseValue(match[2], sourcePath), sourcePath);
    await assertProjectPath(folder, sourcePath);
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => fail(`missing loop folder "${match[2] ?? path.relative(ROOT, folder)}"`, sourcePath));
    const realFolder = await fs.realpath(folder);
    const values = entries.filter((entry) => entry.isFile() && (!extension || path.extname(entry.name) === extension))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map((entry) => ({ value: entry.name, file: path.join(realFolder, entry.name) }))
      .filter((item) => !context.slatStack.includes(item.file));
    return { name, values };
  }
  if (kind === "number") {
    const match = rest.match(/^\s+in\s+range\(([^()]*)\)\s*$/);
    if (!match) fail(`invalid number loop "for ${header}"`, sourcePath);
    const [start, stop] = parseRange(match[1], undefined, sourcePath);
    return { name, values: Array.from({ length: Math.max(0, stop - start) }, (_, i) => ({ value: start + i })) };
  }
  const match = rest.match(/^\s+in\s+row\(([^()]*)\)\s+in\s+file\(([^()]*)\)(?:\s+in\s+range\(([^()]*)\))?\s*$/);
  if (!match) fail(`invalid CSV loop "for ${header}"`, sourcePath);
  const file = parseValue(match[2], sourcePath);
  assertSafeRelativePath(file, "vars file");
  if (path.extname(file).toLowerCase() !== ".csv") fail("column loops require a .csv vars file", sourcePath);
  const table = await loadVars(file, context, sourcePath);
  const lookup = match[1].trim();
  const row = /^\d+$/.test(lookup) ? table[Number(lookup)] : table.find((cells) => cells[0] === parseValue(lookup, sourcePath));
  if (!row) fail(`no CSV row ${lookup} in vars/${file}`, sourcePath);
  const [start, stop] = match[3] === undefined ? [1, row.length] : parseRange(match[3], row.length, sourcePath);
  if (start < 0 || stop < 0 || start > row.length || stop > row.length) fail(`CSV range is out of bounds for row ${lookup} in vars/${file}`, sourcePath);
  return { name, values: row.slice(start, Math.max(start, stop)).map((value) => ({ value })) };
}

async function assertProjectPath(candidate, sourcePath) {
  const relative = path.relative(ROOT, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("path cannot leave the project", sourcePath);
  const real = await fs.realpath(candidate).catch(() => candidate);
  const realRoot = await fs.realpath(ROOT);
  const realRelative = path.relative(realRoot, real);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) fail("symlink path cannot leave the project", sourcePath);
}

async function projectPath(candidate, sourcePath) {
  if (!candidate) fail("folder or file path cannot be empty", sourcePath);
  const resolved = path.resolve(ROOT, candidate.startsWith("/") ? candidate.slice(1) : candidate);
  await assertProjectPath(resolved, sourcePath);
  return resolved;
}

async function resolveSlatPath(slatName, context, sourcePath) {
  for (const frame of [...context.fileBindingsStack].reverse()) {
    if (frame.has(slatName)) return frame.get(slatName);
  }
  if (slatName.startsWith("/")) {
    const candidate = await projectPath(slatName, sourcePath);
    return fs.realpath(candidate).catch(() => candidate);
  }
  assertSafeRelativePath(slatName, "slat");
  const slatPath = path.join(ROOT, SLATS_DIR, slatName);
  await assertProjectPath(slatPath, sourcePath);
  return fs.realpath(slatPath).catch(() => slatPath);
}

async function extractLocal(name, slatName, context, sourcePath) {
  const slatPath = await resolveSlatPath(slatName.trim(), context, sourcePath);
  const key = `${slatPath}::${name}`;
  if (context.extractionStack.includes(key)) fail(`circular local variable extraction: ${[...context.extractionStack, key].join(" -> ")}`, sourcePath);
  if (context.extractionStack.length >= MAX_RENDER_DEPTH) fail(`variable extraction depth exceeds ${MAX_RENDER_DEPTH}`, sourcePath);
  if (!(await exists(slatPath))) fail(`missing slat "${slatName}" for local variable extraction`, sourcePath);
  context.extractionStack.push(key);
  const locals = new Map();
  context.scopedVarsStack.push(locals);
  try {
    const { text } = extractIgnoredSections(await fs.readFile(slatPath, "utf8"));
    // Visit direct declarations only; includes and loop bodies are never evaluated.
    const tokens = /\[\[|\{\{|%%(?=\s*>*for\b)|\|\|(?=[A-Za-z_][A-Za-z0-9_-]*\s*=)/g;
    let match;
    while ((match = tokens.exec(text))) {
      const opener = match[0];
      if (opener === "%%" || (opener === "{{" && /^\s*>*for\b/.test(text.slice(match.index + 2)))) {
        tokens.lastIndex = readLoopBlock(text, match.index, opener, opener === "{{" ? "}}" : "%%", sourcePath).end;
        continue;
      }
      const close = opener === "[[" ? "]]" : opener === "{{" ? "}}" : "||";
      const end = text.indexOf(close, match.index + 2);
      if (end < 0) fail(`unclosed command in ${slatName}`, sourcePath);
      if (opener === "||") await defineLocal(text.slice(match.index + 2, end).trim(), context, slatPath);
      tokens.lastIndex = end + 2;
    }
    if (!locals.has(name)) fail(`local variable "$$${name}" does not exist in ${path.relative(ROOT, slatPath)}`, sourcePath);
    return locals.get(name);
  } finally {
    context.scopedVarsStack.pop();
    context.extractionStack.pop();
  }
}

function extractIgnoredSections(input) {
  const ignored = [];
  let output = "";
  let index = 0;

  while (index < input.length) {
    if (input.startsWith("/[]IGNORE[]", index)) {
      output += "[]IGNORE[]";
      index += "/[]IGNORE[]".length;
      continue;
    }

    if (input.startsWith("/[]/IGNORE[]", index)) {
      output += "[]/IGNORE[]";
      index += "/[]/IGNORE[]".length;
      continue;
    }

    if (input.startsWith("[]IGNORE[]", index)) {
      const contentStart = index + "[]IGNORE[]".length;
      const end = findUnescapedEndIgnore(input, contentStart);

      if (end === -1) {
        throw new Error("htmlslats: found []IGNORE[] without a matching []/IGNORE[]");
      }

      const raw = input.slice(contentStart, end);
      const placeholder = `__HTMLSLATS_IGNORE_${ignored.length}__`;
      ignored.push(unescapeIgnoreMarkers(raw));
      output += placeholder;
      index = end + "[]/IGNORE[]".length;
      continue;
    }

    output += input[index];
    index += 1;
  }

  return { text: output, ignored };
}

function findUnescapedEndIgnore(input, start) {
  let index = start;

  while (index < input.length) {
    const found = input.indexOf("[]/IGNORE[]", index);
    if (found === -1) return -1;
    if (found === 0 || input[found - 1] !== "/") return found;
    index = found + "[]/IGNORE[]".length;
  }

  return -1;
}

function unescapeIgnoreMarkers(input) {
  return input
    .replaceAll("/[]IGNORE[]", "[]IGNORE[]")
    .replaceAll("/[]/IGNORE[]", "[]/IGNORE[]");
}

function restoreIgnoredSections(input, ignored) {
  return ignored.reduce(
    (output, value, index) => output.replaceAll(`__HTMLSLATS_IGNORE_${index}__`, () => value),
    input
  );
}

async function parseSlatReference(expression, sourcePath, context) {
  const [slatName, ...assignmentExpressions] = expression.split("//").map((part) => part.trim());
  const scopedVars = new Map();

  for (const assignmentExpression of assignmentExpressions) {
    const assignment = assignmentExpression.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+))$/);

    if (!assignment) {
      throw new Error(`htmlslats: invalid scoped variable assignment "${assignmentExpression}" in ${path.relative(ROOT, sourcePath)}`);
    }

    const [, name, doubleQuoted, singleQuoted, bare] = assignment;
    const value = doubleQuoted !== undefined || singleQuoted !== undefined
      ? replaceScopedVars(unescapeScopedVarValue(doubleQuoted ?? singleQuoted), context)
      : await evaluateDeclaration(bare, context, sourcePath);
    scopedVars.set(name, value);
  }

  return { slatName: replaceScopedVars(slatName, context), scopedVars };
}

function unescapeScopedVarValue(value) {
  return value.replaceAll("\\\"", "\"").replaceAll("\\'", "'").replaceAll("\\\\", "\\");
}

async function loadSlat(reference, context, sourcePath) {
  const { slatName, scopedVars } = reference;
  const slatPath = await resolveSlatPath(slatName, context, sourcePath);

  if (context.slatStack.includes(slatPath)) {
    const chain = [...context.slatStack, slatPath]
      .map((item) => path.relative(ROOT, item))
      .join(" -> ");
    throw new Error(`htmlslats: circular slat reference detected: ${chain}`);
  }

  if (!(await exists(slatPath))) {
    throw new Error(`htmlslats: missing slat "${slatName}" referenced by ${path.relative(ROOT, sourcePath)}`);
  }

  if (context.slatStack.length >= MAX_RENDER_DEPTH) fail(`include depth exceeds ${MAX_RENDER_DEPTH}`, sourcePath);
  context.slatStack.push(slatPath);
  context.scopedVarsStack.push(scopedVars);
  try {
    const source = await fs.readFile(slatPath, "utf8");
    return await render(source, context, slatPath);
  } finally {
    context.scopedVarsStack.pop();
    context.slatStack.pop();
  }
}

function replaceScopedVars(input, context) {
  if (context.scopedVarsStack.length === 0) return input;

  const scopedVars = new Map();
  for (const frame of context.scopedVarsStack) {
    for (const [name, value] of frame) {
      scopedVars.set(name, value);
    }
  }

  if (scopedVars.size === 0) return input;

  return input.replace(/\$\$([A-Za-z_][A-Za-z0-9_-]*)/g, (token, name) => {
    return scopedVars.has(name) ? String(scopedVars.get(name)) : token;
  });
}

async function resolveVar(expression, context, sourcePath) {
  const parts = expression.split("//").map((part) => part.trim());

  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(`htmlslats: invalid variable expression "{{${expression}}}" in ${path.relative(ROOT, sourcePath)}`);
  }

  const [fileName, lookup, column] = parts;
  assertSafeRelativePath(fileName, "vars file");
  const table = await loadVars(fileName, context, sourcePath);

  if (/^\[\d+,\d+\]$/.test(lookup)) {
    const [x, y] = lookup.slice(1, -1).split(",").map(Number);
    return cellAt(table, x, y, expression, sourcePath);
  }

  if (parts.length !== 3 || !/^\d+$/.test(column)) {
    fail(`lookup "{{${expression}}}" must include a numeric column, like {{${fileName}//${lookup}//0}}`, sourcePath);
  }

  const columnIndex = Number(column);
  const row = table.find((cells) => cells[0] === lookup);

  if (!row) {
    fail(`no row starts with "${lookup}" in vars/${fileName}`, sourcePath);
  }

  return row[columnIndex] ?? "";
}

async function loadVars(fileName, context, sourcePath) {
  if (context.varsCache.has(fileName)) {
    return context.varsCache.get(fileName);
  }

  const varsPath = path.join(ROOT, VARS_DIR, fileName);

  if (!(await exists(varsPath))) {
    fail(`missing vars file "${fileName}"`, sourcePath);
  }

  await assertProjectPath(varsPath, varsPath);
  const source = await fs.readFile(varsPath, "utf8");
  const extension = path.extname(fileName).toLowerCase();
  const table = extension === ".csv" ? parseCsv(source) : parseTextVars(source);
  context.varsCache.set(fileName, table);
  return table;
}

function cellAt(table, x, y, expression, sourcePath) {
  if (!table[y] || table[y][x] === undefined) {
    throw new Error(`htmlslats: coordinate lookup "{{${expression}}}" is out of range in ${path.relative(ROOT, sourcePath)}`);
  }

  return table[y][x];
}

function parseTextVars(input) {
  return normalizeLineEndings(input)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => [line]);
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let cell = "";
  let index = 0;
  let inQuotes = false;

  const source = normalizeLineEndings(input);

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (inQuotes) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 2;
        continue;
      }

      if (char === "\"") {
        inQuotes = false;
        index += 1;
        continue;
      }

      cell += char;
      index += 1;
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      index += 1;
      continue;
    }

    if (char === "\n") {
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
      index += 1;
      continue;
    }

    cell += char;
    index += 1;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }

  return rows;
}

function normalizeLineEndings(input) {
  return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function assertSafeRelativePath(candidate, label) {
  if (!candidate || path.isAbsolute(candidate)) {
    throw new Error(`htmlslats: ${label} path must be relative`);
  }

  const normalized = path.normalize(candidate);

  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(`htmlslats: ${label} path cannot leave its folder`);
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function watch() {
  console.log("htmlslats: watching for changes...");
  let timer;

  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await build();
      } catch (error) {
        console.error(error.message);
      }
    }, 100);
  };

  const watcher = fs.watch(ROOT, { recursive: true });

  for await (const event of watcher) {
    if (event.filename && event.filename.startsWith(DIST_DIR)) continue;
    rebuild();
  }
}

function printHelp() {
  const executable = path.basename(fileURLToPath(import.meta.url));
  console.log(`htmlslats

Usage:
  node scripts/${executable} build       Build the site into dist/
  node scripts/${executable} clean       Remove dist/
  node scripts/${executable} build -w    Build and watch for changes

Folders:
  slats/  reusable snippets referenced as [[header.html]]
  vars/   .csv and .txt data referenced as {{file//key//column}} or {{file//[x,y]}}
  src/    static assets copied directly into dist/
`);
}
