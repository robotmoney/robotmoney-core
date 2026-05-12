# Minimal multi-stage build for the explorer-api binary.
#
# Canonical: docs/implementation-plan.md §11 — Phase 5.
# Used by: docker-compose.full-stack.yaml (issue #146).

FROM rust:1-bookworm AS builder
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Mirror the repo layout under /build so the path dependency
# `../../crates/rmpc-logging` declared in clients/explorer-api/Cargo.toml
# (issue #247 logging facade) resolves at build time. Without this copy
# cargo fails with "failed to read /crates/rmpc-logging/Cargo.toml".
COPY clients/explorer-api ./clients/explorer-api
COPY crates/rmpc-logging ./crates/rmpc-logging

WORKDIR /build/clients/explorer-api
RUN cargo build --release --bin explorer-api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/clients/explorer-api/target/release/explorer-api /usr/local/bin/explorer-api
ENV EXPLORER_API_BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/explorer-api"]
