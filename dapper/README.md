# DAPPER repository source

This directory configures the static DOLL-OS app repository published at:

```text
https://sadgirlsclub.wtf/dapper/
```

The FNK/Cardputer `.dapp` sources live in `../apps`; Tab5 editions live in the
sibling `Doll-OS-Tab5/apps` checkout. The default configuration combines both
trees into one canonical catalog. Build the deployable repository from the DS
project root with both repositories checked out side by side:

```powershell
node tools/build-dapp-repo.mjs
```

The resulting catalog contains separate versioned artifacts for FNK/Cardputer
and `m5stack-tab5`; publishing it replaces the previous single-board catalog.

Validate without writing output:

```powershell
node tools/build-dapp-repo.mjs --check
```

Run the generator tests:

```powershell
node --test tools/build-dapp-repo.test.mjs
```

The generated `dapper/dist` directory is ignored by Git. Deploy its contents so
that `repo.json` is available at `/dapper/repo.json`. Package paths and published
versions are immutable; change an app by increasing its `@version` first.
