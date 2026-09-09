FROM node:22-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src src
RUN npm run build

FROM node:22-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS ui-builder
ARG APP_VERSION=dev
WORKDIR /app/ui
COPY src/ui/package.json src/ui/package-lock.json ./
RUN npm ci
COPY src/ui/ ./
RUN APP_VERSION=$APP_VERSION npm run build

FROM node:22-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS runner
WORKDIR /app
ENV NODE_ENV=production
ARG TARGETARCH=amd64
ARG AWS_CLI_VERSION=2.36.41
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl unzip \
  && AWS_ARCH=$( [ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64 ) \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}-${AWS_CLI_VERSION}.zip" -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip \
  && apt-get purge -y --auto-remove unzip \
  && rm -rf /var/lib/apt/lists/* \
  && aws --version
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist dist
COPY --from=builder /app/src/db/schema.sql dist/db/schema.sql
# Built UI served by the backend at /
COPY --from=ui-builder /app/ui/dist ui-dist
COPY scripts scripts
CMD ["node", "dist/manager/index.js"]
