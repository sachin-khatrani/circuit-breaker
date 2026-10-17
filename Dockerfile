# CIRCUIT BREAKER: one Node process serves the built client, Socket.IO, the race server and the
# ranking API on one port and one origin. Works on any host that runs a Dockerfile (Render,
# Railway, Fly.io). The platform's PORT is honoured. Rooms and races live in memory, so run
# exactly one instance; profiles and ratings live in PostgreSQL (DATABASE_URL, set by the host).

# ---- build: install everything, then type-check and build the client and the server
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
RUN npm ci
COPY . .
RUN npm run build

# ---- run: the server's production dependencies only, plus the two builds
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace @circuit-breaker/server && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/client/dist apps/client/dist
USER node
EXPOSE 3001
CMD ["node", "--enable-source-maps", "apps/server/dist/index.js"]
