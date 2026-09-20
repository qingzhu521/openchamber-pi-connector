#!/bin/sh
# Launch OpenChamber together with the pi-backed instance.
#
# Ensures the pi instance (openchamber-pi-connector as agent backend) is
# serving on its configured port, then opens the OpenChamber desktop app.
# Idempotent: if the pi instance already answers /health, it is left alone.
#
# Install: contrib/install-launcher.sh builds an "OpenChamber (Pi).app"
# wrapper in /Applications that runs this script.

set -u

PI_PORT="${OCPI_PORT:-3600}"
PI_PROFILE="${OCPI_PROFILE:-$HOME/.config/openchamber-pi}"
PI_LOG="${OCPI_LOG:-/tmp/openchamber-pi-instance.log}"
OPENCHAMBER_APP="${OCPI_APP:-OpenChamber}"

if ! curl -sf -m 2 "http://127.0.0.1:${PI_PORT}/health" >/dev/null 2>&1; then
  OPENCHAMBER_DATA_DIR="$PI_PROFILE" nohup openchamber serve --port "$PI_PORT" >"$PI_LOG" 2>&1 &
fi

open -a "$OPENCHAMBER_APP"
