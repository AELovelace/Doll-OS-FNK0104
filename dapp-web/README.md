# DOLL-OS browser tools

This directory contains two static, browser-only experiences:

- `emulator.html` — an integrated DAPP workbench and behavioral DOLL-OS
  emulator. Source written in the left editor is syntax-highlighted, saved into
  the device's `/apps` volume, and launched through its emulated shell and
  AppRunner 1.7.0 runtime.
- `index.html` — the original IDE, now backed by the same AppRunner, virtual
  disk, Dapper client, and browser-audio adapter as the integrated emulator.

## Run locally

From the repository root:

```powershell
python -m http.server 8080 -d dapp-web
```

Then open `http://localhost:8080/emulator.html` for the emulator or
`http://localhost:8080/` for the `.dapp` IDE.

When loaded in an iframe, the emulator automatically switches to the compact
terminal view with no studio, machine controls, visible command dock, or Game
Boy control overlay. Game Boy keyboard bindings continue working while framed.
You can also force the general terminal layout outside an iframe with
`emulator.html?terminal=1`. The canvas tracks the viewport; click the terminal
before typing.

## Host it

Upload the entire contents of `dapp-web/` to any static web host as one
deployment. There is no build step, server code, package manager, or external
asset dependency. Do not mix JavaScript files from different releases: the
shell, Dapper client, AppRunner, and `runtime-config.js` share one runtime
contract.

The editor draft, virtual filesystem, Game Boy battery RAM, and save states are
stored in the visitor's browser with `localStorage`. They are not uploaded
anywhere. ROMs are always selected by the visitor; no ROM content is bundled.
The `gb` command renders the emulator directly inside the DOLL-Screen. Keyboard
and touch input remain in Game Boy mode until Escape or `EXIT GB` returns to the
shell. Use `gb controls` or the in-player `CONTROLS` button to remap all eight
Game Boy inputs; those bindings are also stored only in the visitor's browser.

The emulator's filesystem also stays in browser storage. Its control panel can
export and import a JSON disk image or perform a confirmed factory reset.
Burned-in apps can be opened as source in the workbench, but `/system/apps`
remains immutable; saving creates an editable copy under `/apps`.

## Rebuild bundled emulator apps

`bundled-apps.js` is generated from the firmware seed table and canonical
sources under `apps/`. It embeds Adventure, Tetris, Snake, DappChat, and Dapper
Store; the other apps are fetched and verified by Dapper when a visitor installs
them.

```powershell
node tools/build-web-app-bundle.mjs
node tools/build-web-app-bundle.mjs --check
```

The emulator classifies commands that require raw sockets, a local LLM, MQTT,
or physical hardware as unavailable instead of pretending that ASUKA, Motoko,
SSH, telnet, FTP, ICMP, UART, or USB can run inside an ordinary browser sandbox.
No gateway or server-side component is included.

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

Browser built-ins are connected to the emulated machine state. `$audiook` stays
`0` until a user gesture successfully starts Web Audio. The `radio` command
plays a visitor-supplied HTTP(S) stream through the browser, and `gb` opens the
vendored client-side WASM player.

The firmware-style `settings` command persists overrides in the shared virtual
file `/system/conf/settings.dsys`. The web runner applies `radio.url` and
`radio.volume` after reboot:

```text
settings set radio.url https://radio.example/live.mp3
settings set radio.volume 7
reboot
radio play
```

FTP, Motoko/MQTT, ASUKA, and remote-session settings are hardware-only. The web
runner may preserve those keys as plain text for disk compatibility, but it
never activates the corresponding service. Do not put real API keys or
passwords into the browser disk.

Dapper 1.7 maintains an ownership registry under `/.dapper`, refuses unmanaged
overwrites unless `--force` is explicit, verifies HTTPS artifacts before any
write, and supports `list`, `update`, `remove`, and hash-checking `doctor`.
`dapper refresh` reports both catalog artifacts and compatible packages. With
the current repository it reports 46 artifacts and 43 FNK0104-compatible
packages; the three remaining packages target M5Cardputer. Tracker Music 1.3.1
is compatible with the browser's AppRunner 1.7 runtime and can be installed with
`dapper install tracker-music` before running `run tracker-music`.
