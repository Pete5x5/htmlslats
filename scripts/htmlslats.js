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
    varsCache: new Map()
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
    const rendered = await render(source, context, page);
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

async function render(input, context, sourcePath) {
  const { text, ignored } = extractIgnoredSections(input);
  const withSlats = await replaceSlats(text, context, sourcePath);
  const withScopedVars = replaceScopedVars(withSlats, context);
  const withVars = await replaceVars(withScopedVars, context, sourcePath);
  return restoreIgnoredSections(withVars, ignored);
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
    (output, value, index) => output.replaceAll(`__HTMLSLATS_IGNORE_${index}__`, value),
    input
  );
}

async function replaceSlats(input, context, sourcePath) {
  const tokenPattern = /\[\[([^[\]]+?)\]\]/g;
  let output = "";
  let cursor = 0;

  for (const match of input.matchAll(tokenPattern)) {
    output += input.slice(cursor, match.index);
    const reference = parseSlatReference(match[1].trim(), sourcePath);
    output += await loadSlat(reference, context, sourcePath);
    cursor = match.index + match[0].length;
  }

  output += input.slice(cursor);
  return output;
}

function parseSlatReference(expression, sourcePath) {
  const [slatName, ...assignmentExpressions] = expression.split("//").map((part) => part.trim());
  const scopedVars = new Map();

  for (const assignmentExpression of assignmentExpressions) {
    const assignment = assignmentExpression.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+))$/);

    if (!assignment) {
      throw new Error(`htmlslats: invalid scoped variable assignment "${assignmentExpression}" in ${path.relative(ROOT, sourcePath)}`);
    }

    const [, name, doubleQuoted, singleQuoted, bare] = assignment;
    scopedVars.set(name, unescapeScopedVarValue(doubleQuoted ?? singleQuoted ?? bare));
  }

  return { slatName, scopedVars };
}

function unescapeScopedVarValue(value) {
  return value.replaceAll("\\\"", "\"").replaceAll("\\'", "'").replaceAll("\\\\", "\\");
}

async function loadSlat(reference, context, sourcePath) {
  const { slatName, scopedVars } = reference;
  assertSafeRelativePath(slatName, "slat");
  const slatPath = path.join(ROOT, SLATS_DIR, slatName);

  if (context.slatStack.includes(slatPath)) {
    const chain = [...context.slatStack, slatPath]
      .map((item) => path.relative(ROOT, item))
      .join(" -> ");
    throw new Error(`htmlslats: circular slat reference detected: ${chain}`);
  }

  if (!(await exists(slatPath))) {
    throw new Error(`htmlslats: missing slat "${slatName}" referenced by ${path.relative(ROOT, sourcePath)}`);
  }

  context.slatStack.push(slatPath);
  context.scopedVarsStack.push(scopedVars);
  const source = await fs.readFile(slatPath, "utf8");
  try {
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
    return scopedVars.has(name) ? scopedVars.get(name) : token;
  });
}

async function replaceVars(input, context, sourcePath) {
  const tokenPattern = /\{\{([^{}]+?)\}\}/g;
  let output = "";
  let cursor = 0;

  for (const match of input.matchAll(tokenPattern)) {
    output += input.slice(cursor, match.index);
    output += await resolveVar(match[1].trim(), context, sourcePath);
    cursor = match.index + match[0].length;
  }

  output += input.slice(cursor);
  return output;
}

async function resolveVar(expression, context, sourcePath) {
  const parts = expression.split("//").map((part) => part.trim());

  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(`htmlslats: invalid variable expression "{{${expression}}}" in ${path.relative(ROOT, sourcePath)}`);
  }

  const [fileName, lookup, column] = parts;
  assertSafeRelativePath(fileName, "vars file");
  const table = await loadVars(fileName, context);

  if (/^\[\d+,\d+\]$/.test(lookup)) {
    const [x, y] = lookup.slice(1, -1).split(",").map(Number);
    return cellAt(table, x, y, expression, sourcePath);
  }

  if (parts.length !== 3 || !/^\d+$/.test(column)) {
    throw new Error(`htmlslats: lookup "{{${expression}}}" must include a numeric column, like {{${fileName}//${lookup}//0}}`);
  }

  const columnIndex = Number(column);
  const row = table.find((cells) => cells[0] === lookup);

  if (!row) {
    throw new Error(`htmlslats: no row starts with "${lookup}" in vars/${fileName}`);
  }

  return row[columnIndex] ?? "";
}

async function loadVars(fileName, context) {
  if (context.varsCache.has(fileName)) {
    return context.varsCache.get(fileName);
  }

  const varsPath = path.join(ROOT, VARS_DIR, fileName);

  if (!(await exists(varsPath))) {
    throw new Error(`htmlslats: missing vars file "${fileName}"`);
  }

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
