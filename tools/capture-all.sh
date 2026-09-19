#!/usr/bin/env bash
# Dev helper: screenshot every route at desktop / tablet / mobile widths
# and report JavaScript errors from each page.
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

# route-name hash width height
ROUTES=(
  "home|/home|1440|1000"
  "search|/search?q=neon|1440|1000"
  "library|/library|1440|900"
  "playlist|/playlist/demo-pl-1|1440|1000"
  "sources|/sources|1440|1300"
  "settings|/settings|1440|1400"
  "liked|/collection/liked|1440|900"
  "mood|/mood/focus|1440|900"
  "home-mobile|/home|390|844"
  "playlist-mobile|/playlist/demo-pl-1|390|844"
  "sources-mobile|/sources|390|1000"
  "library-tablet|/library|834|1112"
  "home-tablet-wide|/home|1024|768"
)

for entry in "${ROUTES[@]}"; do
  IFS='|' read -r name hash w h <<< "$entry"
  url="http://127.0.0.1:$PORT/index.html?demo=1#$hash"
  chrome --headless --no-sandbox --disable-gpu --hide-scrollbars --no-proxy-server \
    --force-device-scale-factor=1 --window-size="${w},${h}" --virtual-time-budget=5000 \
    --screenshot="$OUT/${name}.png" "$url" 2>/dev/null >/dev/null
  errs=$(chrome --headless --no-sandbox --disable-gpu --no-proxy-server --virtual-time-budget=5000 \
    --dump-dom "$url" 2>/dev/null | grep -o '<pre id="__diag"[^>]*>[^<]*' | sed 's/.*>//')
  printf '%-22s %sx%-6s %s\n' "$name" "$w" "$h" "${errs:-ok}"
done
