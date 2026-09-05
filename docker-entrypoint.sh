#!/bin/sh
set -e

# 📖 Config file location follows FCM_CONFIG_DIR when set (the --config-dir /
# 📖 XDG-style override), otherwise the default dotfile in $HOME is used.
if [ -n "$FCM_CONFIG_DIR" ]; then
  CONFIG_FILE="$FCM_CONFIG_DIR/config.json"
else
  CONFIG_FILE="$HOME/.free-coding-models.json"
fi
LOG_FILE="$HOME/.free-coding-models-daemon.log"
DAEMON_PORT_FILE="$HOME/.free-coding-models-daemon.port"

touch "$CONFIG_FILE" "$LOG_FILE" 2>/dev/null || true
# 📖 Config file holds API keys — keep it 0600 so only the fcm user can read it.
chmod 600 "$CONFIG_FILE" 2>/dev/null || true
chmod 640 "$LOG_FILE" 2>/dev/null || true

# 📖 Issue #119: Detect when the volume was created with files owned by a
# 📖 different UID (e.g. older images running as root, or bind-mounted host
# 📖 dirs with a different owner). We can't auto-chown as the fcm user, so we
# 📖 log a loud warning at startup so users see it BEFORE their first save
# 📖 attempt fails with a confusing "Tool mode save failed" error.
# 📖 Linux: stat -c %u, BSD/macOS: stat -f %u
CURRENT_UID=$(id -u)
for f in "$CONFIG_FILE" "$HOME/.free-coding-models" "$DAEMON_PORT_FILE"; do
  if [ -e "$f" ]; then
    FILE_UID=$(stat -c %u "$f" 2>/dev/null || stat -f %u "$f" 2>/dev/null || echo "")
    if [ -n "$FILE_UID" ] && [ "$FILE_UID" != "$CURRENT_UID" ]; then
      echo "⚠️  WARNING: $f is owned by UID $FILE_UID but FCM runs as UID $CURRENT_UID."
      echo "   Saves will fail with 'Tool mode save failed' (issue #119)."
      echo "   Fix: docker compose down && docker volume rm \$(docker volume ls -q | grep fcm)"
      echo "         docker compose up   # recreates the volume with the right UID"
    fi
  fi
done

node /app/scripts/docker-init.mjs

FCM_HOST="${FCM_HOST:-0.0.0.0}"
FCM_PORT="${FCM_PORT:-19280}"

echo "FCM_HOST: ${FCM_HOST}"
echo "FCM_PORT: ${FCM_PORT}"

echo "${FCM_PORT}" > "${DAEMON_PORT_FILE}"

echo "Starting FCM router daemon..."
# 📖 Use --daemon (foreground) instead of --daemon-bg so the container's
# 📖 lifecycle is tied to the daemon process. If the daemon dies, the
# 📖 container exits and Docker's restart policy can recover it.
# 📖 Node is backgrounded directly, NOT piped through sed: with a pipe,
# 📖 `$!` is the filter's PID, so SIGTERM in cleanup() killed the filter and
# 📖 left the real daemon running, and `wait` returned the filter's exit code.
cd /app
FCM_HOST="${FCM_HOST}" node bin/free-coding-models.js --daemon &
DAEMON_PID=$!
echo "Daemon started with PID ${DAEMON_PID}"

echo "Waiting for daemon to be ready..."
for i in $(seq 1 30); do
  if wget -qO- "http://127.0.0.1:${FCM_PORT}/health" > /dev/null 2>&1; then
    echo "Daemon is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "WARNING: Daemon did not become ready after 30s, continuing anyway..."
  else
    sleep 1
  fi
done

echo "FCM container is running."
echo "  - Daemon: http://127.0.0.1:${FCM_PORT}/health"
echo "  - Web:    http://${FCM_HOST}:${FCM_PORT}/"

cleanup() {
  echo "Received shutdown signal, stopping daemon..."
  kill -TERM "$DAEMON_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
  echo "Daemon stopped."
  exit 0
}

trap cleanup TERM INT

# 📖 Wait directly on the daemon PID — if the daemon crashes, the container
# 📖 exits and Docker's restart policy can recover it cleanly.
# 📖 Temporarily disable errexit so a non-zero daemon exit is captured and
# 📖 logged instead of aborting the script before the final message.
set +e
wait "$DAEMON_PID"
EXIT_CODE=$?
set -e
echo "Daemon exited with code ${EXIT_CODE}"
exit "$EXIT_CODE"