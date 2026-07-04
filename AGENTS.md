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
- Slat include with scoped variables: `[[product.html//x="s30"]]`, then use `$$x` inside the slat.
- CSV row lookup: `{{site.csv//Tagline//1}}`
- Coordinate lookup: `{{site.csv//[1,2]}}`
- Ignored block: `[]IGNORE[] {{this stays literal}} []/IGNORE[]`
- Literal ignore marker: `/[]IGNORE[]`

Slats can include more slats and variables. Slats may be `.html`, `.js`, or any text file if the containing page needs that text inserted. Scoped variables passed with `//name="value"` apply only while that slat and its nested slats render, so the same slat can be reused with different `$$name` values.

## Commands

- Build: `npm run build`
- Clean: `npm run clean`
- Watch: `npm run dev`

For Cloudflare Pages, use:

- Build command: `npm run build`
- Output directory: `dist`

## Editing Rules

- Keep reusable page chrome in `slats/`.
- Keep copy or repeatable values in `vars/` when that makes edits easier.
- Put browser assets in `src/`, then reference them from pages as root-relative paths such as `/css/site.css`.
- After changing source files, run `npm run build` and inspect `dist/` if behavior changed.
