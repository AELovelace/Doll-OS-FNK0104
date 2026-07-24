# Porting DOLL-OS to DS

DS is DOLL-OS ported from the M5Cardputer (sprite display + physical keyboard) to
a Freenove ESP32-S3 display board (FNK0104-series, sold as "FNK1014B"). Telnet is
the sole *input* path -- this is what replaces DOLL-OS's physical keyboard -- but
the board's own TFT panel still runs as a live mirror of the telnet session ("a
second screen for the cardputer"), output-only. This document is the delta
against DOLL-OS's own `docs/architecture.md` and `docs/api-guide.md` in the
DOLL-OS repo -- read those first for the parts that didn't change.

## Building this sketch

**Open it in the Arduino IDE and select the `esp32s3` profile** from the profile
dropdown in the toolbar (sketch.yaml defines it) before Verify/Upload. That one
selection replaces manually setting Tools > Board/Flash Size/Partition Scheme/
PSRAM/USB Mode -- including `PartitionScheme=custom`, which tells the esp32 core
to use this sketch's own `partitions.csv` (see "Flash/RAM headroom" below)
instead of one of its 4MB-fixed stock tables. It also resolves a real conflict:
this board needs a
Freenove-customized fork of `TFT_eSPI` (adds the `ST77922` driver + per-panel pin
configs stock TFT_eSPI doesn't have), but your global `libraries/TFT_eSPI` install
is a *different*, unrelated config that `bigscreen`/`Evil-M5Project/Evil-CYD-Beta`
depend on. The profile keeps DS's copy (`DS/libraries/TFT_eSPI`,
`DS/libraries/TFT_eSPI_Setups`) fully sketch-local via `sketch.yaml`, so neither
project's config touches the other. If you ever compile via bare `arduino-cli`
instead of the IDE, the profile applies automatically (`default_profile: esp32s3`).

## What carried over unchanged (logic-only port)

Everything that wasn't display/keyboard-specific ported with only the output
calls changed (`addWrappedHistoryLine(...)` -> `outLine(...)`):

- `CommandProcessor.ino`: tokenizing, command history ring buffer, dispatch table
- `Storage.ino`: unified LittleFS + SD path namespace, `ls`/`cd`/`pwd`/`cat`
- `WiFiManager.ino`: scan/connect/save credentials (merged with DS's original
  always-on AP scaffold -- see below)
- `IPTools.ino`, `Ping.ino`: IP info, ping sweep, ARP scan
- `Calc.ino` + `tinyexpr.c/h`: unchanged math engine
- `Dice.ino`: unchanged
- `SysInfo.ino`: heap instrumentation (`free`), extended with a real `battery`
  command -- see below
- `Motoko.ino`: MQTT chat, same Q&A shape
- `Ssh.ino`: libssh_esp32 client, same dedicated-FreeRTOS-task pattern (mbedtls's
  handshake still needs more stack than the loop task provides, board-independent)

## What changed and why

### The interface itself

DOLL-OS's whole input/output model was built for a screen (`terminal.ino`'s
pixel-wrapped sprite history) and a physical keyboard (`hardware.ino`'s
`readKeyboard()`/`readRawKeyBytes()`). Replacing that with telnet meant:

- **Output** (`Output.ino`): a telnet client is a real terminal with its own line
  wrapping and scrollback, so for the *telnet side*, DOLL-OS's pixel-measuring
  wrap logic and scroll-offset bookkeeping are gone. `outLine(text[, color])`
  writes real ANSI SGR codes to the socket instead of setting a per-row
  `uint16_t`. It also mirrors the same line onto the TFT panel (`Display.ino`) --
  see "Display mirror" below for why that side of `terminal.ino` came back.

- **Input** (`TelnetServer.ino`, replaces `hardware.ino` + `terminal.ino`'s
  `drawCommandBar`): DS negotiates the connecting client into character-at-a-
  time mode with server-side echo (`IAC WILL ECHO`, `IAC WILL SUPPRESS-GO-AHEAD`)
  once per connection, then implements a real line editor against that byte
  stream -- `readLineEditedInput()` plays the exact role DOLL-OS's
  `readKeyboard()` did (same reuse across the shell, Motoko's prompts, and ssh's
  password entry), including Up/Down arrow history recall and Left/Right cursor
  movement, redrawn via `\r` + erase-to-end + reprint on every edit.

- **Remote sessions** (`RemoteSession.ino`, `Ssh.ino`'s shell phase,
  `TelnetClient.ino`): DOLL-OS's `RemoteSession` base class owned a poll/pump/
  redraw loop between a keyboard and a sprite. Here "local" is the one connected
  `telnetClient` in both directions: `pumpIncoming()` writes remote bytes
  straight to it, and `readRawUserBytes()` reads the user's keystrokes back off
  it. The local escape chord changed from the physical **Fn+Q** to **Ctrl+T**
  (0x14) -- chosen because it isn't commonly bound by remote shells or BBS-style
  line editors the way Ctrl+C/D/Z are. `usb`'s exit chord (previously Fn+`` ` ``)
  uses the same Ctrl+T convention for consistency.

- **Telnet gets true ANSI passthrough**: for the telnet side only, `ssh` and
  outbound `telnet` forward remote bytes through untouched (after stripping only
  the telnet protocol's own IAC negotiation bytes, a wire-protocol concern, not a
  display one) instead of DOLL-OS's SGR-to-`uint16_t` reinterpretation -- a real
  terminal emulator renders the remote's actual ANSI natively, which is simpler
  *and* more faithful than DOLL-OS's per-row color approximation ever was.

### Display mirror

The TFT panel isn't a second *input* device -- telnet remains the only way to
control DS -- but per the user's request it runs as a live mirror of the telnet
session, "as if it was a second screen for the cardputer." That revived most of
DOLL-OS's `terminal.ino` (pixel-wrapped history, wrap-on-width, per-row color)
and `ansi.ino` (SGR interpretation for raw remote streams), now living in
`Display.ino` and retargeted from an M5GFX sprite to a `TFT_eSPI`/`TFT_eSprite`
one -- the API shapes are close enough that the port is mostly a rename:

- `Output.ino`'s `outLine()`/`outClearScreen()` feed both sides: real ANSI to
  the telnet socket, pixel-wrapped rows to the panel's history ring buffer
  (`addDisplayLine()`).
- The live input line mirrors too: `readLineEditedInput()`'s three call sites
  (`TelnetServer.ino`'s shell loop, `Motoko.ino`, `Ssh.ino`'s password prompt)
  each set `activeInputPrompt`/`activeInputMasked`/`activeInputText`
  (`global.h`) right after every edit, which `Display.ino`'s command-bar
  renderer reads every tick. Unlike DOLL-OS there's no local cursor to keep
  visible on this panel (it isn't being locally edited), so an overlong line
  just drops its head instead of scrolling a tracked cursor into view.
- Raw byte-stream sessions (`ssh`'s shell phase, outbound `telnet`) have no
  local buffer to mirror, so they show a static hint (`"ssh $ "` / `"Ctrl+T to
  quit"`) instead, and their remote bytes are additionally run through
  `Display.ino`'s revived `ansiFilterByte()` (`Ssh.ino`'s `sshPumpStream()`,
  `TelnetClient.ino`'s `remoteTelnetMirrorToDisplay()`) so the panel shows
  colored output even though telnet itself gets a raw, unfiltered copy of the
  same bytes.
- No local scroll-back chord exists (no physical keyboard to send one from), so
  the panel always shows the tail of history -- it just follows along live.
- `usb` mode swaps the mirrored history area for a red warning banner
  (`drawDisplayUsbWarning()`, gated by `usbModeDisplayActive`), the same way
  DOLL-OS's `drawUsbWarning()` covered the terminal area.

**TFT_eSPI fork**: this board needs Freenove's customized TFT_eSPI (adds the
`ST77922` driver + real per-panel pin configs), installed sketch-locally
(`DS/libraries/TFT_eSPI` + `DS/libraries/TFT_eSPI_Setups`) via `sketch.yaml` --
see "Building this sketch" above for why, and pick the panel variant the same
way as `config.h`'s `FNK0104*` macro (`global.h` reads the same macro for
`DISPLAY_WIDTH`/`DISPLAY_HEIGHT`). The N-variant (ST77922, QSPI) path compiles
but wasn't exercised as thoroughly as the default AB/S path, since AB is what
this port was built and tested against.

### Hardware differences

- **SD card**: DOLL-OS's M5Cardputer wires SD over SPI. This board's SD slot
  is on the ESP32-S3's dedicated SDMMC peripheral (4-bit bus), so `Storage.ino`
  uses `SD_MMC` instead of `SD`/`SPI`. Pins live in `config.h`, taken from
  Freenove's own example sketches for this board (`SD_MMC_CLK/CMD/D0-D3_PIN`);
  a `#define` switches between the AB/S panel variant's pins and the N variant's.
- **Battery**: DOLL-OS read `M5Cardputer.Power` directly. This board has no
  fuel-gauge chip, just a divided ADC pin (confirmed against Freenove's own
  `Battery_Voltage` example) -- `SysInfo.ino`'s `readBatteryVoltage()`/
  `readBatteryPercent()` read it directly and estimate percent via a linear
  LiPo curve, exposed as a new top-level `battery` command (DOLL-OS only ever
  exposed this inline in its status bar and Motoko's `/battery`).
- **USB MSC** (`UsbMsc.ino`): board-independent of the telnet-vs-keyboard swap
  -- it's about a physical USB cable to a host PC, not the network. DOLL-OS
  hard-failed the build (`#error`) if Tools > USB Mode wasn't set to
  "USB-OTG (TinyUSB)", safe on a fixed hardware target. Here that Tools setting
  is the user's choice, so `usb` stays registered either way and reports
  itself unavailable at runtime instead of blocking compilation.
- **Networking model**: DOLL-OS only needed Wi-Fi STA mode -- losing it just
  meant losing internet access, not the UI (the screen/keyboard don't depend on
  the network). Here the network *is* the interface, so DS keeps an always-on
  SoftAP (from the original DS scaffold) alongside STA, so the device stays
  reachable over telnet even with no working router credentials.

## Known constraints worth flagging

- **Flash/RAM headroom**: `esp32:esp32:esp32s3` ships stock partition schemes
  (`huge_app`, `app3M_fat9M_16MB`, etc.) sized for 4MB flash regardless of
  which `FlashSize` you pick -- selecting `16M` doesn't make `huge_app` any
  bigger, it just leaves the other 12MB of this board's flash completely
  unpartitioned and unreachable. `sketch.yaml` instead sets
  `PartitionScheme=custom`, which makes the esp32 core pick up the sketch's own
  `partitions.csv` (repo root, next to `DS.ino`) -- a single ~6.25MB app slot
  (`ota_0` subtype, so `boot_app0.bin`'s slot-select still applies even without
  an `app1`/OTA in use) plus a ~9.66MB `spiffs`-labeled partition for LittleFS
  and a small `coredump` partition for crash postmortems, sized to use the
  entire 16MB. With that table, the full build (display mirror included) is
  ~8% flash / ~36% static RAM -- effectively all the growth room this board
  has. PSRAM is `opi` (octal) -- confirmed by `esptool`'s own chip ID readout
  (`Embedded PSRAM 8MB (AP_3v3)`), which matches an ESP32-S3-WROOM-1 N16R8
  module's octal PSRAM part. Earlier in bring-up, `PSRAM=opi` appeared to hang
  boot before `setup()` ever ran, and `PSRAM=disabled` was used as a
  workaround; that turned out to be the wrong diagnosis -- `disabled` let the
  board boot, but broke the TFT SPI bus outright (backlight lit, but the panel
  never rendered anything, confirmed by bypassing this sketch entirely and
  testing Freenove's own unmodified rainbow example under both settings).
  `opi` is the correct setting for this hardware; the original hang had a
  different, still-unidentified cause that stopped reproducing once other
  bring-up issues (LittleFS partition mismatch, stale flash content) were
  fixed. The full-screen `TFT_eSprite` frame buffer (`DISPLAY_WIDTH x
  DISPLAY_HEIGHT x 2` bytes) is allocated at runtime from PSRAM automatically
  (TFT_eSPI prefers it for large sprite allocations when available), not
  counted in that static RAM figure.
- **Single session, same as DOLL-OS's single keyboard.** Only one telnet client
  can be connected at a time; a second connection attempt is rejected with a
  message, matching DOLL-OS's single-keyboard assumption throughout the shared
  input/state model (`commandCursorPos` etc. are shared globals, not per-session).
- **No known-hosts store** for `ssh` -- unchanged from DOLL-OS, still
  trusted-LAN-only.
