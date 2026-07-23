# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
USER node
# ENTRYPOINT/CMD split rather than a single ENTRYPOINT: the CMD default
# reproduces the daemon exactly (existing deploys are unaffected), while
# `docker compose run <svc> dist/scan-now.js` can override the script.
ENTRYPOINT ["node"]
CMD ["dist/index.js"]
