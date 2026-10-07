FROM node:24.12-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src src
RUN npm run build

FROM node:24.12-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS ui-builder
ARG APP_VERSION=dev
WORKDIR /app/ui
COPY src/ui/package.json src/ui/package-lock.json ./
RUN npm ci
COPY src/ui/ ./
RUN APP_VERSION=$APP_VERSION npm run build

FROM node:24.12-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist dist
COPY --from=builder /app/src/db/schema.sql dist/db/schema.sql
# Built UI served by the backend at /
COPY --from=ui-builder /app/ui/dist ui-dist
COPY scripts scripts
CMD ["node", "--no-warnings", "dist/manager/index.js"]
