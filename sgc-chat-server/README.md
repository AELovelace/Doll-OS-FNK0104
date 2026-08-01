# sgc-chat-server

Backend for `apps/sgc-chat.dapp`, the DOLL-OS/DS chat client. A small
self-contained Node process -- SQLite lives in one file on disk next to it,
so there's no separate database to provision.

## Install as a service

```bash
git clone <this repo> sgc-chat && cd sgc-chat/sgc-chat-server
sudo ./install.sh
```

This creates a dedicated `sgc-chat` system user, **copies the app to
`/opt/sgc-chat`** (not the git clone -- a service account can't be relied on
to have traversal rights into wherever you happened to clone this under your
home directory), runs `npm install` there, and installs+starts a systemd
service (`sgc-chat.service`) that runs `server.js` as that user, restarting
on failure. It's safe to re-run after `git pull`: it re-syncs `/opt/sgc-chat`
from the clone and restarts the service; the `data/` directory (the SQLite
file, living under `/opt/sgc-chat/data`) is never touched.

Useful afterwards:

```bash
systemctl status sgc-chat
journalctl -u sgc-chat -f
sudo systemctl restart sgc-chat
```

Override the port, system user, or install location by setting env vars
before running the script:
`PORT=8080 APP_USER=sgcchat INSTALL_DIR=/srv/sgc-chat sudo -E ./install.sh`.

### Running it by hand instead

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

## Expose it at sadgirlsclub.wtf

The dapp's default endpoint is `https://sadgirlsclub.wtf/dappchat`.
Reverse-proxy that path to the local port, e.g. an Nginx location block:

```nginx
location /dappchat/ {
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
  than `since`, plus `last_id` to pass as `since` on the next poll. `since=0`
  is the no-cursor case a client joins with, and returns the ten *most
  recent* messages rather than the ten oldest, so a joiner lands at the end
  of the conversation instead of fifty polls behind it. A caller that wants
  everything it missed keeps polling while a response comes back full. No
  auth required (reading a room doesn't need an account, only posting to one
  does).

Usernames and room names match `[A-Za-z0-9_-]{1,20}` (usernames need at
least 3 characters); anything else falls back to room `lobby` or is
rejected. Each room keeps only its most recent 500 messages.
