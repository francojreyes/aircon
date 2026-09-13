#!/usr/bin/env bash
# Interactive flash: pick serial port + room, compile with -DAIRCON_ROOM, upload.
# Does not edit the sketch — room is a compile-time define.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SKETCH="$ROOT/aircon"
FQBN="${AIRCON_FQBN:-esp8266:esp8266:nodemcuv2}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing dependency: $1" >&2
    exit 1
  }
}

need arduino-cli
need fzf
need python3

if [[ ! -f "$SKETCH/aircon.ino" ]]; then
  echo "Sketch not found: $SKETCH/aircon.ino" >&2
  exit 1
fi

# List USB-ish serial ports for fzf (addr + optional label).
port_lines="$(
  arduino-cli board list --format json \
    | python3 -c '
import json, re, sys

data = json.load(sys.stdin)
noise = re.compile(
    r"(Bluetooth|Incoming|debug-console|wlan-debug|DuskySky|Bose|DJIMic|/cu\.-$)",
    re.I,
)
rows = []
for d in data.get("detected_ports") or []:
    port = d.get("port") or {}
    addr = port.get("address") or ""
    if not addr or noise.search(addr):
        continue
    label = port.get("label") or ""
    proto = port.get("protocol_label") or port.get("protocol") or ""
    boards = d.get("matching_boards") or []
    board = boards[0].get("name", "") if boards else ""
    bits = [addr]
    if board:
        bits.append(board)
    elif proto:
        bits.append(proto)
    elif label and label != addr:
        bits.append(label)
    # Prefer USB serial adapters when sorting later
    usb = 0 if "USB" in proto or "usbserial" in addr.lower() or "usbmodem" in addr.lower() else 1
    rows.append((usb, "\t".join(bits)))
rows.sort()
for _, line in rows:
    print(line)
'
)"

if [[ -z "$port_lines" ]]; then
  echo "No serial ports found. Plug in the board and try again." >&2
  exit 1
fi

port_line="$(printf '%s\n' "$port_lines" | fzf --prompt='Device > ' --height=40% --reverse)" || exit 1
port="${port_line%%$'\t'*}"

room="$(printf '%s\n' Livingroom Bedroom Study | fzf --prompt='Room > ' --height=40% --reverse)" || exit 1

echo "FQBN:  $FQBN"
echo "Port:  $port"
echo "Room:  $room"
echo

arduino-cli compile \
  --fqbn "$FQBN" \
  --build-property "compiler.cpp.extra_flags=-DAIRCON_ROOM=${room}" \
  "$SKETCH"

arduino-cli upload \
  -p "$port" \
  --fqbn "$FQBN" \
  "$SKETCH"

echo
echo "Flashed $room -> $port"
