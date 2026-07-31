# sgc-chat-server

Backend for `apps/sgc-chat.dapp`, the DOLL-OS/DS chat client. A small
self-contained Node process -- SQLite lives in one file on disk next to it,
so there's no separate database to provision.

## Run it

```bash
cd sgc-chat-server
npm install
node server.js
```

Listens on `PORT` (default `4390`). The SQLite file is created at
`data/chat.sqlite` next to `server.js`, or wherever `SGC_CHAT_DB` points:

```bash
PORT=4390 SGC_CHAT_DB=/var/lib/sgc-chat/chat.sqlite node server.js
```

Keep it running with whatever this host already uses for that (pm2,
systemd, a screen/tmux session).

## Expose it at sadgirlsclub.wtf

The dapp's default endpoint is `https://sadgirlsclub.wtf/chat`. Reverse-proxy
that path to the local port, e.g. an Nginx location block:

```nginx
location /chat/ {
    proxy_pass http://127.0.0.1:4390/;
    proxy_set_header Host $host;
}
```

If it ends up at a different path or host, edit the `endpoint` line near the
top of `apps/sgc-chat.dapp` (and re-run `tools/regen-bundled-apps.ps1` if the
firmware-bundled copy needs to match).

## API

Every response is HTTP 200 with an `"ok"` field -- AppRunner's `$httpok` only
tells the dapp the request *transported*, so success/failure has to live in
the JSON body itself, not the status code.

- `POST /auth` `{"username","password"}` -- logs in, or creates the account
  on a username's first use. Returns `{"ok":true,"token","created"}` or
  `{"ok":false,"error"}` (`bad_request`, `bad_password`).
- `POST /send` `{"room","text"}`, header `Authorization: Bearer <token>` --
  posts one message. `text` is trimmed to 200 characters server-side.
- `GET /poll?room=<room>&since=<last id seen>` -- up to 10 messages newer
  than `since`, plus `last_id` to pass as `since` on the next poll. No auth
  required (reading a room doesn't need an account, only posting to one
  does).

Usernames and room names match `[A-Za-z0-9_-]{1,20}` (usernames need at
least 3 characters); anything else falls back to room `lobby` or is
rejected. Each room keeps only its most recent 500 messages.
