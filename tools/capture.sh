#!/usr/bin/env bash
# Dev helper: render Loru Player in headless Chrome at several viewports
# and report any JavaScript errors picked up by the diagnostics hook.
#
#   ./tools/capture.sh [url-path]
#
# Screenshots land in .kiro/artifacts/screenshots/ relative to the workspace.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT_DIR:-/projects/sandbox/.kiro/artifacts/screenshots}"
PORT="${PORT:-4173}"
PATH_QS="${1:-index.html?demo=1}"

mkdir -p "$OUT"
cd "$ROOT"

python3 -m http.server "$PORT" --bind 127.0.0.1 > /tmp/httpd.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

for _ in $(seq 1 30); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html" && break
  sleep 0.2
done

shot() {
  local name="$1" w="$2" h="$3" extra="${4:-}"
  chrome --headless --no-sandbox --disable-gpu --hide-scrollbars --no-proxy-server \
    --force-device-scale-factor=1 --window-size="${w},${h}" --virtual-time-budget=6000 \
    ${extra} \
    --screenshot="$OUT/${name}.png" \
    "http://127.0.0.1:$PORT/$PATH_QS" 2>/dev/null >/dev/null
  echo "  ${name}.png  (${w}x${h})"
}

echo "Capturing $PATH_QS"
shot desktop 1440 900
shot tablet 834 1112
shot mobile 390 844

echo
echo "JS errors reported by the page:"
chrome --headless --no-sandbox --disable-gpu --no-proxy-server --virtual-time-budget=6000 \
  --dump-dom "http://127.0.0.1:$PORT/$PATH_QS" 2>/dev/null \
  | tr '>' '>\n' \
  | grep -A20 '__diag' \
  | sed -n '1,25p'
