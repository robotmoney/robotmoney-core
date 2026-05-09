# Minimal multi-stage build for the explorer-api binary.
#
# Canonical: docs/implementation-plan.md §11 — Phase 5.
# Used by: docker-compose.full-stack.yaml (issue #146).

FROM rust:1-bookworm AS builder
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY clients/explorer-api/Cargo.toml ./
# Cargo.lock may not exist for non-workspace library crates; copy if present.
COPY clients/explorer-api/src ./src

RUN cargo build --release --bin explorer-api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/explorer-api /usr/local/bin/explorer-api
ENV EXPLORER_API_BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/explorer-api"]
