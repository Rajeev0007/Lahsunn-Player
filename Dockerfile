# Lahsunn Player — full stack (UI + API + yt-dlp). Made by Rajeev.
#
# The player needs a long-lived process that can spawn yt-dlp and stream audio,
# so it must run as a container/VM rather than on a serverless platform.

# ---------- build the UI ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine

# ffmpeg is optional (used to remux), python3 is required by the yt-dlp zipapp.
# The plain `yt-dlp` release is a Python zipapp and works on musl/Alpine;
# `yt-dlp_linux` is glibc-only and would not run here.
RUN apk add --no-cache ffmpeg python3 ca-certificates curl \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && apk del curl \
 && yt-dlp --version

WORKDIR /app

# The server imports only Node built-ins, so no node_modules are needed at
# runtime. package.json is still required for its "type": "module".
COPY package.json ./
COPY server ./server
COPY --from=build /app/client/www ./client/www

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
