# Stage 1: Build
FROM node:24.15.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Stage 2: Production dependencies only
FROM node:24.15.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 3: Runtime
FROM node:24.15.0-alpine
WORKDIR /app

COPY --from=deps /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY package.json ./

# Default output directory
RUN mkdir -p /output
VOLUME ["/output"]

ENV NODE_ENV=production
ENV OUTPUT_DIR=/output

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
