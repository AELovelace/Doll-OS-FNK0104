#!/usr/bin/env bash
# Install (or update) sgc-chat-server as a systemd service.
#
#   git clone <repo> && cd <repo>/sgc-chat-server
#   sudo ./install.sh
#
# Safe to re-run after a `git pull` -- it stops the service, refreshes
# node_modules, rewrites the unit file, and starts it back up. The SQLite
# data directory is never touched on re-run.
#
# Override defaults by setting env vars before running, e.g.:
#   PORT=8080 APP_USER=sgcchat sudo -E ./install.sh

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-sgc-chat}"
APP_USER="${APP_USER:-sgc-chat}"
PORT="${PORT:-4390}"

if [[ $EUID -ne 0 ]]; then
    echo "run this with sudo (it creates a system user and a systemd unit)" >&2
    exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemd not found -- this script only knows how to install a systemd service." >&2
    echo "Run 'node server.js' directly (see README.md) and manage it with whatever this host uses instead." >&2
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "node not found on PATH -- install Node.js first (18+), then re-run this script." >&2
    exit 1
fi

NODE_BIN="$(command -v node)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"
DB_PATH="${SGC_CHAT_DB:-$DATA_DIR/chat.sqlite}"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

echo "==> node: $NODE_BIN ($("$NODE_BIN" --version))"
echo "==> install dir: $SCRIPT_DIR"
echo "==> data dir: $DATA_DIR"

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "==> stopping existing $SERVICE_NAME service"
    systemctl stop "$SERVICE_NAME"
fi

if ! id -u "$APP_USER" >/dev/null 2>&1; then
    echo "==> creating system user $APP_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi

echo "==> installing dependencies (npm install --omit=dev)"
# Runs as root so node_modules is owned by root and read-only to the service
# user -- better-sqlite3's native build needs a C toolchain (build-essential
# / gcc, make, python3) present on this host.
(cd "$SCRIPT_DIR" && npm install --omit=dev)

mkdir -p "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

echo "==> writing $UNIT_PATH"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=SGC Chat backend (DOLL-OS/DS)
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$SCRIPT_DIR
Environment=PORT=$PORT
Environment=SGC_CHAT_DB=$DB_PATH
ExecStart=$NODE_BIN $SCRIPT_DIR/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

echo "==> done"
systemctl --no-pager status "$SERVICE_NAME"
echo
echo "Listening on 127.0.0.1:$PORT -- reverse-proxy /chat/ to it (see README.md)."
echo "Logs: journalctl -u $SERVICE_NAME -f"
