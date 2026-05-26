# Multi-stage build for the human dapp.
#
# Canonical: docs/implementation-plan.md §12 — Phase 6.
# Used by: docker-compose.full-stack.yaml (issue #146).
#
# Build args wire VITE_* env vars at build time (Vite inlines them into
# the static bundle). The runtime stage serves the built dist/ via Bun so
# the same port (5173) is used in dev and in the containerized devnet.

FROM oven/bun:1.3.5 AS builder
WORKDIR /build

ARG VITE_EXPLORER_API_URL=http://localhost:8080
ARG VITE_GATEWAY_ADDRESS=0x0000000000000000000000000000000000000000
ARG VITE_VAULT_ADDRESS=0x0000000000000000000000000000000000000000
ARG VITE_GATEWAY_EXPECTED_CODE_HASH=
ARG VITE_GATEWAY_CODE_HASH_VERIFIED=false
ARG VITE_ENV_CLASS=fork
ARG VITE_BROWSER_KEYGEN=false
ARG VITE_HISTORY_PANE=false
# Optional: only set for hosted-devnet builds. URL the dapp suggests to
# `wallet_addEthereumChain`; never used as a read transport. Empty for
# prod operator builds (mainnet / Base — wallet already has the chain).
ARG VITE_DEVNET_RPC_URL=
# Optional: 32-byte hex private key of the smoke-test USDC holder EOA
# (see testing/smoke-test/src/lib.rs `HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX`).
# Inlined ONLY for testnet/devnet builds; mainnet operator builds leave
# this unset and the dapp's Faucet tab / onboarding seed step fail closed
# (see clients/dapp/src/lib/faucetClient.ts).
ARG VITE_FAUCET_HARNESS_PRIVATE_KEY=
# Issue #320: VaultRegistry and PortfolioRouter addresses for DestinationSelector.
ARG VITE_REGISTRY_ADDRESS=0x0000000000000000000000000000000000000000
ARG VITE_ROUTER_ADDRESS=0x0000000000000000000000000000000000000000
# Issue #364: RouterGovernance address for the Governance tab.
ARG VITE_GOVERNANCE_ADDRESS=0x0000000000000000000000000000000000000000
# Issue #463 / #365: RM token address. Gates the main-page balances panel
# RM row and the Faucet tab 'Get RM tokens' button. Defaults to zero so
# standalone builds without the smoke-test harness hide the RM surfaces.
ARG VITE_RM_TOKEN_ADDRESS=0x0000000000000000000000000000000000000000

ENV VITE_EXPLORER_API_URL=$VITE_EXPLORER_API_URL \
    VITE_GATEWAY_ADDRESS=$VITE_GATEWAY_ADDRESS \
    VITE_VAULT_ADDRESS=$VITE_VAULT_ADDRESS \
    VITE_GATEWAY_EXPECTED_CODE_HASH=$VITE_GATEWAY_EXPECTED_CODE_HASH \
    VITE_GATEWAY_CODE_HASH_VERIFIED=$VITE_GATEWAY_CODE_HASH_VERIFIED \
    VITE_ENV_CLASS=$VITE_ENV_CLASS \
    VITE_BROWSER_KEYGEN=$VITE_BROWSER_KEYGEN \
    VITE_HISTORY_PANE=$VITE_HISTORY_PANE \
    VITE_DEVNET_RPC_URL=$VITE_DEVNET_RPC_URL \
    VITE_FAUCET_HARNESS_PRIVATE_KEY=$VITE_FAUCET_HARNESS_PRIVATE_KEY \
    VITE_REGISTRY_ADDRESS=$VITE_REGISTRY_ADDRESS \
    VITE_ROUTER_ADDRESS=$VITE_ROUTER_ADDRESS \
    VITE_GOVERNANCE_ADDRESS=$VITE_GOVERNANCE_ADDRESS \
    VITE_RM_TOKEN_ADDRESS=$VITE_RM_TOKEN_ADDRESS

COPY clients/dapp/package.json clients/dapp/bun.lock ./
RUN bun install --frozen-lockfile

COPY clients/dapp ./
RUN bun run build

FROM oven/bun:1.3.5
WORKDIR /app
# `vite preview` needs vite + the config's imported plugins resolvable
# at runtime; the simplest hermetic answer is to copy the builder's
# fully-resolved node_modules and run vite from there.
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/vite.config.ts ./vite.config.ts
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/node_modules ./node_modules
# vite.config.ts imports ./src/lib/buildEnvValidation (issue #431). The
# import must resolve when `vite preview` loads the config at runtime,
# even though the validator itself is a no-op for `command === "serve"`.
COPY --from=builder /build/src/lib/buildEnvValidation.ts ./src/lib/buildEnvValidation.ts
EXPOSE 5173
CMD ["bun", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
