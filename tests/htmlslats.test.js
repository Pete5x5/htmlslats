import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "scripts", "htmlslats.js");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslats-test-"));

try {
  await write("index.html", `<!doctype html>
<title>{{site.csv//Name//1}}</title>
[[header.html]]
<main>
  <p>{{site.csv//Milk//2}}</p>
  <p>{{site.csv//[1,2]}}</p>
  [[product.html//x="s30"//label='Small']]
  [[product.html//x="m45"//label="Medium"]]
  []IGNORE[]{{site.csv//Milk//2}} [[header.html]][]/IGNORE[]
  <p>/[]IGNORE[]</p>
</main>`);
  await write("nested/page.html", `[[nested.html]]`);
  await write("slats/header.html", `<header>[[nav.html]] {{site.csv//Name//1}}</header>`);
  await write("slats/nav.html", `<nav>Nav</nav>`);
  await write("slats/product.html", `<section class="product-$$x"><h2>$$label</h2>[[product-code.html]]</section>`);
  await write("slats/product-code.html", `<span>$$x</span>`);
  await write("slats/nested.html", `<script src="/js/app.js"></script>`);
  await write("vars/site.csv", `Key,Value,Price
Name,htmlslats,
Bread,20260101,$3.99
Milk,"Sept 13","$5.00"
Quoted,"A ""quoted"" value",`);
  await write("src/js/app.js", `console.log("htmlslats");`);

  const result = spawnSync(process.execPath, [cliPath, "build"], {
    cwd: tempRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);

  const index = await fs.readFile(path.join(tempRoot, "dist", "index.html"), "utf8");
  assert.match(index, /<title>htmlslats<\/title>/);
  assert.match(index, /<header><nav>Nav<\/nav> htmlslats<\/header>/);
  assert.match(index, /<p>\$5\.00<\/p>/);
  assert.match(index, /<p>20260101<\/p>/);
  assert.match(index, /<section class="product-s30"><h2>Small<\/h2><span>s30<\/span><\/section>/);
  assert.match(index, /<section class="product-m45"><h2>Medium<\/h2><span>m45<\/span><\/section>/);
  assert.match(index, /\{\{site\.csv\/\/Milk\/\/2\}\} \[\[header\.html\]\]/);
  assert.match(index, /<p>\[\]IGNORE\[\]<\/p>/);

  const nested = await fs.readFile(path.join(tempRoot, "dist", "nested", "page.html"), "utf8");
  assert.equal(nested, `<script src="/js/app.js"></script>`);

  const asset = await fs.readFile(path.join(tempRoot, "dist", "js", "app.js"), "utf8");
  assert.equal(asset, `console.log("htmlslats");`);

  console.log("htmlslats compatibility tests passed");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function write(relativePath, contents) {
  const target = path.join(tempRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

// Each feature fixture builds in its own project, including expected failures.
async function check(files, expected, { page = "index.html", setup } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "htmlslats-feature-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
    }
    await fs.mkdir(path.join(root, "slats"), { recursive: true });
    if (setup) await setup(root);
    const result = spawnSync(process.execPath, [cliPath, "build"], { cwd: root, encoding: "utf8", timeout: 10000 });
    if (expected instanceof RegExp) {
      assert.equal(result.status, 1, `Expected build failure: ${JSON.stringify(files)}\n${result.stderr}`);
      assert.match(result.stderr, expected);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await fs.readFile(path.join(root, "dist", page), "utf8"), expected);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

await check({
  "index.html": '||x=123||$$x||x="hello world"||$$x[[child.html//x="scoped"]]$$x[[child.html]]$$x',
  "slats/child.html": '$$x||x="child"||$$x[[nested.html]]',
  "slats/nested.html": '$$x'
}, "123hello worldscopedchildchildhello worldhello worldchildchildhello world");

await check({
  "index.html": '||x="outer"||%%>for number x in range(0,3)>>$$x:[[chart-$$x.html]]:[[chart.html//y=$$x]];%%$$x',
  "slats/chart-0.html": "zero", "slats/chart-1.html": "one", "slats/chart-2.html": "two",
  "slats/chart.html": "$$y"
}, "0:zero:0;1:one:1;2:two:2;outer");

await check({ "index.html": '%%>for number x in range(0,2)\n>>[$$x]%%{{>for number x in range(0,2)>>[$$x]}}%%for number x in range(2,0)>>unused%%' }, "[0][1][0][1]");
await check({ "index.html": '%%>for number x in range(-2,1)>>$$x;%%' }, "-2;-1;0;");
await check({ "index.html": '%%>for number x in range(0,2)>>A$$x>>for number y in range(0,2)>>>[$$x,$$y]>>B$$x%%' }, "A0[0,0][0,1]B0A1[1,0][1,1]B1");
await check({ "index.html": '{{>for number x in range(0,2)>>%%>for number y in range(0,2)>>[$$x,$$y]%%}}' }, "[0,0][0,1][1,0][1,1]");
await check({ "index.html": '%%>for number x in range(0,2)>>{{>for number y in range(0,2)>>[$$x,$$y]}}%%' }, "[0,0][0,1][1,0][1,1]");
await check({ "index.html": '%%>for number x in range(0,2)>>||y=$$x||$$y%%$$y' }, "01$$y");
await check({ "index.html": '||n=2||%%>for number x in range(0,$$n)>>$$x{{site.csv//a//1}}%%', "vars/site.csv": "a,hello" }, "0hello1hello");

await check({
  "docs/index.html": '[[docs-content.html//x="/docs"]]',
  "slats/docs-content.html": '%%>for file x of type(.md) in folder($$x)>>$$x:[[$$x]];%%',
  "docs/b.md": "B", "docs/a.md": "A", "docs/skip.txt": "skip", "docs/nested/c.md": "nested"
}, "a.md:A;b.md:B;", { page: "docs/index.html" });
await check({
  "docs/index.html": '%%>for file x>>$$x:[[$$x]];%%',
  "docs/b.txt": "B", "docs/a.md": "A"
}, "a.md:A;b.txt:B;", { page: "docs/index.html" });
await check({
  "index.html": "[[list.html]]",
  "slats/list.html": '%%>for file x>>[[$$x]]%%', "slats/a.txt": "A"
}, "A");
await check({ "index.html": '%%>for file x in folder(docs)>>$$x;%%', "docs/a.md": "A", "docs/b.txt": "B" }, "a.md;b.txt;");
await check({ "index.html": '%%>for file x of type(.md) in folder(docs)>>[[$$x]]%%', "docs/a.md": "[[/index.html]]" }, /circular slat reference/);
await check({ "index.html": '[[/docs/a.md]]', "docs/a.md": "raw markdown" }, "raw markdown");

const csv = 'tagline,"hello, world",two,,four\ntagline,second\n123,numeric key';
await check({ "index.html": '%%>for col x in row(tagline) in file(vars.csv)>>[$$x]%%', "vars/vars.csv": csv }, "[hello, world][two][][four]");
await check({ "index.html": '%%>for col x in row(0) in file(vars.csv) in range(1,3)>>[$$x]%%', "vars/vars.csv": csv }, "[hello, world][two]");
await check({ "index.html": '%%>for col x in row(tagline) in file(vars.csv) in range(0,end)>>[$$x]%%', "vars/vars.csv": csv }, "[tagline][hello, world][two][][four]");
await check({ "index.html": '%%>for col x in row("123") in file(vars.csv)>>$$x%%', "vars/vars.csv": csv }, "numeric key");
await check({ "index.html": '%%>for col x in row(tagline) in file(vars.csv) in range(1,3)>>[[chart.html//y=$$x]]%%', "vars/vars.csv": csv, "slats/chart.html": "<p>$$y</p>" }, "<p>hello, world</p><p>two</p>");

await check({ "index.html": '[[$$x in chart.html]]', "slats/chart.html": '[[missing.html]]||x="hello"||<p>not inserted</p>' }, "hello");
await check({ "index.html": '||fallback="outer"||[[$$x in chart.html]]$$fallback', "slats/chart.html": '||x=$$fallback|| ||x={{site.csv//a//1}}||', "vars/site.csv": "a,copy" }, "copyouter");
await check({ "index.html": '[[$$x in chart.html]]', "slats/chart.html": '[]IGNORE[]||x="ignored"||[]/IGNORE[]%%>for number n in range(0,1)>>||x=loop||%%||x=local||' }, "local");
await check({ "index.html": '[[$$x in a.html]]', "slats/a.html": '||x=[[$$y in b.html]]||', "slats/b.html": '||y=copy||' }, "copy");
await check({ "index.html": '||x="old"||||x=$$x new||$$x' }, "old new");
await check({ "index.html": '[]IGNORE[]||x=1||%%>for number x in range(0,2)>>$$x%%[[$$x in absent.html]][]/IGNORE[]' }, '||x=1||%%>for number x in range(0,2)>>$$x%%[[$$x in absent.html]]');

await check({ "index.html": '||x=outer||[[$$x in a.html]]', "slats/a.html": '[[b.html]]', "slats/b.html": '||x=nested||' }, /local variable "\$\$x" does not exist in slats\/a.html/);
await check({ "index.html": '[[$$x in a.html]]', "slats/a.html": '||x=[[$$x in b.html]]||', "slats/b.html": '||x=[[$$x in a.html]]||' }, /circular local variable extraction/);
await check({ "index.html": '%%>for number x in range(0,2)>>$$x' }, /unclosed loop/);
await check({ "index.html": '%%>for number x in range(0,2)>>>>$$x%%' }, /loop depth jumps/);
await check({ "index.html": '%%>for number x in range(0,10001)>>$$x%%' }, /iteration limit/);
await check({ "index.html": '%%>for number x in range(0,101)>>for number y in range(0,100)>>>$$y%%' }, /iteration limit/);
await check({ "index.html": '%%>for number x in range(0,end)>>$$x%%' }, /invalid range/);
await check({ "index.html": '%%>for col x in row(missing) in file(a.csv)>>$$x%%', "vars/a.csv": "a,b" }, /no CSV row missing/);
await check({ "index.html": '%%>for col x in row(a) in file(a.csv) in range(0,9)>>$$x%%', "vars/a.csv": "a,b" }, /CSV range is out of bounds/);
await check({ "index.html": '%%>for file x in folder(../outside)>>$$x%%' }, /path cannot leave the project/);
await check({ "index.html": '%%>for file x in folder(missing)>>$$x%%' }, /missing loop folder/);
await check({ "index.html": '[[../outside.html]]' }, /path cannot leave its folder/);
await check({ "index.html": '[[linked.html]]' }, /symlink path cannot leave the project/, { setup: (root) => fs.symlink(cliPath, path.join(root, "slats/linked.html")) });

let tooDeep = "";
for (let depth = 1; depth <= 33; depth++) tooDeep += `${">".repeat(depth)}for number n in range(0,1)\n`;
tooDeep += `${">".repeat(34)}$$n`;
await check({ "index.html": `%%${tooDeep}%%` }, /loop nesting exceeds 32/);
const includeChain = { "index.html": "[[0.txt]]" };
for (let i = 0; i < 65; i++) includeChain[`slats/${i}.txt`] = i === 64 ? "done" : `[[${i + 1}.txt]]`;
await check(includeChain, /include depth exceeds 64/);

await check({
  "index.html": '%%>for file doc of type(.md) in folder(/docs)>>[[doc-card.html//filename=$$doc]]%%',
  "slats/doc-card.html": '<article>$$filename:[[$$filename]]</article>', "docs/a.md": "A", "docs/b.md": "B"
}, '<article>a.md:A</article><article>b.md:B</article>');
await check({ "index.html": '%%>for number n in range(0,2)>>[]IGNORE[]>>$$n[]/IGNORE[]%%' }, '>>$$n>>$$n');
await check({ "index.html": '{{>for number x in range(0,2)>>{{>for number y in range(0,2)>>$$x,$$y;}}}}' }, '0,0;0,1;1,0;1,1;');
await check({ "index.html": '%%>for number x in range(0,2)>>%%>for number y in range(0,2)>>$$x,$$y;%%%%' }, '0,0;0,1;1,0;1,1;');
await check({ "index.html": '||x="50%%"||$$x' }, '50%%');
await check({ "index.html": '%%>for file x of type(.md)>>[[$$x]]%%', "a.md": "A" }, 'A');
await check({ "index.html": '%%>for file x in folder(empty)>>unused%%' }, '', { setup: (root) => fs.mkdir(path.join(root, "empty")) });
await check({ "index.html": '%%>for number n in range(0,10000)>>%%', "second.html": '%%>for number n in range(0,10000)>>%%' }, '');
await check({ "index.html": '%%>for number n in range(0,2)>>for number n in range(2,4)>>>$$n>>$$n%%' }, '230231');
await check({ "index.html": '%%>for col x in row(a) in file(a.csv)>>$$x%%', "vars/a.csv": "a" }, '');
await check({ "index.html": '%%>for file x in folder(alias)>>[[$$x]]%%', "a.txt": "A" }, 'A', {
  setup: (root) => fs.symlink(root, path.join(root, "alias"))
});
await check({ "index.html": '[[alias.txt]]', "slats/a.txt": '[[a.txt]]' }, /circular slat reference/, {
  setup: (root) => fs.symlink(path.join(root, "slats/a.txt"), path.join(root, "slats/alias.txt"))
});
const extractionChain = { "index.html": '[[$$x in 0.txt]]' };
for (let i = 0; i < 65; i++) extractionChain[`slats/${i}.txt`] = i === 64 ? '||x=done||' : `||x=[[$$x in ${i + 1}.txt]]||`;
await check(extractionChain, /variable extraction depth exceeds 64/);
const loopChain = { "index.html": '[[0.txt]]' };
for (let i = 0; i < 33; i++) loopChain[`slats/${i}.txt`] = `%%>for number n in range(0,1)>>${i === 32 ? '$$n' : `[[${i + 1}.txt]]`}%%`;
await check(loopChain, /loop nesting exceeds 32/);
console.log("htmlslats loop and local variable tests passed");
