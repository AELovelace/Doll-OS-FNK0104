# Safely hosting the DOLL-OS web emulator

The emulator is designed to be deployed as static files, but it is still an
interactive code runner. A `.dapp` can read and modify the emulator's virtual
filesystem, ask the visitor for input, and—only after visitor approval—make
HTTP requests.

## Deployment boundary

Publish **only the contents of `dapp-web/`**. Never configure a static host to
publish the repository root: the Arduino checkout can contain the gitignored
`config.h` with real Wi-Fi credentials and API keys.

Prefer a dedicated origin such as `doll.example.com`, with no authenticated
application, admin panel, or domain-wide session cookies on that origin.
Browser storage is isolated by origin, not by URL path, so hosting at
`example.com/doll/` shares local storage and the web security boundary with
everything else on `example.com`.

Use HTTPS in production.

## Response headers

`_headers` contains a secure configuration understood by Cloudflare Pages,
Netlify, and compatible hosts. Configure the equivalent headers in the host's
dashboard when it does not consume `_headers` files.

The policy deliberately allows connections only to the hosting origin and
HTTPS destinations. The emulator adds another layer: app networking is off by
default and each destination origin requires an in-page approval that lasts
only until reload. Requests always use `credentials: "omit"` and a no-referrer
policy, including requests back to the hosting origin.

## App distribution model

The browser bundle contains only the five apps selected by firmware in
`BundledApps.ino`—Adventure, Tetris, Snake, DappChat, and Dappstore—and seeds
them into the immutable `/system/apps` directory. Dapper
fetches the canonical repository
catalog over HTTPS, then verifies the selected FNK0104 artifact's origin, size,
SHA-256, and package metadata before writing it to `/apps`. Other app sources
are not included in the emulator's static JavaScript bundle.

If the emulator and `https://sadgirlsclub.wtf/dapper/` are on different
origins, configure that repository to return `Access-Control-Allow-Origin` for
the emulator origin. It does not need to allow credentials; Dapper never sends
them.

Imported disk images cannot replace firmware apps. Imports and runtime writes
are bounded by file-count, per-file, path-length, directory-count, and total
storage limits.

## Remaining trust rule

Treat an imported or manually edited `.dapp` like a downloaded script. The
runtime does not expose the DOM, cookies, JavaScript, or arbitrary browser APIs,
but a script can erase its virtual files and can send text—including text the
visitor entered—to an approved network destination. Do not enter credentials
into an untrusted app.
