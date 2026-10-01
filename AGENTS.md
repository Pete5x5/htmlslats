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
- Local declaration/redefinition: `||x=123||` (integer), `||x="hello"||` (string), or `||x={{site.csv//Tagline//1}}||` (lookup string); reference with `$$x`.
- Integer arithmetic: `||x=x+1||` or `||x=calc((x + 1) * 2)||`; conversion: `||x=int({{site.csv//Items//1}})||`.
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
- Names follow `[A-Za-z_][A-Za-z0-9_-]*`. Values are integers or strings. Bare signed decimal integer literals become integers; quoted values are always strings, with escaped quotes/backslashes supported. Other bare text remains a string, except recognized arithmetic/function syntax. Direct `$$name` copies and direct local extractions preserve type; mixed text interpolation yields a string. Global CSV/TXT lookups remain strings. Do not evaluate arbitrary JavaScript/Python, insert whole slats, or run loops inside declaration values.
- Local extraction evaluates only direct declarations in the target file, in order, and returns the final declared value. Ignore includes, loops, and ignored regions. An inherited/scoped variable is insufficient: the target must declare the requested variable itself. Missing variables and extraction cycles must produce clear errors with source context.

## Integer Expressions

- `||x=x+1||` and `||x=$$x+1||` calculate and assign an integer. `calc(expression)` is the explicit, recommended form, particularly for numeric-leading/parenthesized expressions. Variable-leading shorthand is recognized when the first variable exists, when it has a `$$` prefix, or when the first operator is `+`. Quote arithmetic-like text to keep it literal. Other unquoted text (including paths/dates) remains supported.
- Arithmetic supports integer literals, variable names with or without `$$`, unary signs, parentheses, and `+ - * / %`. Apply standard precedence. `/` truncates toward zero, and `%` follows the dividend's sign. No floats, powers, comparisons, or arbitrary host-language code. Use a restricted parser, never `eval`/`Function`.
- Because hyphens are valid in variable names, require whitespace before subtraction after a name: `x - 1`. `x-1` is an identifier/bare text. Hyphenated names such as `item-count` continue to work.
- `int(value)` converts integers or strings containing a signed decimal integer, allowing surrounding whitespace. Reject empty/fractional/non-numeric strings. It accepts variable names, `$$` references, quoted numeric text, global lookups, or extractions. Inside `calc`, `int(variable)`/`int("123")` permit explicit conversion; raw global lookups/extractions should be converted in a separate declaration first.
- Quoting prevents arithmetic interpretation and always preserves the string type, including interpolated values. Direct `||copy=$$x||` and `||copy=[[$$x in chart.html]]||` preserve the source type. Bare digit-only values lose formatting (e.g. `007` becomes `7`); quote identifiers that need leading zeroes. Bare `||copy=x||` remains literal text.
- Scoped arguments use the same types: `//y=3` is integer, `//y=$$x` preserves type, and `//y="3"` or `//y="$$x"` is string. Number-loop variables are integers; CSV/file-loop variables remain strings. Convert CSV values explicitly with `int(...)`. Always stringify at output boundaries, without losing types in scopes or extraction.
- Reject strings used as arithmetic operands, missing variables, malformed expressions, zero division/remainder, and overflow with source context. Restrict literals, conversions, and every intermediate result to safe integers in `[-9007199254740991,9007199254740991]`; evaluate integer arithmetic exactly before range checks. Limit arithmetic expressions to 4096 characters and nesting to 64 levels, including nested conversion calls.
- Preserve file/slat/iteration scoping. Calculations read the previous value before assignment. Incrementing an inherited variable inside an iteration does not accumulate across iterations or alter the parent. Numeric loop ranges are computed before rendering the body, so body assignments cannot affect their iteration sequence.

## Loop Semantics

- Whitespace/newlines do not define loop structure; `>` depth markers do. A header at depth `>` repeats its `>>` body. A nested header at `>>for ...` repeats its `>>>` body. Return to a shallower body marker to resume that parent. Depth cannot jump. Independently wrapped nested loops are supported as well.
- Runs of two or more `>` are reserved inside loop bodies; use HTML entities or ignored blocks for literal runs. Markers within declarations/includes are values. Match `%%` with `%%` or `{{` with `}}`. Preserve body whitespace.
- File loops support optional `of type(.extension)` and optional `in folder(path)`. Without type, use all files; without folder, use the current source file's directory (including for slats). Folder paths with or without `/` resolve from the project root. Visit immediate regular files in filename order, with case-sensitive extension matching; skip subdirectories and symlinks.
- A file loop variable contains the basename including extension. An include matching an active file-loop selection resolves to that selected file, including from nested slats. Other relative includes resolve from `slats/`; `/` includes resolve from the project root. Exclude files already active in the render chain, including the current file. Reject explicit include cycles. Constrain paths to the project, including symlink targets.
- Files are inserted as text. There is no Markdown-to-HTML conversion and loops do not generate separate output pages.
- Number loops provide integer-valued loop variables and use `range(start,stop)`, with an inclusive integer start, exclusive stop, and increment `1`. Negative bounds are allowed; reversed/equal bounds are empty. No steps or numerical `end`.
- CSV loops load `.csv` files from `vars/`. `row(3)` means zero-based row index 3; `row(tagline)` looks up the first matching first cell. Quote numeric keys, e.g. `row("123")`. Without a range, iterate every cell except the first. `range(0,end)` includes the key; `end` is row length. Bounds are zero based, stop exclusive, and must be within the row. Include empty cells and report missing rows.
- Enforce limits of 32 active loop levels, 10,000 total iterations per output page, 64 active rendered files, and 64 active extractions. Reset the iteration budget for each page. Report malformed syntax and exceeded limits with source context.
- Keep compatibility with global CSV/TXT lookups, nested slats, scoped variables, and ignored regions. Ignore blocks must preserve all new syntax and literal `$$` values.

See `README.md` for complete docs and examples of all loop types, local-variable extraction, integer arithmetic, and conversions.

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
