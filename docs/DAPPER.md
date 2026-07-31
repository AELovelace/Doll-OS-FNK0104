# Dapper

Dapper is the DOLL-OS package manager for `.dapp` applications. It uses the
static repository at:

```text
https://sadgirlsclub.wtf/dapper/repo.json
```

## Commands

```text
dapper runtime
dapper refresh
dapper search [text]
dapper info <id>
dapper install <id>[@version] [--force] [--internal|--sd]
dapper update [id|--all]
dapper remove <id>
dapper doctor
```

Examples:

```text
dapper search game
dapper info snake
dapper install snake
run snake
dapper doctor
dapper update --all
dapper remove snake
```

`dapper install` writes managed apps to `/apps` or `/sd/apps`. Firmware-bundled
apps live in `/system/apps` and act as fallbacks, so installing a newer copy
shadows the built-in version and removing it reveals the built-in copy again. A
manually copied `/apps/<id>.dapp` or `/sd/apps/<id>.dapp` is not overwritten
unless `--force` is supplied.

When an SD card is mounted, `dapper install` asks whether to save the app to
internal flash (`/apps/<id>.dapp`) or the SD card (`/sd/apps/<id>.dapp`). Use
`--internal` or `--sd` to skip the prompt. `dapper update` preserves each managed
app's current location.

## Verification and recovery

Dapper validates HTTPS through ISRG Root X2, validates the repository identity,
streams the catalog into a size-limited cache, and checks package size, SHA-256,
board, AppRunner range, package format, metadata, and line count before install.

Install, update, and remove operations use temporary and backup files on the same
filesystem as the app being changed. If the package registry cannot be committed,
the previous app is restored. `dapper doctor` recalculates every managed package
hash and reports missing, modified, corrupt, or runtime-incompatible
installations.

The first HTTPS operation may wait briefly for NTP because certificate validity
dates cannot be checked safely until the device has a usable clock. If refresh
fails after a catalog has previously been cached, read operations use that cache
and print the network error.
