#!/bin/sh
# Launch OpenChamber together with the pi-backed instance, and shut the pi
# instance down when OpenChamber exits — mirroring how OpenChamber manages
# its built-in opencode child process.
#
# The script stays alive as a lightweight watcher after launching; the .app
# wrapper (contrib/install-launcher.sh) runs it in the foreground and hides
# itself from the Dock via LSUIElement.
#
# Env overrides: OCPI_PORT, OCPI_PROFILE, OCPI_LOG, OCPI_APP.

set -u

PI_PORT="${OCPI_PORT:-57124}"
PI_PROFILE="${OCPI_PROFILE:-$HOME/.config/openchamber-pi}"
PI_LOG="${OCPI_LOG:-/tmp/openchamber-pi-instance.log}"
OPENCHAMBER_APP="${OCPI_APP:-OpenChamber}"
APP_PATTERN="/${OPENCHAMBER_APP}.app/Contents/MacOS"

app_running() {
  pgrep -f "$APP_PATTERN" >/dev/null 2>&1
}

if ! curl -sf -m 2 "http://127.0.0.1:${PI_PORT}/health" >/dev/null 2>&1; then
  OPENCHAMBER_DATA_DIR="$PI_PROFILE" nohup openchamber serve --port "$PI_PORT" >"$PI_LOG" 2>&1 &
fi

open -a "$OPENCHAMBER_APP"

observed=0
while true; do
  if app_running; then
    observed=1
  elif [ "$observed" -eq 1 ]; then
    openchamber stop -p "$PI_PORT" >/dev/null 2>&1
    exit 0
  fi
  sleep 5
done
