#!/usr/bin/env bash
# Install (or update) sgc-chat-server as a systemd service.
#
#   git clone <repo> && cd <repo>/sgc-chat-server
#   sudo ./install.sh
#
# Copies the app into INSTALL_DIR (default /opt/sgc-chat) rather than running
# it in place -- a service running as its own unprivileged system user can't
# be relied on to chdir into a clone sitting under someone's home directory
# (traversal is denied there by default), and /opt is the normal place for a
# systemd-managed app to live anyway.
#
# Safe to re-run after a `git pull` -- it stops the service, re-syncs files,
# refreshes node_modules, rewrites the unit file, and starts it back up. The
# data/ directory (the SQLite file) is never touched on re-run.
#
# Override defaults by setting env vars before running, e.g.:
#   PORT=8080 APP_USER=sgcchat INSTALL_DIR=/srv/sgc-chat sudo -E ./install.sh

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-sgc-chat}"
APP_USER="${APP_USER:-sgc-chat}"
PORT="${PORT:-4390}"
INSTALL_DIR="${INSTALL_DIR:-/opt/sgc-chat}"

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

if ! command -v rsync >/dev/null 2>&1; then
    echo "rsync not found -- install it first (e.g. 'apt install rsync'), then re-run this script." >&2
    exit 1
fi

NODE_BIN="$(command -v node)"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$INSTALL_DIR/data"
DB_PATH="${SGC_CHAT_DB:-$DATA_DIR/chat.sqlite}"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

echo "==> node: $NODE_BIN ($("$NODE_BIN" --version))"
echo "==> source (cloned repo): $SOURCE_DIR"
echo "==> install dir: $INSTALL_DIR"
echo "==> data dir: $DATA_DIR"

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "==> stopping existing $SERVICE_NAME service"
    systemctl stop "$SERVICE_NAME"
fi

if ! id -u "$APP_USER" >/dev/null 2>&1; then
    echo "==> creating system user $APP_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi

mkdir -p "$INSTALL_DIR" "$DATA_DIR"

echo "==> syncing app files into $INSTALL_DIR"
# --delete keeps a stale file from a previous version around forever, but the
# excludes protect data/ and node_modules/ (regenerated/persisted separately)
# and .git (not needed at runtime) from ever being touched by it.
rsync -a --delete \
    --exclude data \
    --exclude node_modules \
    --exclude .git \
    "$SOURCE_DIR"/ "$INSTALL_DIR"/

echo "==> installing dependencies (npm install --omit=dev)"
# Runs as root so node_modules is owned by root and read-only to the service
# user -- better-sqlite3's native build needs a C toolchain (build-essential
# / gcc, make, python3) present on this host.
(cd "$INSTALL_DIR" && npm install --omit=dev)

chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"
chmod 755 "$INSTALL_DIR"

echo "==> writing $UNIT_PATH"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=SGC Chat backend (DOLL-OS/DS)
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$INSTALL_DIR
Environment=PORT=$PORT
Environment=SGC_CHAT_DB=$DB_PATH
ExecStart=$NODE_BIN $INSTALL_DIR/server.js
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
echo "Listening on 127.0.0.1:$PORT -- reverse-proxy /dappchat/ to it (see README.md)."
echo "App + data now live at $INSTALL_DIR (not the git clone) -- re-run this script after 'git pull' to sync updates."
echo "Logs: journalctl -u $SERVICE_NAME -f"
