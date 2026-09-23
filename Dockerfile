# Self-hosting Loru Player: nginx serving static files. No build stage needed.
#
#   docker build -t loru-player .
#   docker run -p 8080:80 loru-player
#
FROM nginx:1.27-alpine

# Site files
COPY index.html manifest.webmanifest sw.js /usr/share/nginx/html/
COPY src/ /usr/share/nginx/html/src/
COPY assets/ /usr/share/nginx/html/assets/

# Server config (correct MIME types + cache policy)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Runs unprivileged; nginx:alpine already drops to the nginx user for workers
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q --spider http://localhost/index.html || exit 1
