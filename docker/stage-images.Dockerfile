# Stage stack images (core issue 1549): the chain and the deploy job run in containers.
#
# Canonical: docs/development/smoke-test-design.md (Stage stack in containers),
# docs/development/stage-deployment.md, scripts/devnet/README-twin-fork.md.
# Used by: testing/ethereum-testnet/config/docker-compose.stage-chain.yaml
#
# TWO runtime targets, no default target (an unnamed `docker build` would stop at the last stage):
#
#   twin-chain     The Twin chain (chain id 918453): the pinned lazy anvil fork of real Base state, run in the
#                  foreground by `scripts/devnet/twin-fork.ts serve`. Foundry's own image (anvil) plus the bun
#                  binary the tool needs.
#   stage-harness  The deploy job: `smoke-test --deploy-only`, built from this ref with `cargo build --locked`,
#                  plus forge, cast, git and the publish-contracts dependencies from the committed bun.lock
#                  (`bun install --frozen-lockfile`). It runs against a bind-mounted checkout of the SAME ref
#                  (the publish run refuses a checkout that is not the DEPLOY_SHA or has uncommitted changes).
#
# Reproducible: every base image is pinned by digest (the tag only says what the digest was when pinned), the
# Rust build is `--locked` against the committed Cargo.lock, and the bun install is `--frozen-lockfile` against
# the committed publish-contracts/bun.lock. scripts/ci/check-stage-containers.ts fails CI on a FROM without a
# digest. No Docker socket is mounted into either container and neither image carries a docker CLI.
#
# Build context is the repo root. This file has its own ignore list (stage-images.Dockerfile.dockerignore).

FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS bun
FROM ghcr.io/foundry-rs/foundry:v1.8.3@sha256:2e4287278639262de76db72477301d5d3212fa1b1cce710d7d148750a46ce9e7 AS foundry

# --- twin-chain ----------------------------------------------------------------------------------------------
FROM foundry AS twin-chain
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/twin
COPY scripts/devnet/twin-fork.ts scripts/devnet/twin-fork-lib.ts ./scripts/devnet/
# /state holds the tool's pid file, anvil's log and the pin file. /cache is HOME for anvil (its RPC cache).
# Both are owned by the unprivileged user so a fresh named volume mounted on them is writable.
USER root
RUN mkdir -p /state /cache && chown -R 10001:10001 /state /cache
USER 10001:10001
ENV HOME=/cache
EXPOSE 8545
ENTRYPOINT ["bun", "scripts/devnet/twin-fork.ts", "serve"]

# --- stage-harness: build the binary -------------------------------------------------------------------------
FROM rust:1-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 AS rust-builder
WORKDIR /build
COPY . .
# The cache mounts only speed up a rebuild on this machine (the registry and the compiled dependencies); the build
# is still --locked, and the binary is copied out of the cache mount because the mount is not part of the image.
RUN --mount=type=cache,target=/build/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release --locked -p smoke-test --bin smoke-test \
    && cp target/release/smoke-test /smoke-test

# --- stage-harness: the publish-contracts dependencies, from the committed lockfile ---------------------------
FROM bun AS publish-deps
WORKDIR /deps
COPY publish-contracts/package.json publish-contracts/bun.lock ./
RUN bun install --frozen-lockfile

# --- stage-harness -------------------------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS stage-harness
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/cast /usr/local/bin/
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# Bun resolves imports by walking up from the importing file, so the mounted checkout finds these at /node_modules
# when its own publish-contracts/node_modules is absent.
COPY --from=publish-deps /deps/node_modules /node_modules
COPY --from=rust-builder /smoke-test /usr/local/bin/smoke-test
ENTRYPOINT ["/usr/local/bin/smoke-test"]
