# Root Makefile — stable, environment-neutral project commands.
#
# Cloudflared tunnel ingress (see /etc/cloudflared/config.yml):
#   robotmoney-dev-dapp.superfield.co     -> localhost:5173
#   robotmoney-dev-rpc.superfield.co      -> localhost:18545
#   robotmoney-dev-explorer.superfield.co -> localhost:18546
#
# The three --public-*-url flags are baked into the dapp bundle at build time
# as VITE_* env vars.  Without them the bundle hardcodes localhost, which
# makes every browser fetch fail for any device other than the dev machine.

.PHONY: help teardown-zombies testnet landing-price-fork-test demo-seed-depositors

PUBLIC_DAPP_URL     ?= https://robotmoney-dev-dapp.superfield.co
PUBLIC_RPC_URL      ?= https://robotmoney-dev-rpc.superfield.co
PUBLIC_EXPLORER_URL ?= https://robotmoney-dev-explorer.superfield.co

ZOMBIE_NAMES := \
	dapp-frontend dapp-explorer-api dapp-explorer-indexer dapp-postgres \
	eth-execution eth-beacon eth-validator-1 eth-validator-2 eth-validator-3 \
	rmoney-gateway-deployer

##
## Project targets
##

help: ## Print this help message
	@grep -E '^[a-zA-Z_-]+:.*## .*$$' $(MAKEFILE_LIST) | \
	    awk 'BEGIN {FS = ":.*## "}; {printf "  %-24s %s\n", $$1, $$2}'

teardown-zombies: ## Force-remove orphaned smoke-test containers
	@ids=$$(docker ps -aq $(foreach n,$(ZOMBIE_NAMES),--filter 'name=^$(n)$$')); \
	if [ -z "$$ids" ]; then \
		echo "no zombie containers"; \
	else \
		docker rm -f $$ids; \
	fi

testnet: teardown-zombies ## Boot the full-stack devnet wired to the superfield.co tunnel
	cargo run -p smoke-test -- \
		--full-stack \
		--dapp-port 5173 \
		--rpc-port 18545 \
		--explorer-port 18546 \
		--public-dapp-url     $(PUBLIC_DAPP_URL) \
		--public-rpc-url      $(PUBLIC_RPC_URL) \
		--public-explorer-url $(PUBLIC_EXPLORER_URL)

demo-seed-depositors: ## Seed demo depositors against an already-deployed devnet (issue #503)
	@# Required: RPC_URL, DEPLOYER_KEY, USDC_ADDRESS, ROUTER_ADDRESS.
	@# Optional: REGISTRY_ADDRESS (print totalAssets per vault), COUNT (default 5),
	@#           PER_USER_USDC (whole USDC units, default 1000).
	@#
	@# Example:
	@#   make demo-seed-depositors \
	@#     RPC_URL=https://robotmoney-dev-rpc.superfield.co \
	@#     DEPLOYER_KEY=0x<deployer-private-key> \
	@#     USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
	@#     ROUTER_ADDRESS=0x<router-address> \
	@#     REGISTRY_ADDRESS=0x<registry-address>
	@#
	@# DEPLOYER_KEY must hold enough ETH (0.05 ETH per depositor) and USDC
	@# (PER_USER_USDC * COUNT units) to fund all depositors. On the smoke-test
	@# devnet the genesis-funded DEPLOYER_PRIVATE_KEY_HEX from lib.rs holds
	@# the ETH budget; the harness USDC holder holds the USDC supply — pass
	@# whichever key owns the faucet supply on the target devnet.
	cargo run -p smoke-test --bin demo-seed-depositors --release -- \
		--rpc-url    "$(RPC_URL)" \
		--deployer-key "$(DEPLOYER_KEY)" \
		--usdc       "$(USDC_ADDRESS)" \
		--router     "$(ROUTER_ADDRESS)" \
		$(if $(REGISTRY_ADDRESS),--registry "$(REGISTRY_ADDRESS)",) \
		$(if $(COUNT),--count "$(COUNT)",) \
		$(if $(PER_USER_USDC),--per-user-usdc "$(PER_USER_USDC)",)

landing-price-fork-test: ## Boot forked-Base devnet + run landing price-strip fork integration & Playwright fork tests (issue #482)
	# 1. Fork integration: read each pool slot0 from the forked-Base devnet and
	#    assert converted prices match the pinned expected-prices fixture. The
	#    Rust harness boots Anvil from the checked-in fork-state fixture (or a
	#    live archive RPC via RMPC_FORK_RPC_URL) at the pinned fork block.
	cargo test -p rmpc-fork-e2e --test landing_price_strip_fork -- --nocapture
	# 2. CI guard: fail if the fork block changed without the expected-prices
	#    fixture being refreshed in the same commit.
	cargo test -p smoke-test --lib fork_manifest::tests::fork_block_aligns_with_expected_prices
	# 3. Playwright fork: dapp pointed at the forked-Base devnet (booted by the
	#    Playwright globalSetup), no RPC mocks, asserts the strip against the
	#    same expected-prices fixture.
	cd clients/dapp && bunx playwright test landing-price-strip.spec.ts

# Include per-machine overrides if present (gitignored).
-include Makefile.local
