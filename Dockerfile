ARG NODE_IMAGE=node:24.13.0-bookworm-slim@sha256:46feb5752989c05b8606e6323fbbc3db667d14ade1c24f5d0d44d9ca9909d607

# An optional named BuildKit context can seed only public, lockfile-verified
# npm tarballs. Without that context this stage is a harmless empty fallback.
FROM scratch AS npm-cache-seed
COPY package.json /cache-seed-marker

# Keep both stages on the verified linux/amd64 image manifest.
FROM --platform=linux/amd64 ${NODE_IMAGE} AS deps

WORKDIR /app
COPY packages/pptxgenjs/ ./packages/pptxgenjs/
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=vk-hackathon-npm-cache,target=/root/.npm \
    --mount=type=bind,from=npm-cache-seed,target=/tmp/npm-cache,ro \
  if [ -d /tmp/npm-cache/_cacache ]; then \
    mkdir -p /root/.npm/_cacache \
    && cp -a /tmp/npm-cache/_cacache/. /root/.npm/_cacache/; \
  fi \
  && npm ci --prefer-offline --install-links=true \
  --fetch-retries=5 \
  --fetch-retry-mintimeout=10000 \
  --fetch-retry-maxtimeout=120000

FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . ./
RUN npm run build \
  && npm prune --omit=dev

FROM --platform=linux/amd64 ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3030 \
  HOSTNAME=0.0.0.0 \
  VK_HACKATHON_LLM_PROVIDER=deterministic \
  VK_HACKATHON_ARTIFACT_ROOT=/app/.data/artifacts \
  TMPDIR=/tmp

# Use an immutable Debian package snapshot and exact renderer/font package versions.
ARG DEBIAN_SNAPSHOT=20260901T000000Z
RUN printf '%s\n' \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main" \
      > /etc/apt/sources.list \
  && rm -f /etc/apt/sources.list.d/debian.sources \
  && apt-get update -o Acquire::Check-Valid-Until=false \
  && apt-get install --no-install-recommends -y \
    ca-certificates \
    fontconfig=2.14.1-4 \
    fonts-dejavu-core=2.37-6 \
    fonts-liberation2=2.1.5-1 \
    libreoffice-impress=4:7.4.7-1+deb12u14 \
    poppler-utils=22.12.0-2+deb12u3 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/.data/artifacts \
  && chown -R node:node /app/.data

WORKDIR /app
COPY --from=builder --chown=node:node /app/ ./
USER node
EXPOSE 3030
CMD ["npm", "run", "start"]