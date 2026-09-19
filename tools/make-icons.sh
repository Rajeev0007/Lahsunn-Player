#!/usr/bin/env bash
# Renders PNG app icons and the social share image from the SVG logos.
# PNG is required because PWA manifest icons and og:image are poorly
# supported as SVG by app launchers and link scrapers.
#
#   ./tools/make-icons.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4197}"
IMG="$ROOT/assets/img"

cd "$ROOT"
python3 -m http.server "$PORT" --bind 127.0.0.1 > /tmp/icons-httpd.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -f "$ROOT/_icon-tmp.html" "$ROOT/_og-tmp.html"' EXIT
for _ in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/assets/img/logo-icon.svg" && break; sleep 0.2; done

render_icon() {
  local size="$1" out="$2"
  cat > "$ROOT/_icon-tmp.html" <<EOF
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent}
  img{display:block;width:${size}px;height:${size}px}
</style></head><body><img src="/assets/img/logo-icon.svg"></body></html>
EOF
  chrome --headless --no-sandbox --disable-gpu --no-proxy-server --hide-scrollbars \
    --default-background-color=00000000 --force-device-scale-factor=1 \
    --window-size="${size},${size}" --virtual-time-budget=3000 \
    --screenshot="$IMG/$out" "http://127.0.0.1:$PORT/_icon-tmp.html" 2>/dev/null >/dev/null
  echo "  $out (${size}x${size})"
}

echo "Icons:"
render_icon 192 icon-192.png
render_icon 512 icon-512.png
render_icon 180 apple-touch-icon.png
render_icon 32  favicon-32.png

# Social share card
cat > "$ROOT/_og-tmp.html" <<'EOF'
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:1200px;height:630px;overflow:hidden}
  body{
    background:
      radial-gradient(90% 120% at 12% 0%, rgba(168,85,247,.42), transparent 58%),
      radial-gradient(70% 100% at 100% 20%, rgba(34,211,238,.20), transparent 55%),
      linear-gradient(180deg,#0b0b13,#07070c);
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;
    font-family:'Plus Jakarta Sans','Segoe UI',system-ui,sans-serif;color:#f4f4f8;
  }
  img{width:440px;display:block}
  p{margin:0;font-size:31px;color:#b6b7c6;letter-spacing:-.01em;text-align:center;max-width:900px}
  .chips{display:flex;gap:14px;margin-top:6px}
  .chip{font-size:20px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
    padding:10px 20px;border-radius:999px;border:1px solid rgba(255,255,255,.16);
    background:rgba(255,255,255,.05);color:#ddd6fe}
</style></head><body>
  <img src="/assets/img/logo-full.svg">
  <p>Stream any song from YouTube, Spotify and Audius — no downloads, no account</p>
  <div class="chips"><span class="chip">YouTube</span><span class="chip">Spotify</span><span class="chip">Audius</span></div>
</body></html>
EOF
chrome --headless --no-sandbox --disable-gpu --no-proxy-server --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1200,630 --virtual-time-budget=4000 \
  --screenshot="$IMG/og-image.png" "http://127.0.0.1:$PORT/_og-tmp.html" 2>/dev/null >/dev/null
echo "Share card:"
echo "  og-image.png (1200x630)"

ls -la "$IMG" | awk '{print "  "$5"\t"$9}' | grep -E "png|svg"
