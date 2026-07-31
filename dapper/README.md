# DAPPER repository source

This directory configures the static DOLL-OS app repository published at:

```text
https://sadgirlsclub.wtf/dapper/
```

The source `.dapp` files live in `../apps`. Build the deployable repository from
the project root:

```powershell
node tools/build-dapp-repo.mjs
```

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
