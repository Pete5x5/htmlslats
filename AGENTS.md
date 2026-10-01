# htmlslats Agent Guide

Use this project as a plain static site. Do not add a frontend framework unless the user asks for one.

## Source Layout

- Root `.html` files are pages. `index.html` is the home page.
- `slats/` contains reusable snippets. Insert one with `[[filename.html]]` or another relative path inside `slats/`.
- `vars/` contains `.csv` and `.txt` files for variable replacement.
- `src/` contains static assets such as `css/`, `img/`, `js/`, and fonts. These copy directly to `dist/`.
- `dist/` is generated output and should not be edited by hand.

## Syntax

- Slat include: `[[header.html]]`
- Project file include: `[[/docs/intro.md]]`; ordinary relative includes still resolve inside `slats/`.
- Slat include with scoped variables: `[[product.html//x="s30"]]`, then use `$$x` inside the slat. Paths and scoped values can reference current variables, e.g. `[[chart-$$x.html]]` or `[[chart.html//y=$$x]]`.
- Local declaration/redefinition: `||x=123||`, `||x="hello"||`, or `||x={{site.csv//Tagline//1}}||`; reference with `$$x`.
- Extract a direct local declaration without inserting the slat: `[[$$x in chart.html]]`.
- File loop: `%%>for file x of type(.md) in folder(/docs)>>[[$$x]]%%`.
- Number loop: `%%>for number x in range(0,7)>>[[chart.html//y=$$x]]%%`.
- CSV row loop: `%%>for col x in row(tagline) in file(site.csv) in range(1,end)>>$$x%%`.
- Loop wrappers can also be `{{>for number x in range(0,7)>>$$x}}`; the initial `>` is optional.
- CSV row lookup: `{{site.csv//Tagline//1}}`
- Coordinate lookup: `{{site.csv//[1,2]}}`
- Ignored block: `[]IGNORE[] {{this stays literal}} []/IGNORE[]`
- Literal ignore marker: `/[]IGNORE[]`

Slats can include more slats and variables. Slats may be `.html`, `.js`, or any text file if the containing page needs that text inserted. Scoped variables passed with `//name="value"` apply only while that slat and its nested slats render, so the same slat can be reused with different `$$name` values.

## Rendering and Scope

- Commands run in source order. Local declarations emit no text and affect later commands in the current file and its included slats. Each page/slat and each loop iteration has its own scope. Local declarations can override inherited/scoped values without changing the caller. Loop variables shadow outer variables until that iteration ends. Undefined ordinary `$$name` tokens stay literal.
- Names follow `[A-Za-z_][A-Za-z0-9_-]*`. Values are strings, optionally quoted, with escaped quotes/backslashes supported. Values may copy `$$name`, global lookups, or local extractions. Do not evaluate JavaScript/Python expressions, insert whole slats, or run loops inside declaration values.
- Local extraction evaluates only direct declarations in the target file, in order, and returns the final declared value. Ignore includes, loops, and ignored regions. An inherited/scoped variable is insufficient: the target must declare the requested variable itself. Missing variables and extraction cycles must produce clear errors with source context.

## Loop Semantics

- Whitespace/newlines do not define loop structure; `>` depth markers do. A header at depth `>` repeats its `>>` body. A nested header at `>>for ...` repeats its `>>>` body. Return to a shallower body marker to resume that parent. Depth cannot jump. Independently wrapped nested loops are supported as well.
- Runs of two or more `>` are reserved inside loop bodies; use HTML entities or ignored blocks for literal runs. Markers within declarations/includes are values. Match `%%` with `%%` or `{{` with `}}`. Preserve body whitespace.
- File loops support optional `of type(.extension)` and optional `in folder(path)`. Without type, use all files; without folder, use the current source file's directory (including for slats). Folder paths with or without `/` resolve from the project root. Visit immediate regular files in filename order, with case-sensitive extension matching; skip subdirectories and symlinks.
- A file loop variable contains the basename including extension. An include matching an active file-loop selection resolves to that selected file, including from nested slats. Other relative includes resolve from `slats/`; `/` includes resolve from the project root. Exclude files already active in the render chain, including the current file. Reject explicit include cycles. Constrain paths to the project, including symlink targets.
- Files are inserted as text. There is no Markdown-to-HTML conversion and loops do not generate separate output pages.
- Number loops use `range(start,stop)`, with an inclusive integer start, exclusive stop, and increment `1`. Negative bounds are allowed; reversed/equal bounds are empty. No steps or numerical `end`.
- CSV loops load `.csv` files from `vars/`. `row(3)` means zero-based row index 3; `row(tagline)` looks up the first matching first cell. Quote numeric keys, e.g. `row("123")`. Without a range, iterate every cell except the first. `range(0,end)` includes the key; `end` is row length. Bounds are zero based, stop exclusive, and must be within the row. Include empty cells and report missing rows.
- Enforce limits of 32 active loop levels, 10,000 total iterations per output page, 64 active rendered files, and 64 active extractions. Reset the iteration budget for each page. Report malformed syntax and exceeded limits with source context.
- Keep compatibility with global CSV/TXT lookups, nested slats, scoped variables, and ignored regions. Ignore blocks must preserve all new syntax and literal `$$` values.

See `README.md` for complete docs and examples of all loop types and local-variable extraction.

## Commands

- Build: `npm run build`
- Clean: `npm run clean`
- Watch: `npm run dev`
- Test renderer compatibility, features, and failures: `npm test`

For Cloudflare Pages, use:

- Build command: `npm run build`
- Output directory: `dist`

## Editing Rules

- Keep reusable page chrome in `slats/`.
- Keep copy or repeatable values in `vars/` when that makes edits easier.
- Put browser assets in `src/`, then reference them from pages as root-relative paths such as `/css/site.css`.
- After changing source files, run `npm run build` and inspect `dist/` if behavior changed.
- When editing the renderer, run `npm test` and keep README/AGENTS syntax and semantics in sync.
