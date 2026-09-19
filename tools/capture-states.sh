#!/usr/bin/env bash
# Dev helper: screenshot interactive states via tools/preview.html
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT_DIR:-/projects/sandbox/.kiro/artifacts/screenshots}"
PORT="${PORT:-4173}"

mkdir -p "$OUT"
cd "$ROOT"
python3 -m http.server "$PORT" --bind 127.0.0.1 > /tmp/httpd.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
for _ in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html" && break; sleep 0.2; done

# name|action|route|width|height
STATES=(
  "state-playing|play|/playlist/demo-pl-1|1440|900"
  "state-queue|queue|/playlist/demo-pl-1|1440|900"
  "state-nowplaying|np|/home|1440|900"
  "state-nowplaying-mobile|np|/home|390|844"
  "state-modal|modal|/library|1440|900"
  "state-shortcuts|shortcuts|/home|1440|900"
  "state-light|light|/home|1440|900"
  "state-spotify-setup|spotify|/sources|1440|900"
  "state-menu|menu|/playlist/demo-pl-1|1440|900"
  "state-playing-mobile|play|/playlist/demo-pl-1|390|844"
)

for entry in "${STATES[@]}"; do
  IFS='|' read -r name action route w h <<< "$entry"
  url="http://127.0.0.1:$PORT/tools/preview.html?do=${action}&route=${route}"
  chrome --headless --no-sandbox --disable-gpu --hide-scrollbars --no-proxy-server \
    --autoplay-policy=no-user-gesture-required \
    --force-device-scale-factor=1 --window-size="${w},${h}" --virtual-time-budget=6000 \
    --screenshot="$OUT/${name}.png" "$url" 2>/dev/null >/dev/null
  printf '%-28s %sx%s\n' "$name" "$w" "$h"
done
