# syntax=docker/dockerfile:1.7
# Official @omp-ui/host-lite OCI container image (issue #1372).
# Build from the repository root:
#   docker build -f packages/host-lite/Dockerfile -t omp-ui-lite .

# ── Stage 1: Build plain-Node Host Lite bundle + ABI-matched node-pty ─────────
FROM --platform=linux/amd64 node:22-bookworm@sha256:7c400d78797d8cbe3f6bb21d2227b86af4cd24b0014cc9f62ff989cc16de988e AS builder

ARG HOST_LITE_VERSION=0.0.0

WORKDIR /src

# Copy workspace manifests first for deterministic dependency layer caching.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/desktop/package.json packages/desktop/package.json
COPY packages/host-lite/package.json packages/host-lite/package.json

# Lockfile-verified install without Electron binary download, then compile
# node-pty natively against this plain Node 22 Bookworm ABI.
RUN npm ci --ignore-scripts \
 && npm rebuild node-pty

COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/desktop/src packages/desktop/src
COPY packages/desktop/tsconfig*.json packages/desktop/
COPY packages/host-lite packages/host-lite

RUN HOST_LITE_VERSION="${HOST_LITE_VERSION}" npm run build:cli -w @omp-ui/host-lite \
 && npm run bundle -w @omp-ui/host-lite

RUN mkdir -p /opt/omp-ui-lite/node_modules \
 && node -e 'const fs = require("node:fs"); fs.writeFileSync("/opt/omp-ui-lite/package.json", JSON.stringify({ name: "@omp-ui/host-lite", version: process.argv[1], private: true, type: "module" }, null, 2) + "\n");' "${HOST_LITE_VERSION}" \
 && cp packages/host-lite/dist/cli.js /opt/omp-ui-lite/cli.js \
 && cp packages/host-lite/dist/session-bundle.mjs /opt/omp-ui-lite/session-bundle.mjs \
 && cp -R node_modules/node-pty node_modules/ws node_modules/js-yaml node_modules/argparse /opt/omp-ui-lite/node_modules/

RUN node --input-type=module <<'EOF'
import pty from "/opt/omp-ui-lite/node_modules/node-pty/lib/index.js";
const term = pty.spawn("/bin/sh", ["-c", "echo pty-ok"], { cols: 80, rows: 24 });
let out = "";
term.onData((d) => { out += d; });
const { promise, resolve, reject } = Promise.withResolvers();
const timer = setTimeout(() => reject(new Error("node-pty smoke timed out")), 10_000);
term.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0 || !out.includes("pty-ok")) {
    reject(new Error(`node-pty smoke failed (exit=${exitCode}, out=${JSON.stringify(out)})`));
  } else {
    resolve();
  }
});
await promise;
EOF

# ── Stage 2: Fetch and SHA-256-verify pinned runtime CLIs ─────────────────────
FROM --platform=linux/amd64 debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e AS tools

ARG OMP_VERSION=19.2.1
ARG OMP_SHA256=e8b937f9bf023baa147bdd300ad5421af0a6ef8b1f350c47a9a93d5fca94feca
ARG GH_VERSION=2.83.1
ARG GH_SHA256=1c5252d4ce3db07b51c01ff0b909583da6364ff3fdc06d0c2e75e62dc0380a34
ARG UV_VERSION=0.13.10
ARG UV_SHA256=bf65ac1a0af10f92c522d91ac096c7c0a39657647b155577e7836c2cbbb4526c
ARG BUN_VERSION=1.4.5
ARG BUN_SHA256=94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb
ARG DOCKER_CLI_VERSION=29.10.1
ARG DOCKER_CLI_SHA256=061642059fa7f2ed9b2f04a327a951cff4249585cf04b2661c2a6539197c9962

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip tar \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /stage/usr/local/bin /stage/opt/omp-ui-lite/omp/bin /tmp/dl

# omp (pinned binary + manager.json marker)
RUN curl -fsSL "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64" -o /tmp/dl/omp \
 && echo "${OMP_SHA256}  /tmp/dl/omp" | sha256sum -c - \
 && install -m 0755 /tmp/dl/omp /stage/opt/omp-ui-lite/omp/bin/omp \
 && printf '{"manager":"omp-ui","name":"omp-ui"}\n' > /stage/opt/omp-ui-lite/omp/manager.json \
 && rm -f /tmp/dl/omp

# gh CLI
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/dl/gh.tar.gz \
 && echo "${GH_SHA256}  /tmp/dl/gh.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/dl/gh.tar.gz -C /tmp/dl "gh_${GH_VERSION}_linux_amd64/bin/gh" \
 && install -m 0755 "/tmp/dl/gh_${GH_VERSION}_linux_amd64/bin/gh" /stage/usr/local/bin/gh \
 && rm -rf /tmp/dl/gh.tar.gz "/tmp/dl/gh_${GH_VERSION}_linux_amd64"

# uv / uvx
RUN curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/dl/uv.tar.gz \
 && echo "${UV_SHA256}  /tmp/dl/uv.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/dl/uv.tar.gz -C /tmp/dl \
 && install -m 0755 /tmp/dl/uv-x86_64-unknown-linux-gnu/uv /stage/usr/local/bin/uv \
 && install -m 0755 /tmp/dl/uv-x86_64-unknown-linux-gnu/uvx /stage/usr/local/bin/uvx \
 && rm -rf /tmp/dl/uv.tar.gz /tmp/dl/uv-x86_64-unknown-linux-gnu

# bun (direct zip, never curl|bash)
RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/dl/bun.zip \
 && echo "${BUN_SHA256}  /tmp/dl/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/dl/bun.zip -d /tmp/dl \
 && install -m 0755 /tmp/dl/bun-linux-x64/bun /stage/usr/local/bin/bun \
 && rm -rf /tmp/dl/bun.zip /tmp/dl/bun-linux-x64

# docker CLI binary only (no daemon, no socket)
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/dl/docker.tgz \
 && echo "${DOCKER_CLI_SHA256}  /tmp/dl/docker.tgz" | sha256sum -c - \
 && tar -xzf /tmp/dl/docker.tgz -C /tmp/dl docker/docker \
 && install -m 0755 /tmp/dl/docker/docker /stage/usr/local/bin/docker \
 && rm -rf /tmp/dl/docker.tgz /tmp/dl/docker

RUN /stage/opt/omp-ui-lite/omp/bin/omp --version \
 && /stage/usr/local/bin/gh --version \
 && /stage/usr/local/bin/uv --version \
 && /stage/usr/local/bin/bun --version \
 && /stage/usr/local/bin/docker --version

# ── Stage 3: Minimal non-root plain-Node 22 runtime image ─────────────────────
FROM --platform=linux/amd64 node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS runtime

ARG HOST_LITE_VERSION=0.0.0
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="omp-ui Host Lite" \
      org.opencontainers.image.description="Headless fleet member and routines host for omp-ui" \
      org.opencontainers.image.source="https://github.com/LankfordAI/omp-ui" \
      org.opencontainers.image.version="${HOST_LITE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini \
      util-linux \
      tzdata \
      ca-certificates \
      procps \
      git \
      openssh-client \
      curl \
      wget \
      jq \
      ripgrep \
      zip \
      unzip \
      sqlite3 \
      file \
      debianutils \
      python3 \
      python3-pip \
      python3-venv \
      build-essential \
      ffmpeg \
      imagemagick \
 && rm -rf /var/lib/apt/lists/*

COPY --from=tools /stage/usr/local/bin/ /usr/local/bin/
COPY --from=tools /stage/opt/omp-ui-lite/omp /opt/omp-ui-lite/omp
COPY --from=builder /opt/omp-ui-lite /opt/omp-ui-lite

RUN ln -sf /opt/omp-ui-lite/omp/bin/omp /usr/local/bin/omp \
 && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
 && printf '#!/bin/sh\nexec node /opt/omp-ui-lite/cli.js "$@"\n' > /usr/local/bin/omp-ui-lite \
 && chmod 0755 /usr/local/bin/omp-ui-lite \
 && install -d -o node -g node -m 0700 /data \
 && install -d -o node -g node -m 0755 /projects /home/node/.omp /home/node/.omp/natives /home/node/.omp/agent

ENV NODE_ENV=production \
    OMP_UI_LITE_HOME=/data \
    OMP_UI_LITE_BUNDLE=/opt/omp-ui-lite/session-bundle.mjs \
    OMP_UI_OMP_PATH=/opt/omp-ui-lite/omp/bin/omp \
    OMP_UI_LITE_CONTAINER=1 \
    TZ=UTC

USER node
WORKDIR /data
EXPOSE 4677
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["omp-ui-lite", "status"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["omp-ui-lite", "serve"]
