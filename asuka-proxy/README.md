# asuka-proxy

A small standalone relay so visitors using the [dapp-web](../dapp-web) emulator
in their browser can reach a home-network AI server. `dapp-web` is a static
site with no server of its own (see `dapp-web/README.md`), and a private LAN
address like `192.168.1.250` isn't reachable from the public internet or
CORS-enabled for a browser to call directly — this process bridges that gap.

It does three things an OpenAI-compatible LLM server on your LAN doesn't:
requires a shared-secret bearer token before forwarding anything, adds CORS
headers so a browser on a different origin can call it, and rate-limits by
client IP. It does **not** do TLS — put it behind the reverse proxy you
already run for that.

No dependencies (Node core modules only), so there's no `npm install` step —
just run `server.js` with Node 18+.

## Your setup

Matches the topology you described: nginx (on `10.1.1.23`) already reaches
`192.168.1.250:9090` (your AI server) through firewall rules. Run this process
on `10.1.1.23` alongside nginx, listening on localhost only, and add an nginx
`location` that terminates TLS and forwards to it:

```
UPSTREAM_URL=http://192.168.1.250:9090 \
LISTEN_HOST=127.0.0.1 \
LISTEN_PORT=8787 \
AUTH_TOKEN=<a long random string, e.g. `openssl rand -hex 32`> \
node server.js
```

nginx snippet (add to whatever server block already fronts `10.1.1.23`):

```nginx
location /asuka/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;              # let a streaming reply through incrementally
    proxy_read_timeout 120s;
}
```

`X-Forwarded-For` matters here — without it every request looks like it came
from nginx's own IP and the per-IP rate limit collapses to one shared bucket.

To keep it running, a minimal systemd unit:

```ini
# /etc/systemd/system/asuka-proxy.service
[Unit]
Description=asuka-proxy
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/asuka-proxy/server.js
Environment=UPSTREAM_URL=http://192.168.1.250:9090
Environment=LISTEN_HOST=127.0.0.1
Environment=LISTEN_PORT=8787
Environment=AUTH_TOKEN=changeme-generate-a-real-one
Restart=on-failure
User=nobody

[Install]
WantedBy=multi-user.target
```

## Pointing dapp-web at it

`dapp-web`'s shipped `apps/llm-chat.dapp` already speaks OpenAI-compatible
Chat Completions and already lets a visitor set a custom endpoint + bearer
token at runtime — no dapp-web changes needed. Tell testers to open `llm-chat`
in the emulator and enter:

- **endpoint**: `https://your-domain.example/asuka/v1/chat/completions`
  (or whatever public path your nginx `location` above answers on)
- **Bearer token**: the `AUTH_TOKEN` value you set

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `UPSTREAM_URL` | `http://192.168.1.250:9090` | Base URL of your AI server |
| `LISTEN_HOST` | `127.0.0.1` | Bind address — keep this `127.0.0.1` and let nginx front it |
| `LISTEN_PORT` | `8787` | Local port nginx proxies to |
| `AUTH_TOKEN` | *(required)* | Shared secret visitors must send as `Authorization: Bearer <token>`. The process refuses to start without one. |
| `ALLOWED_ORIGIN` | `*` | `Access-Control-Allow-Origin` value. Narrow this to your dapp-web deployment's origin once you know it, e.g. `https://yourname.pages.dev` |
| `ALLOWED_PATHS` | `/v1/chat/completions` | Comma-separated allowlist of paths forwarded to upstream — everything else 404s, so this can't become an open relay to arbitrary paths on your LAN |
| `MAX_BODY_BYTES` | `1000000` | Reject request bodies larger than this |
| `RATE_LIMIT_PER_MIN` | `20` | Per-IP request cap (sliding 60s window); excess requests get `429` |
| `UPSTREAM_TIMEOUT_MS` | `60000` | How long to wait on the upstream AI server before giving up with `502` |

## What it does not do

- No TLS — nginx's job.
- Doesn't forward the visitor's bearer token upstream to `192.168.1.250`; it's
  checked against `AUTH_TOKEN` and stopped here, since the token authenticates
  the visitor to *this* proxy, not to your AI server.
- Rate limiting and the request log reset on restart — it's an in-memory
  sliding window, not persisted, fine for a demo but not a real abuse control.
- `GET /healthz` is intentionally unauthenticated (just confirms the process
  is up, makes no upstream call) — safe to point an uptime check at.
