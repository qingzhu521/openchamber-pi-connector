#!/bin/sh
# Build /Applications/OpenChamber (Pi).app — a launcher that starts the
# pi-backed OpenChamber instance (if needed) and then opens OpenChamber.

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/openchamber-with-pi.sh"
APP_NAME="OpenChamber (Pi)"
APP_PATH="/Applications/${APP_NAME}.app"

chmod +x "$LAUNCHER"

osacompile -o "$APP_PATH" -e "do shell script \"'$LAUNCHER' >/dev/null 2>&1 &\""

echo "installed: $APP_PATH"
echo "launch OpenChamber via '$APP_NAME' from Spotlight/Applications to get both backends."
