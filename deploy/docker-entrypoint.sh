#!/bin/sh
# Make sure the vault folder is writable by the unprivileged "node" user,
# then drop root privileges and start Octavo.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /vault
  if ! setpriv --reuid=node --regid=node --init-groups test -w /vault; then
    echo "[octavo] Making /vault writable for the app user (one-time)..."
    chown -R node:node /vault
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
