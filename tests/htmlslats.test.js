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

  console.log("htmlslats tests passed");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function write(relativePath, contents) {
  const target = path.join(tempRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}
