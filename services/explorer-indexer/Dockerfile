# Multi-stage build for the explorer-indexer binary.
#
# Canonical: docs/implementation-plan.md §11 — Phase 5.
# Used by: docker-compose.full-stack.yaml (issue #146).
#
# Build context is the repo root so that the dev-dependency path crate
# `testing/fork-e2e-rust` (referenced from explorer-indexer/Cargo.toml) is
# resolvable. Cargo always resolves dev-deps even with `--bin`, so omitting
# the path crate breaks the resolver graph.

FROM rust:1-bookworm AS builder
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy only the crates required to resolve the explorer-indexer build:
# the crate itself, its embedded migrations, and the path dev-dependency.
COPY services/explorer-indexer ./services/explorer-indexer
COPY testing/fork-e2e-rust ./testing/fork-e2e-rust
COPY testing/test-utils ./testing/test-utils

WORKDIR /build/services/explorer-indexer
RUN cargo build --release --bin indexer

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/services/explorer-indexer/target/release/indexer /usr/local/bin/indexer
ENTRYPOINT ["/usr/local/bin/indexer"]
