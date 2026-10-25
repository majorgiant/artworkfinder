FROM node:22-alpine

# su-exec lets the startup script drop from root to the app user.
RUN apk add --no-cache su-exec

WORKDIR /app
COPY package.json server.js providers.js images.js ./
COPY public ./public
COPY start.sh /usr/local/bin/artworkfinder-start
RUN chmod +x /usr/local/bin/artworkfinder-start

# API keys entered in the app are saved here; mount a volume to keep them.
# PUID/PGID: the user and group the app runs as and that owns /data (set them to match your
# NAS or host user if needed). The startup script fixes /data's ownership, then drops to them.
ENV PORT=4321 CONFIG_FILE=/data/config.json NODE_ENV=production PUID=1000 PGID=1000
RUN mkdir -p /data && chown node:node /data
VOLUME /data

EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4321/api/config || exit 1
ENTRYPOINT ["artworkfinder-start"]
CMD ["node", "server.js"]
