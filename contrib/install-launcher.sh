#!/bin/sh
# Build /Applications/OpenChamber (Pi).app — a launcher that starts the
# pi-backed OpenChamber instance (if needed), opens OpenChamber, watches for
# OpenChamber to quit, and then stops the pi instance.

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/openchamber-with-pi.sh"
APP_NAME="OpenChamber (Pi)"
APP_PATH="/Applications/${APP_NAME}.app"

chmod +x "$LAUNCHER"

# The applet runs the watcher in the foreground so it stays alive until
# OpenChamber exits; LSUIElement keeps the watcher out of the Dock.
osacompile -o "$APP_PATH" -e "do shell script \"'$LAUNCHER'\""
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$APP_PATH/Contents/Info.plist" 2>/dev/null || true

echo "installed: $APP_PATH"
echo "launch OpenChamber via '$APP_NAME' from Spotlight/Applications to get both backends."
