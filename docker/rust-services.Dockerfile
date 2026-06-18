# Single build container for the Rust devnet service binaries.
#
# Canonical: Plan tracking issue #109 §11 — Phase 5.
# Used by: testing/ethereum-testnet/config/docker-compose.dapp.yaml
#
# `indexer` (services/explorer-indexer) and `explorer-api`
# (clients/explorer-api) are both members of the root cargo workspace and share
# a large dependency closure (alloy, tokio, reqwest, rmpc-logging, …). The
# previous per-service Dockerfiles each spun up their own `rust` builder and
# recompiled that closure independently — paying the cost twice and rebuilding
# on every devnet boot. Compiling both binaries in ONE `cargo build` against the
# committed Cargo.lock reuses that work, and both runtime services run the
# single image this produces (with different entrypoints), so the workspace is
# compiled exactly once per source change.
#
# Build context is the repo root (see .dockerignore for what is excluded) so the
# whole workspace resolves; `--bin indexer --bin explorer-api` restricts the
# compile to just those two binaries and their dependency closure.

FROM rust:1-bookworm AS builder
WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY . .
RUN cargo build --release --bin indexer --bin explorer-api

FROM debian:bookworm-slim
# ca-certificates + libssl3: TLS for both binaries' RPC/DB clients.
# curl: used by the explorer-api container healthcheck in docker-compose.dapp.yaml.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/indexer /usr/local/bin/indexer
COPY --from=builder /build/target/release/explorer-api /usr/local/bin/explorer-api

ENV EXPLORER_API_BIND=0.0.0.0:8080
EXPOSE 8080

# No ENTRYPOINT on purpose: each compose service selects its binary via its own
# `entrypoint:` (indexer vs explorer-api). The image carries both.
