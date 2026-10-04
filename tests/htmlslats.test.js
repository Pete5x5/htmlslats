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
      const outputs = typeof expected === "string" ? { [page]: expected } : expected;
      for (const [relative, content] of Object.entries(outputs)) {
        const actual = await fs.readFile(path.join(root, "dist", relative), "utf8");
        if (content instanceof RegExp) assert.match(actual, content);
        else assert.equal(actual, content);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// Lookup failures identify the source template, including nested slats.
await check({
  "index.html": "[[outer.html]]",
  "slats/outer.html": "[[specs.html]]",
  "slats/specs.html": "{{sony-tv-specs.csv//json//tvSpecs}}",
  "vars/sony-tv-specs.csv": "json,value"
}, /lookup "\{\{sony-tv-specs\.csv\/\/json\/\/tvSpecs\}\}" must include a numeric column, like \{\{sony-tv-specs\.csv\/\/json\/\/0\}\} in slats\/specs\.html/);

await check({
  "index.html": "{{site.csv//Name}}",
  "vars/site.csv": "Name,value"
}, /must include a numeric column.* in index\.html/);

await check({
  "index.html": "[[specs.html]]",
  "slats/specs.html": "{{site.csv//Missing//1}}",
  "vars/site.csv": "Name,value"
}, /no row starts with "Missing" in vars\/site\.csv in slats\/specs\.html/);

await check({
  "index.html": "[[specs.html]]",
  "slats/specs.html": "{{missing.csv//Name//1}}"
}, /missing vars file "missing\.csv" in slats\/specs\.html/);

await check({
  "index.html": '||x=123||$$x||x="hello world"||$$x[[child.html//x="scoped"]]$$x[[child.html]]$$x',
  "slats/child.html": '$$x||x="child"||$$x[[nested.html]]',
  "slats/nested.html": '$$x'
}, "123hello worldscopedchildchildhello worldhello worldchildchildhello world");

await check({
  "index.html": '||x="outer"||%%>for number x in range(0,2)>>$$x:[[chart-$$x.html]]:[[chart.html//y=$$x]];%%$$x',
  "slats/chart-0.html": "zero", "slats/chart-1.html": "one", "slats/chart-2.html": "two",
  "slats/chart.html": "$$y"
}, "0:zero:0;1:one:1;2:two:2;outer");

await check({ "index.html": '%%>for number x in range(0,1)\n>>[$$x]%%{{>for number x in range(0,1)>>[$$x]}}%%for number x in range(2,0)>>unused%%' }, "[0][1][0][1]");
await check({ "index.html": '%%>for number x in range(-2,0)>>$$x;%%' }, "-2;-1;0;");
await check({ "index.html": '%%>for number x in range(0,1)>>A$$x>>for number y in range(0,1)>>>[$$x,$$y]>>B$$x%%' }, "A0[0,0][0,1]B0A1[1,0][1,1]B1");
await check({ "index.html": '{{>for number x in range(0,1)>>%%>for number y in range(0,1)>>[$$x,$$y]%%}}' }, "[0,0][0,1][1,0][1,1]");
await check({ "index.html": '%%>for number x in range(0,1)>>{{>for number y in range(0,1)>>[$$x,$$y]}}%%' }, "[0,0][0,1][1,0][1,1]");
await check({ "index.html": '%%>for number x in range(0,1)>>||y=$$x||$$y%%$$y' }, "01$$y");
await check({ "index.html": '||n=1||%%>for number x in range(0,$$n)>>$$x{{site.csv//a//1}}%%', "vars/site.csv": "a,hello" }, "0hello1hello");

await check({
  "docs/index.html": '[[docs-content.html//x="/docs"]]',
  "slats/docs-content.html": '%%>for file x of type(.md) in folder($$x)>>$$x:[[$$x]];%%',
  "docs/b.md": "B", "docs/a.md": "A", "docs/skip.txt": "skip", "docs/nested/c.md": "nested"
}, "a.md:<p>A</p>\n;b.md:<p>B</p>\n;", { page: "docs/index.html" });
await check({
  "docs/index.html": '%%>for file x>>$$x:[[$$x]];%%',
  "docs/b.txt": "B", "docs/a.md": "A"
}, "a.md:<p>A</p>\n;b.txt:B;", { page: "docs/index.html" });
await check({
  "index.html": "[[list.html]]",
  "slats/list.html": '%%>for file x>>[[$$x]]%%', "slats/a.txt": "A"
}, "A");
await check({ "index.html": '%%>for file x in folder(docs)>>$$x;%%', "docs/a.md": "A", "docs/b.txt": "B" }, "a.md;b.txt;");
await check({ "index.html": '%%>for file x of type(.md) in folder(docs)>>[[$$x]]%%', "docs/a.md": "[[/index.html]]" }, /circular slat reference/);
await check({ "index.html": '[[/docs/a.md]]', "docs/a.md": "raw markdown" }, "<p>raw markdown</p>\n");

// Markdown includes format prose while code examples and raw includes stay literal.
await check({
  "index.html": '[[/docs/a.md//label="Welcome"]]',
  "docs/a.md": '# $$label\n\n**Bold** and *italic* with [a link](/about.html).\n\n- One\n- Two\n\n> Quote\n\n```html\n[[missing.html]] $$label ||x=1||\n```\n\n`{{missing.csv//x//1}}`\n',
}, '<h1>Welcome</h1>\n<p><strong>Bold</strong> and <em>italic</em> with <a href="/about.html">a link</a>.</p>\n<ul>\n<li>One</li>\n<li>Two</li>\n</ul>\n<blockquote>\n<p>Quote</p>\n</blockquote>\n<pre><code class="language-html">[[missing.html]] $$label ||x=1||\n</code></pre>\n<p><code>{{missing.csv//x//1}}</code></p>\n');
await check({ "index.html": '[[raw /docs/a.md]]', "docs/a.md": '# $$title\n[[missing.html]]' }, '# $$title\n[[missing.html]]');
await check({ "index.html": '[[/docs/a.MARKDOWN]]', "docs/a.MARKDOWN": '# Title\n\n[]IGNORE[]$$x [[missing.html]][]/IGNORE[]' }, '<h1>Title</h1>\n<p>$$x [[missing.html]]</p>\n');
await check({ "index.html": '[[/docs/a.md]]', "docs/a.md": '||title="Docs"||# $$title\n\n[[note.md]]', "slats/note.md": '**Nested**' }, '<h1>Docs</h1>\n<p><strong>Nested</strong></p>\n');
await check({ "index.html": '[[/docs/a.md]]', "docs/a.md": '| Name | Value |\n| --- | --- |\n| A | **B** |' }, { "index.html": /<table>[\s\S]*<th>Name<\/th>[\s\S]*<td><strong>B<\/strong><\/td>/ });
await check({ "index.html": '[[$$title in /docs/a.md]]', "docs/a.md": '`||title="example"||`\n\n||title="Actual"||\n\n```\n||title="example"||\n```' }, 'Actual');
await check({ "index.html": '[[$$title in /docs/a.md]]', "docs/a.md": '||title="`Docs`"||' }, '`Docs`');
await check({ "index.html": '[[/docs/a.md]]', "docs/a.md": '```\n[]IGNORE[]\n```\n\n`[]/IGNORE[]`' }, '<pre><code>[]IGNORE[]\n</code></pre>\n<p><code>[]/IGNORE[]</code></p>\n');
await check({ "index.html": '[[/docs/a.md]]', "docs/a.md": '> ```\n> [[missing.html]] $$x\n> ```\n\n    {{missing.csv//x//1}}\n\n- Use `[[missing.html]]`\n' }, {
  "index.html": /<blockquote>\n<pre><code>\[\[missing.html\]\] \$\$x\n<\/code><\/pre>\n<\/blockquote>\n<pre><code>\{\{missing.csv\/\/x\/\/1\}\}\n<\/code><\/pre>\n<ul>\n<li>Use <code>\[\[missing.html\]\]<\/code><\/li>/
});
await check({ "index.html": '[[/docs/a.md]]', "docs/a.md": '# CRLF\r\n\r\n```\r\n[[missing.html]]\r\n```' }, '<h1>CRLF</h1>\n<pre><code>[[missing.html]]\n</code></pre>\n');
await check({ "index.html": '[[/docs/a.md]]', "docs/a.md": '[]IGNORE[]\n```\n[[missing.html]]\n[]/IGNORE[]' }, '<pre><code>[[missing.html]]\n</code></pre>\n');
await check({ "index.html": '%%>for number n in range(0,9999)>>%%[[page /docs/a.md]]', "docs/a.md": '%%>for number n in range(0,9999)>>%%# A' }, {
  "index.html": '/docs/a.html', "docs/a.html": /<h1>A<\/h1>/
});
await check({ "index.html": '%%>for number n in range(0,9999)>>%%[[page /docs/a.md]]%%>for number n in range(0,0)>>%%', "docs/a.md": '# A' }, /loop iteration limit.*index.html/);

// Page generation returns URLs to build an index, including nested slat bindings.
await check({
  "docs/index.html": '<ul>%%>for file doc of type(.md) in folder(/docs)>>[[link.html]]%%</ul>',
  "slats/link.html": '<li><a href="[[page $$doc//layout="doc-page.html"]]">$$doc</a></li>',
  "slats/doc-page.html": '<title>$$page-title</title>[[header.html]]<main>$$page-content</main><p>$$page-file:$$page-url</p>',
  "slats/header.html": '<header>Docs</header>',
  "docs/a.md": '# A\n\n**First**', "docs/b.md": '# B'
}, {
  "docs/index.html": '<ul><li><a href="/docs/a.html">a.md</a></li><li><a href="/docs/b.html">b.md</a></li></ul>',
  "docs/a.html": '<title>a</title><header>Docs</header><main><h1>A</h1>\n<p><strong>First</strong></p>\n</main><p>a.md:/docs/a.html</p>',
  "docs/b.html": '<title>b</title><header>Docs</header><main><h1>B</h1>\n</main><p>b.md:/docs/b.html</p>'
});
await check({ "index.html": '[[page /docs/a.md]]', "docs/a.md": '# A' }, {
  "index.html": '/docs/a.html', "docs/a.html": /^<!doctype html>[\s\S]*<title>a<\/title>[\s\S]*<main>\n<h1>A<\/h1>\n<\/main>/
});
await check({
  "index.html": '||counter=0||[[page /docs/a.markdown//output="help/My guide.html"//layout="layout.html"//title="A & B"//label="Hi"]]:$$counter',
  "slats/layout.html": '<title>$$page-title</title><main>$$page-content</main>',
  "docs/a.markdown": '||counter:=counter+1||# $$label\n\nCount: $$counter'
}, {
  "index.html": '/help/My%20guide.html:0',
  "help/My guide.html": '<title>A &amp; B</title><main><h1>Hi</h1>\n<p>Count: 1</p>\n</main>'
});
await check({ "index.html": '[]IGNORE[][[page /docs/missing.md]][]/IGNORE[]' }, '[[page /docs/missing.md]]');
await check({ "index.html": '[[page /docs/a.md]][[page /docs/a.md]]', "docs/a.md": '# A' }, /page output "docs\/a.html" already exists.*index.html/);
await check({ "index.html": '[[page /docs/a.md]]', "docs/a.md": '# A', "docs/a.html": 'Existing' }, /page output "docs\/a.html" already exists.*reserved by docs\/a.html/);
await check({ "index.html": '[[page /docs/a.md]]', "docs/a.md": '# A', "src/docs/a.html": 'Asset' }, /page output "docs\/a.html" already exists.*src\/docs\/a.html/);
await check({ "index.html": '[[page /docs/a.md//output="docs.html/a.html"]]', "docs/a.md": '# A', "src/docs.html": 'Asset' }, /page output.*conflicts with "docs.html"/);
await check({ "index.html": '[[page /docs/a.md//output="../escape.html"]]', "docs/a.md": '# A' }, /invalid page output path.*index.html/);
await check({ "index.html": '[[page /docs/a.md//output="/dist/../../escape.html"]]', "docs/a.md": '# A' }, /invalid page output path/);
await check({ "index.html": '[[page /docs/a.md//output="guide.md"]]', "docs/a.md": '# A' }, /invalid page output path/);
await check({ "index.html": '[[page /docs/a.md//layout="missing.html"]]', "docs/a.md": '# A' }, /missing slat.*missing.html.*index.html/);
await check({ "index.html": '[[page /docs/missing.md]]' }, /missing slat.*missing.md.*index.html/);
await check({ "index.html": '[[page /docs/a.txt]]', "docs/a.txt": 'A' }, /page sources must be .md or .markdown/);
await check({ "index.html": '[[page /docs/a.md]]', "docs/a.md": '[[/index.html]]' }, /circular slat reference/);
await check({ "index.html": '[[page /docs/a.md]]', "docs/a.md": '[[page /docs/b.md]]', "docs/b.md": '[[page /docs/a.md]]' }, /page output.*already exists/);
await check({ "index.html": '[[page /docs/a.md]]', "docs/a.md": '# A' }, /symlink path cannot leave the project/, {
  setup: async (root) => {
    await fs.rm(path.join(root, "docs/a.md"));
    await fs.symlink(path.join(repoRoot, "README.md"), path.join(root, "docs/a.md"));
  }
});

// Both endpoints are included for number and CSV ranges.
await check({ "index.html": '%%>for number z in range(1,7)>>$$z;%%' }, "1;2;3;4;5;6;7;");
await check({ "index.html": '{{>for number z in range(1,1)>>$$z;}}%%>for number z in range(0,0)>>$$z;%%' }, "1;0;");
await check({ "index.html": '%%>for number z in range(-2,1)>>$$z;%%' }, "-2;-1;0;1;");
await check({ "index.html": '%%>for number z in range(-2,-2)>>$$z;%%' }, "-2;");
await check({ "index.html": '%%>for number z in range(1,0)>>unused%%' }, "");
await check({ "index.html": '%%>for number z in range(9007199254740990,9007199254740991)>>$$z;%%' }, "9007199254740990;9007199254740991;");
await check({ "index.html": '%%>for number z in range(-9007199254740991,-9007199254740990)>>$$z;%%' }, "-9007199254740991;-9007199254740990;");
await check({ "index.html": '%%>for number z in range(-9007199254740991,9007199254740991)>>$$z%%' }, /iteration limit/);
await check({ "index.html": '%%>for number z in range(9007199254740991,9007199254740992)>>$$z%%' }, /range bounds must be safe integers/);

// A CSV counter feeds chart ranges directly, including zero and one model.
await check({
  "index.html": '[[sect-product.html//series="empty"]]|[[sect-product.html//series="single"]]|[[sect-product.html//series="seven"]]',
  "slats/sect-product.html": '||rowCount=0||%%>for col model in row($$series) in file(models.csv) in range(1,end)>>||rowCount:=rowCount+1||%%[[chart.html]]',
  "slats/chart.html": '%%>for number z in range(1,$$rowCount)>>[[chart-row.html//i=$$z]]%%',
  "slats/chart-row.html": '<tr>$$i</tr>',
  "vars/models.csv": 'empty\nsingle,a\nseven,a,b,c,d,e,f,g'
}, '|<tr>1</tr>|<tr>1</tr><tr>2</tr><tr>3</tr><tr>4</tr><tr>5</tr><tr>6</tr><tr>7</tr>');

await check({ "index.html": '%%>for col x in row(a) in file(a.csv) in range(1,2)>>[$$x]%%', "vars/a.csv": "a,b,c" }, "[b][c]");
await check({ "index.html": '{{>for col x in row(a) in file(a.csv) in range(2,2)>>[$$x]}}', "vars/a.csv": "a,b,c" }, "[c]");
await check({ "index.html": '%%>for col x in row(a) in file(a.csv) in range(2,1)>>unused%%', "vars/a.csv": "a,b,c" }, "");
await check({ "index.html": '%%>for col x in row(a) in file(a.csv) in range(0,end)>>[$$x]%%', "vars/a.csv": "a" }, "[a]");
await check({ "index.html": '%%>for col x in row(a) in file(a.csv) in range(0,3)>>$$x%%', "vars/a.csv": "a,b,c" }, /CSV range is out of bounds/);
await check({ "index.html": '%%>for col x in row(a) in file(a.csv) in range(-1,1)>>$$x%%', "vars/a.csv": "a,b,c" }, /CSV range is out of bounds/);
await check({ "index.html": '%%>for col x in row(a) in file(a.csv) in range(4,end)>>$$x%%', "vars/a.csv": "a,b,c" }, /CSV range is out of bounds/);
await check({ "index.html": '%%>for col x in row(a) in file(a.csv) in range(1,end)>>%%', "vars/a.csv": `a,${Array(10001).fill("b").join(",")}` }, /iteration limit/);

// Explicit enclosing assignments accumulate without changing local assignment rules.
await check({ "index.html": '||x="models"||||modelCount=0||%%>for col y in row($$x) in file(models.csv) in range(1,end)>>||modelCount:=$$modelCount+1||$$modelCount;%%$$modelCount', "vars/models.csv": "models,a,b,c" }, "1;2;3;3");
await check({ "index.html": '||n=0||%%>for number x in range(0,1)>>for number y in range(0,1)>>>||n:=calc(n+1)||%%$$n' }, "4");
await check({ "index.html": '||n=0||%%>for number x in range(0,1)>>||n=n+1||$$n%%$$n' }, "110");
await check({ "index.html": '||n=0||[[child.html]]$$n', "slats/child.html": '||n:=n+1||' }, "1");
await check({ "index.html": '||n=0||[[child.html//n=10]]$$n', "slats/child.html": '||n:=n+1||$$n' }, "110");
await check({ "index.html": '||n=0||%%>for number x in range(1,0)>>||n:=n+1||%%$$n' }, "0");
await check({ "index.html": '||n=0||[]IGNORE[]||n:=n+1||[]/IGNORE[]$$n' }, "||n:=n+1||0");
await check({ "index.html": '||n:=1||' }, /no enclosing variable.*n.*index.html/);
await check({ "index.html": '||n=0||||n:=1||' }, /no enclosing variable/);
await check({ "index.html": '||n=0||[[$$x in child.html]]$$n', "slats/child.html": '||n:=n+1||||x=2||' }, "20");
await check({ "index.html": '||n=0||[[$$n in child.html]]', "slats/child.html": '||n:=n+1||' }, /does not exist/);
await check({ "index.html": '||n="0"||%%>for number x in range(0,0)>>||n:=n+1||%%' }, /integer/);

const csv = 'tagline,"hello, world",two,,four\ntagline,second\n123,numeric key';
await check({ "index.html": '%%>for col x in row(tagline) in file(vars.csv)>>[$$x]%%', "vars/vars.csv": csv }, "[hello, world][two][][four]");
await check({ "index.html": '%%>for col x in row(0) in file(vars.csv) in range(1,3)>>[$$x]%%', "vars/vars.csv": csv }, "[hello, world][two][]");
await check({ "index.html": '%%>for col x in row(tagline) in file(vars.csv) in range(0,end)>>[$$x]%%', "vars/vars.csv": csv }, "[tagline][hello, world][two][][four]");
await check({ "index.html": '%%>for col x in row("123") in file(vars.csv)>>$$x%%', "vars/vars.csv": csv }, "numeric key");
await check({ "index.html": '%%>for col x in row(tagline) in file(vars.csv) in range(1,3)>>[[chart.html//y=$$x]]%%', "vars/vars.csv": csv, "slats/chart.html": "<p>$$y</p>" }, "<p>hello, world</p><p>two</p><p></p>");

await check({ "index.html": '[[$$x in chart.html]]', "slats/chart.html": '[[missing.html]]||x="hello"||<p>not inserted</p>' }, "hello");
await check({ "index.html": '||fallback="outer"||[[$$x in chart.html]]$$fallback', "slats/chart.html": '||x=$$fallback|| ||x={{site.csv//a//1}}||', "vars/site.csv": "a,copy" }, "copyouter");
await check({ "index.html": '[[$$x in chart.html]]', "slats/chart.html": '[]IGNORE[]||x="ignored"||[]/IGNORE[]%%>for number n in range(0,0)>>||x=loop||%%||x=local||' }, "local");
await check({ "index.html": '[[$$x in a.html]]', "slats/a.html": '||x=[[$$y in b.html]]||', "slats/b.html": '||y=copy||' }, "copy");
await check({ "index.html": '||x="old"||||x=$$x new||$$x' }, "old new");
await check({ "index.html": '[]IGNORE[]||x=1||%%>for number x in range(0,1)>>$$x%%[[$$x in absent.html]][]/IGNORE[]' }, '||x=1||%%>for number x in range(0,1)>>$$x%%[[$$x in absent.html]]');

await check({ "index.html": '||x=outer||[[$$x in a.html]]', "slats/a.html": '[[b.html]]', "slats/b.html": '||x=nested||' }, /local variable "\$\$x" does not exist in slats\/a.html/);
await check({ "index.html": '[[$$x in a.html]]', "slats/a.html": '||x=[[$$x in b.html]]||', "slats/b.html": '||x=[[$$x in a.html]]||' }, /circular local variable extraction/);
await check({ "index.html": '%%>for number x in range(0,1)>>$$x' }, /unclosed loop/);
await check({ "index.html": '%%>for number x in range(0,1)>>>>$$x%%' }, /loop depth jumps/);
await check({ "index.html": '%%>for number x in range(0,10000)>>$$x%%' }, /iteration limit/);
await check({ "index.html": '%%>for number x in range(0,100)>>for number y in range(0,99)>>>$$y%%' }, /iteration limit/);
await check({ "index.html": '%%>for number x in range(0,end)>>$$x%%' }, /invalid range/);
await check({ "index.html": '%%>for col x in row(missing) in file(a.csv)>>$$x%%', "vars/a.csv": "a,b" }, /no CSV row missing/);
await check({ "index.html": '%%>for col x in row(a) in file(a.csv) in range(0,8)>>$$x%%', "vars/a.csv": "a,b" }, /CSV range is out of bounds/);
await check({ "index.html": '%%>for file x in folder(../outside)>>$$x%%' }, /path cannot leave the project/);
await check({ "index.html": '%%>for file x in folder(missing)>>$$x%%' }, /missing loop folder/);
await check({ "index.html": '[[../outside.html]]' }, /path cannot leave its folder/);
await check({ "index.html": '[[linked.html]]' }, /symlink path cannot leave the project/, { setup: (root) => fs.symlink(cliPath, path.join(root, "slats/linked.html")) });

let tooDeep = "";
for (let depth = 1; depth <= 33; depth++) tooDeep += `${">".repeat(depth)}for number n in range(0,0)\n`;
tooDeep += `${">".repeat(34)}$$n`;
await check({ "index.html": `%%${tooDeep}%%` }, /loop nesting exceeds 32/);
const includeChain = { "index.html": "[[0.txt]]" };
for (let i = 0; i < 65; i++) includeChain[`slats/${i}.txt`] = i === 64 ? "done" : `[[${i + 1}.txt]]`;
await check(includeChain, /include depth exceeds 64/);

await check({
  "index.html": '%%>for file doc of type(.md) in folder(/docs)>>[[doc-card.html//filename=$$doc]]%%',
  "slats/doc-card.html": '<article>$$filename:[[$$filename]]</article>', "docs/a.md": "A", "docs/b.md": "B"
}, '<article>a.md:<p>A</p>\n</article><article>b.md:<p>B</p>\n</article>');
await check({ "index.html": '%%>for number n in range(0,1)>>[]IGNORE[]>>$$n[]/IGNORE[]%%' }, '>>$$n>>$$n');
await check({ "index.html": '{{>for number x in range(0,1)>>{{>for number y in range(0,1)>>$$x,$$y;}}}}' }, '0,0;0,1;1,0;1,1;');
await check({ "index.html": '%%>for number x in range(0,1)>>%%>for number y in range(0,1)>>$$x,$$y;%%%%' }, '0,0;0,1;1,0;1,1;');
await check({ "index.html": '||x="50%%"||$$x' }, '50%%');
await check({ "index.html": '%%>for file x of type(.md)>>[[$$x]]%%', "a.md": "A" }, '<p>A</p>\n');
await check({ "index.html": '%%>for file x in folder(empty)>>unused%%' }, '', { setup: (root) => fs.mkdir(path.join(root, "empty")) });
await check({ "index.html": '%%>for number n in range(0,9999)>>%%', "second.html": '%%>for number n in range(0,9999)>>%%' }, '');
await check({ "index.html": '%%>for number n in range(0,1)>>for number n in range(2,3)>>>$$n>>$$n%%' }, '230231');
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
for (let i = 0; i < 33; i++) loopChain[`slats/${i}.txt`] = `%%>for number n in range(0,0)>>${i === 32 ? '$$n' : `[[${i + 1}.txt]]`}%%`;
await check(loopChain, /loop nesting exceeds 32/);
console.log("htmlslats loop and local variable tests passed");


// Integer types, expression evaluation, and template integration.
await check({ "index.html": '||x=123||||x=x+1||$$x' }, '124');
await check({ "index.html": '||x=10||||x=calc((x + 2) * 3)||$$x||x=x - 4||,$$x||x=x / 5||,$$x||x=x % 3||,$$x' }, '36,32,6,0');
await check({ "index.html": '||x=calc(2+3*4)||$$x||x=calc(-(2+3)*4)||,$$x||x=calc(-7/3)||,$$x||x=calc(-7%3)||,$$x' }, '14,-20,-2,-1');
await check({ "index.html": '||x=3||||copy=$$x||||copy=$$copy+2||$$copy,$$x' }, '5,3');
await check({ "index.html": '||text="007"||$$text||n=int($$text)||,$$n||n=n+1||,$$n' }, '007,7,8');
await check({ "index.html": '||x="42"||||n=int(x)||$$n||n=calc(int(x)+1)||,$$n||n=calc(int("12")*2)||,$$n' }, '42,43,24');
await check({ "index.html": '||x=int({{data.csv//count//1}})||||x=x+1||$$x', "vars/data.csv": 'count,4' }, '5');
await check({ "index.html": '||x={{data.csv//count//1}}||$$x', "vars/data.csv": 'count,007' }, '007');
await check({ "index.html": '||title=hello||||slug=hello-world||||date=2026-10-01||||path=docs/intro.md||$$title,$$slug,$$date,$$path' }, 'hello,hello-world,2026-10-01,docs/intro.md');
await check({ "index.html": '||x="x+1"||||y="calc(1+2)"||||z="int(3)"||$$x,$$y,$$z' }, 'x+1,calc(1+2),int(3)');
await check({ "index.html": '||x=2||||y="$$x"||$$y||y=int(y)||||y=y+1||,$$y' }, '2,3');
await check({ "index.html": '||x=7||[[child.html//y=$$x]]$$x[[child.html//y=2]]', "slats/child.html": '||y=y+1||$$y;' }, '8;73;');
await check({ "index.html": '||x=7||[[child.html]]$$x', "slats/child.html": '||x=x+1||$$x;' }, '8;7');
await check({ "index.html": '||x=[[$$n in numbers.html]]||||x=x+1||$$x', "slats/numbers.html": '||n=40||||n=n+1||[[missing.html]]' }, '42');
await check({ "index.html": '||x=int([[$$n in numbers.html]])||||x=x+1||$$x', "slats/numbers.html": '||n="41"||' }, '42');
await check({ "index.html": '||stop=calc(2*2 - 1)||%%>for number x in range(0,$$stop)>>||x=x+1||[[chart-$$x.html]]%%', "slats/chart-1.html": '1', "slats/chart-2.html": '2', "slats/chart-3.html": '3', "slats/chart-4.html": '4' }, '1234');
await check({ "index.html": '%%>for number x in range(0,2)>>[[chart.html//y=$$x]]%%', "slats/chart.html": '||y=y+1||$$y' }, '123');
await check({ "index.html": '%%>for col x in row(counts) in file(data.csv)>>||n=int(x)||||n=n+1||$$n;%%', "vars/data.csv": 'counts,1,2,3' }, '2;3;4;');
await check({ "index.html": '||x=5||%%>for number n in range(0,2)>>||x=x+1||$$x;%%$$x' }, '6;6;6;5');
await check({ "index.html": '||x-y=3||||x-y=calc($$x-y + 1)||$$x-y' }, '4');
await check({ "index.html": '||x=3||||literal=x-1||$$literal||x=x - 1||,$$x' }, 'x-1,2');
await check({ "index.html": '||x=-9007199254740991||$$x||x=9007199254740991||,$$x||x=x - 1||,$$x' }, '-9007199254740991,9007199254740991,9007199254740990');
await check({ "index.html": '[]IGNORE[]||x=x+1||[]/IGNORE[]' }, '||x=x+1||');

await check({ "index.html": '||x="3"||||x=x+1||' }, /arithmetic requires integer operands; convert strings with int\(\)/);
await check({ "index.html": '||x=1||||copy="$$x"||||x=calc(copy+1)||' }, /arithmetic requires integer operands/);
await check({ "index.html": '[[child.html//x="3"]]', "slats/child.html": '||x=x+1||' }, /arithmetic requires integer operands/);
await check({ "index.html": '||x={{data.csv//count//1}}||||x=x+1||', "vars/data.csv": 'count,3' }, /arithmetic requires integer operands/);
await check({ "index.html": '||x=x+1||' }, /unknown variable "x"/);
await check({ "index.html": '||x=calc(missing * 2)||' }, /unknown variable "missing"/);
await check({ "index.html": '||x=int(missing)||' }, /unknown variable "missing" in int\(\)/);
await check({ "index.html": '||x=calc(7/0)||' }, /division or remainder by zero/);
await check({ "index.html": '||x=calc(7%0)||' }, /division or remainder by zero/);
await check({ "index.html": '||x=9007199254740992||' }, /integer is outside the safe range/);
await check({ "index.html": '||x=calc(9007199254740991+1)||' }, /integer overflow/);
await check({ "index.html": '||x=calc(9007199254740991*2/2)||' }, /integer overflow/);
await check({ "index.html": '||x=int("3.5")||' }, /int\(\) requires a decimal integer/);
await check({ "index.html": '||x=int("")||' }, /int\(\) requires a decimal integer/);
await check({ "index.html": '||x=calc(1.5+2)||' }, /invalid character in integer expression/);
await check({ "index.html": '||x=calc(2+)||' }, /expected an integer/);
await check({ "index.html": '||x=calc((2+3)||' }, /missing closing parenthesis/);
await check({ "index.html": '||x=calc(2**3)||' }, /expected an integer/);
await check({ "index.html": '||x=calc(process.exit())||' }, /invalid character in integer expression/);
await check({ "index.html": `||x=calc(${'('.repeat(65)}1${')'.repeat(65)})||` }, /integer expression nesting exceeds 64/);
await check({ "index.html": `||x=${'int('.repeat(65)}1${')'.repeat(65)}||` }, /integer expression nesting exceeds 64/);
await check({ "index.html": `||x=calc(${'1+'.repeat(2050)}1)||` }, /integer expression exceeds 4096 characters/);
console.log("htmlslats integer expression tests passed");
