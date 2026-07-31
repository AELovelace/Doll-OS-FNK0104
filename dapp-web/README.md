# dapp.exe browser playground

A static, browser-only IDE and runtime for practicing DOLL-OS `.dapp` programs.

## Run locally

From the repository root:

```powershell
python -m http.server 8080 -d dapp-web
```

Then open `http://localhost:8080`.

## Host it

Upload the contents of `dapp-web/` to any static web host. There is no build
step, server code, package manager, or external asset dependency.

The editor draft and files created by `FOPEN`/`FWRITE` are stored in the
visitor's browser with `localStorage`. They are not uploaded anywhere.

## Rebuild the book

`book.html` is generated from the canonical `docs/DAPP-BOOK.md`:

```powershell
node tools/build-dapp-book.mjs
```

## Runtime coverage

The browser interpreter mirrors the command set documented in `docs/DAPP.md`,
including variables, strings, arrays, expressions, labels, subroutines,
interactive input and keys, character canvases, and the one-file API.

Browser built-ins use simulated values: `$cwd` is `/apps`, `$ip` is `browser`,
`$battery` is `100`, `$wifi` is `1`, and `$heap` is `0`.
