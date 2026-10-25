#!/bin/sh
# Container startup. Docker on Linux creates a missing ./data folder owned by root, which the app
# can't write to. So when started as root: give /data to the app user (PUID/PGID, default 1000),
# then run the app as that user. Started with --user already? Then just run it.
set -e

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  mkdir -p /data
  if [ "$(stat -c '%u:%g' /data)" != "$PUID:$PGID" ] || [ -n "$(find /data ! -user "$PUID" -print -quit 2>/dev/null)" ]; then
    echo "Making /data writable for user $PUID:$PGID"
    # Some shared folders don't allow changing owners; the app then warns if it can't write.
    chown -R "$PUID:$PGID" /data 2>/dev/null || echo "Could not change the owner of /data; continuing"
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
