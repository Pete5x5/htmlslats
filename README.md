<p align="center">
  <img src="assets/hslogo.png" alt="htmlslats logo: a hanging wooden slat sign" width="420">
</p>

# htmlslats

htmlslats is a tiny static site builder for composing normal HTML pages from reusable snippets called slats.

Write pages as regular `.html` files, place reusable chunks in `slats/`, keep simple data in `vars/`, and put static assets in `src/`. The build step expands slats and variables into plain static files in `dist/`.

## Quick Start

```sh
npm run build
```

Open `dist/index.html` after building, or deploy `dist/` as a static site.

## Project Layout

```text
.
├── index.html          # home page
├── about.html          # another page
├── docs/               # nested pages and loop content
├── slats/              # reusable snippets
├── vars/               # csv and txt values
├── src/                # static assets copied as-is
└── dist/               # generated output
```

Root `.html` files are treated as pages. Nested `.html` files are also supported, unless they are inside internal folders such as `slats/`, `vars/`, `src/`, `dist/`, or `node_modules/`.

## Slats

Use double square brackets to insert a slat:

```html
[[header.html]]
```

This loads `slats/header.html` and replaces the token with that file's contents. Slats can include other slats and can use variables. A slat can be any text file, including `.html` or `.js`, as long as inserting that text makes sense where you use it.

Pass scoped variables to a slat by adding `//name="value"` after the slat path:

```html
[[product.html//x="s30"]]
```

Inside `slats/product.html`, every `$$x` token is replaced with `s30` while that slat renders. Scoped variables only apply to the referenced slat and any slats it includes, so the same slat can be reused with different values:

```html
[[product.html//x="s30"]]
[[product.html//x="m45"]]
```

Multiple scoped variables are supported:

```html
[[product.html//x="s30"//label="Small product"]]
```

## Global Variables

Use double curly braces to insert values from `vars/`.

Lookup the first row whose first column matches a value, then choose a column number starting at `0`:

Lookup errors identify the source page or slat containing the lookup, using its project-relative path. Missing variable files and missing row keys also report the referencing source file.

```html
{{site.csv//Tagline//1}}
```

Coordinate lookup uses `[x,y]`, where `[0,0]` is the first column of the first row:

```html
{{site.csv//[1,2]}}
```

For this CSV:

```csv
Key,Value
Name,htmlslats
Tagline,Reusable HTML slats for simple static sites.
```

`{{site.csv//Tagline//1}}` returns `Reusable HTML slats for simple static sites.`

`.txt` files are treated as one-column rows, one row per line.

## Local Variables

Declare a variable anywhere in a page or slat with `||name=value||`, then reference it with `$$name`:

```html
||x=123||
<p>$$x</p>
||x="hello world"||
<p>$$x</p>
```

Declarations produce no output. Commands run in source order: the first paragraph receives `123`, and the second receives `hello world`. Variables can hold integers or strings. An unquoted decimal integer such as `123` or `-7` is an integer; single/double quotes always make a string. Other bare text such as `hello` or `hello-world` still works as a string. Quoted values support escaped quotes and backslashes. Names start with a letter or underscore and can contain letters, digits, underscores, and hyphens.

A declaration can copy an existing variable, a global lookup, or an extracted local variable:

```html
||heading={{site.csv//Tagline//1}}||
||copy=$$heading||
||label=[[$$title in card.html]]||
```

Local declarations can redefine inherited or scoped variables. The new value applies to the current file and the slats it subsequently includes. It does not change the caller's value. Each loop iteration has its own scope, so local `=` assignments in one iteration do not carry over to the next or escape the loop. An undefined ordinary `$$name` remains literal, as with scoped variables.

### Outer Variable Updates (`:=`)

Use `=` for a local variable and `:=` when you deliberately want to change a variable outside the current loop iteration or slat. Keeping these separate lets reusable slats and loops use common names such as `x` without accidentally changing their caller's variables.

For example, count the cells after the key in a CSV row:

```html
||x="models"||
||modelCount=0||
%%>for col y in row($$x) in file(models.csv) in range(1,end)
>>||modelCount:=$$modelCount+1||%%
<p>$$modelCount</p>
```

Here, `modelCount` is defined outside the loop. Each `:=` updates that same counter, so its value survives the end of each iteration. A row such as `models,a,b,c` produces a count of `3`. Using `=` inside the loop would create a temporary local counter for each iteration and leave the original counter at `0`.

A child slat can also deliberately update a variable in the slat that called it:

```html
<!-- Parent slat -->
||x=0||
[[child.html]]
<p>$$x</p>
```

```html
<!-- slats/child.html -->
||x:=1||
```

The parent prints `1`. If the child used `||x=1||`, its change would stay local and the parent would print `0`.

An outer variable update skips the current set of local variables and searches outward through containing loop iterations, scoped arguments, and calling slats/pages. It updates the first matching variable it finds. If you pass `[[child.html//x=5]]`, the child's `||x:=1||` updates that temporary scoped argument, leaving the parent's `x` unchanged. If no outer variable with that name exists, the update raises an error; use `=` to declare a new local variable.

The right-hand value follows the same typing, arithmetic, and conversion rules as `=`. It is evaluated before the update, and references such as `$$x` still read the nearest visible value, including a current local variable with that name. For predictable counters, use a separate name from the loop variable and avoid redefining that counter locally. `:=` always targets an outer variable, even when a variable with the same name exists locally.

Outer variable updates are skipped during local extraction (`[[$$x in child.html]]`), so extraction cannot change the caller's variables. They do not count as local declarations.

### Integer Arithmetic

Use integer variables in calculations and redefine them as needed:

```html
||x=0||
||x=x+1||
<p>$$x</p>
```

This prints `1`. For longer expressions, use `calc(...)`:

```html
||count=7||
||last=calc(count - 1)||
||columns=calc((count + 2) / 3)||
<p>Last: $$last; columns: $$columns</p>
```

This prints `Last: 6; columns: 3`. Within calculations, `x` and `$$x` both refer to the variable. `calc(...)` is recommended for expressions starting with numbers or parentheses and whenever a value might be mistaken for ordinary text. Shorthand beginning with an existing variable also supports `x * 2`, `x / 2`, `x % 2`, and `x - 1`; `x+1` and `$$x+1` are always treated as calculations, with errors for missing variables. Quote text that resembles arithmetic.

Supported operations are `+`, `-`, `*`, `/`, and `%` (remainder), with normal precedence: unary signs, then multiplication/division/remainder, then addition/subtraction. Parentheses control grouping. Division truncates toward zero: `calc(7 / 3)` is `2`, and `calc(-7 / 3)` is `-2`. Remainders follow the dividend's sign: `calc(-7 % 3)` is `-1`. Floating-point literals, exponentiation, comparisons, and arbitrary JavaScript/Python code are not supported.

**Subtraction needs whitespace after variable names**, because hyphens are valid in names: use `calc(x - 1)` or `||x=x - 1||`. `x-1` is treated as a name or bare text, not subtraction. A hyphenated variable such as `item-count` remains valid: `calc(item-count + 1)`.

### Types, Conversion, and Copies

Quoted numeric text stays a string, so identifiers and leading zeroes can be preserved:

```html
||code="007"||
||number=int($$code)||
||number=number+1||
<p>Code: $$code; next: $$number</p>
```

This prints `Code: 007; next: 8`. `int(...)` converts an integer or a string containing only a decimal integer (optional sign and surrounding whitespace). It rejects blank strings, fractions, and other text. Inside `calc(...)`, use `int(variable)` when a string must participate in arithmetic:

```html
||count="7"||
||next=calc(int(count) + 1)||
```

CSV/TXT lookups and CSV loop values stay strings, even when their contents are digits. Convert them explicitly:

```html
||count=int({{site.csv//Items//1}})||
||stop=calc(count + 1)||
%%>for number x in range(1,$$stop)
>> <span>$$x</span>
%%
```

This example expects an `Items` row with a decimal integer in column `1`. Direct copies with `||copy=$$x||` and local extractions with `||copy=[[$$x in chart.html]]||` preserve the source type. Combining values into text, or quoting an interpolated value (`||copy="$$x"||`), produces a string. An unquoted bare name such as `||copy=x||` remains literal text; use `$$x` to copy it.

Scoped arguments follow the same type rules: `[[chart.html//y=3]]` passes an integer, `[[chart.html//y=$$x]]` preserves `x`'s type, and `[[chart.html//y="3"]]` or `[[chart.html//y="$$x"]]` passes a string. Output always prints either type as text. Quote digit-only values when their original formatting matters: bare `007` becomes integer `7`.

Number-loop variables are integers. For example, convert zero-based values to one-based values before passing them to a slat:

```html
%%>for number x in range(0,3)
>> ||x=x+1||[[chart.html//y=$$x]]
%%
```

The slat receives integers `1`, `2`, and `3`. Loop ranges are determined before their bodies render, so redefining `x` does not alter iteration order or the range. Using `=` to increment a variable defined outside a loop creates an iteration-local value; it does **not** accumulate across iterations or change the outer variable. Use an outer variable update (`:=`) when you want the counter to accumulate.

Arithmetic rejects string operands, unknown variables, malformed expressions, division/remainder by zero, and integer overflow with source-file context. Integers and every intermediate arithmetic result must be between `-9007199254740991` and `9007199254740991`, inclusive. Expressions are limited to 4096 characters and 64 levels of nesting. No host-language evaluation is used.

### Extract a Local Variable

Read a local variable from a slat without inserting its content:

```html
[[$$title in card.html]]
```

For this `slats/card.html`:

```html
||title="Hello"||
<article>This content is only inserted with [[card.html]].</article>
```

The extraction returns `Hello`. Only direct declarations in the target file count; a variable inherited from the caller, passed as a scoped variable, declared in a loop, or declared in an included slat does not count. Ignored declarations do not count either. All direct declarations are evaluated in order, and the last declaration of the requested variable wins. Includes and loops in the target are skipped.

Declaration values may copy other variable values, including extractions, but cannot insert whole slats or run loops. Missing local variables and circular extractions produce errors identifying the variable and source file.

## Loops

Wrap a loop in `%% ... %%`. Start its header with `>for` and its body with `>>`:

```html
%%>for number x in range(0,3)
>> <span>$$x</span>
%%
```

The leading `>` before `for` is optional. Inline syntax and `{{ ... }}` wrappers are also supported:

```html
%%for number x in range(0,3)>><span>$$x</span>%%
{{>for number x in range(0,3)>><span>$$x</span>}}
```

Use a matching pair of wrappers. These forms perform the same loop; whitespace in the body is preserved, so formatting can add whitespace to the output. A loop variable is available in body text, include paths, scoped assignments, and nested loop headers.

### Loop Through Files

```html
%%>for file x of type(.md) in folder(/docs)
>> <section data-file="$$x">[[$$x]]</section>
%%
```

- `type(.md)` filters by extension, including the leading dot. Matching is case sensitive. Omit `of type(...)` to use all file types.
- `folder(/docs)` selects `docs/` under the project root. Paths with or without a leading slash are relative to the project root. Omit `in folder(...)` to use the directory of the file containing the loop. In a slat, that means the slat's directory.
- Loops visit immediate files only, in filename order; subdirectories and symlinks are skipped. Empty folders produce no output.
- `$$x` is the full filename with its extension, such as `intro.md`, without a folder prefix. `[[$$x]]` inserts the selected file from the loop folder. Other ordinary include paths still resolve inside `slats/`. A root-relative include such as `[[/docs/intro.md]]` explicitly selects a project file.
- The current file and any files already being rendered in its include chain are excluded. An explicit circular include still produces an error.
- File and folder paths cannot leave the project, including through symlinks.

To assemble a docs page, create `docs/index.html`:

```html
[[header.html]]
<main>[[docs-content.html//x="/docs"]]</main>
[[footer.html]]
```

Then create `slats/docs-content.html`:

```html
%%>for file x of type(.md) in folder($$x)
>> <section data-file="$$x">[[$$x]]</section>
%%
```

Add content files such as `docs/intro.md` and `docs/setup.md`. The folder expression reads the scoped `$$x` before the loop uses `x` for each filename. Slat insertion preserves file text; `.md` files are **not converted to HTML**. Use HTML content if you need rendered markup, or handle Markdown separately.

To apply a shared slat to every item, pass the selected filename to it:

```html
%%>for file doc of type(.html) in folder(/docs)
>> [[doc-card.html//filename=$$doc]]
%%
```

With `slats/doc-card.html` containing:

```html
<article>
  <h2>$$filename</h2>
  [[$$filename]]
</article>
```

The selected file remains available to includes inside that slat. File loops assemble content in the current page; they do not generate a separate output page for each item.

### Loop Through Numbers

```html
%%>for number x in range(0,7)
>> [[chart-$$x.html]]
%%
```

Or pass the number to the same slat on every iteration:

```html
%%>for number x in range(0,7)
>> [[chart.html//y=$$x]]
%%
```

Ranges follow Python's two-argument behavior: the start is included, the stop is excluded, and the increment is `1`. `range(0,7)` uses `0` through `6`. Negative integer bounds are allowed; a stop at or below the start produces no iterations. Steps and `end` are not supported for number loops.

### Loop Through a CSV Row

```html
%%>for col x in row(3) in file(vars.csv) in range(1,5)
>> [[chart.html//y=$$x]]
%%
```

CSV files resolve inside `vars/`, so this reads `vars/vars.csv`. Rows and columns are zero based, like coordinate lookups. `row(3)` selects the fourth parsed row. A text lookup selects the first row whose first cell matches:

```html
%%>for col x in row(tagline) in file(vars.csv) in range(0,end)
>> [[chart.html//y=$$x]]
%%
```

`end` means the number of cells in the selected row; the stop is still exclusive. `range(0,end)` includes the first cell (the lookup key). Omit `in range(...)` to use all cells except that first cell:

```html
%%>for col x in row(tagline) in file(vars.csv)
>> <p>$$x</p>
%%
```

Empty cells are included as empty strings. Duplicate keys use the first matching row. Quote a numeric key to distinguish it from a row index: `row("123")`. Missing rows, invalid ranges, and bounds outside the selected row produce clear build errors. Column loops require a `.csv` file.

### Nested Loops and Depth

Each additional `>` adds a level. A loop at depth `>` repeats its `>>` body; a nested loop at `>>` repeats its `>>>` body. Return to `>>` to continue the outer body:

```html
%%>for number x in range(0,2)
>> <section>
>>for number y in range(0,3)
>>> <span>$$x,$$y</span>
>> </section>
%%
```

This produces two sections, each with three spans. Independently wrapped loops can also appear inside a loop body. Inner variables shadow outer variables until the inner loop finishes. Depth must increase one level at a time.

Inside loops, runs of two or more `>` characters are reserved for depth markers. Write literal runs as HTML entities such as `&gt;&gt;`, or wrap literal content in `[]IGNORE[] ... []/IGNORE[]`. Depth markers inside variable declarations and include commands are part of their values, not loop structure. Normal single `>` characters in HTML tags work as usual.

Builds stop with an error above 32 nested loops, 10,000 total loop iterations per output page (including loops in slats), or 64 simultaneously rendered files or variable extractions. These fixed limits protect against runaway templates. All new syntax can be made literal using the existing ignore markers.

## Ignoring Commands

Wrap content in ignore markers when you need slat or variable syntax to remain literal:

```html
[]IGNORE[]
{{site.csv//Tagline//1}}
[[header.html]]
[]/IGNORE[]
```

To print an ignore marker literally, prefix it with a slash:

```html
/[]IGNORE[]
```

This outputs `[]IGNORE[]`.

## Commands

```sh
npm run build   # build into dist/
npm run clean   # remove dist/
npm run dev     # build and watch
npm test        # renderer compatibility and feature tests
```

## Cloudflare Pages

Use these settings:

- Build command: `npm run build`
- Output directory: `dist`
- Node version: 18 or newer

No runtime server is required.

## AI and Agent Notes

See `AGENTS.md` for implementation notes aimed at AI coding agents.
