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

.PHONY: help teardown-zombies testnet landing-price-fork-test

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
