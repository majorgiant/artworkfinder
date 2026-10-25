FROM node:22-alpine

WORKDIR /app
COPY package.json server.js providers.js images.js ./
COPY public ./public

# API keys entered in the app are saved here; mount a volume to keep them.
ENV PORT=4321 CONFIG_FILE=/data/config.json NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4321/api/config || exit 1
CMD ["node", "server.js"]
