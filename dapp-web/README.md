# DOLL-OS browser tools

This directory contains two static, browser-only experiences:

- `emulator.html` — an integrated DAPP workbench and behavioral DOLL-OS
  emulator. Source written in the left editor is syntax-highlighted, saved into
  the device's `/apps` volume, and launched through its emulated shell and
  AppRunner 1.5.0 runtime.
- `index.html` — the original IDE and runtime for practicing `.dapp` programs.

## Run locally

From the repository root:

```powershell
python -m http.server 8080 -d dapp-web
```

Then open `http://localhost:8080/emulator.html` for the emulator or
`http://localhost:8080/` for the `.dapp` IDE.

For an iframe-sized terminal with no studio or device controls, use
`emulator.html?terminal=1`. The canvas tracks the iframe viewport and keeps the
keyboard input offscreen; click the terminal before typing.

## Host it

Upload the contents of `dapp-web/` to any static web host. There is no build
step, server code, package manager, or external asset dependency.

The editor draft and files created by `FOPEN`/`FWRITE` are stored in the
visitor's browser with `localStorage`. They are not uploaded anywhere.

The emulator's filesystem also stays in browser storage. Its control panel can
export and import a JSON disk image or perform a confirmed factory reset.
Burned-in apps can be opened as source in the workbench, but `/system/apps`
remains immutable; saving creates an editable copy under `/apps`.

## Rebuild bundled emulator apps

`bundled-apps.js` is generated from the firmware seed table and canonical
sources under `apps/`. It embeds only Adventure, Tetris, Snake, and DappChat;
the other apps are fetched and verified by Dapper when a visitor installs them.

```powershell
node tools/build-web-app-bundle.mjs
node tools/build-web-app-bundle.mjs --check
```

The emulator classifies commands that require raw sockets or physical hardware
as unavailable instead of pretending that SSH, telnet, FTP, ICMP, UART, or USB
can run inside an ordinary browser sandbox.

## Static-hosting safety

Publish only this `dapp-web/` directory—not the Arduino repository root, which
may contain a local `config.h` with secrets. A dedicated origin is strongly
recommended. See [`STATIC-HOSTING.md`](STATIC-HOSTING.md) for the deployment
boundary, security headers, network-permission model, and remaining trust rules.

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
