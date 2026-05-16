# Root Makefile — stable, environment-neutral project commands.
#
# Local machine convenience targets (tunnel ingress, etc.) belong in
# Makefile.local (gitignored).  See Makefile.local.example for a template.

.PHONY: help teardown-zombies testnet

##
## Project targets
##

help: ## Print this help message
	@grep -E '^[a-zA-Z_-]+:.*## .*$$' $(MAKEFILE_LIST) | \
	    awk 'BEGIN {FS = ":.*## "}; {printf "  %-24s %s\n", $$1, $$2}'

teardown-zombies: ## Force-remove orphaned smoke-test containers
	@ids=$$(docker ps -aq \
		--filter 'name=^dapp-frontend$$' \
		--filter 'name=^dapp-explorer-api$$' \
		--filter 'name=^dapp-explorer-indexer$$' \
		--filter 'name=^dapp-postgres$$' \
		--filter 'name=^eth-execution$$' \
		--filter 'name=^eth-beacon$$' \
		--filter 'name=^eth-validator-1$$' \
		--filter 'name=^eth-validator-2$$' \
		--filter 'name=^eth-validator-3$$' \
		--filter 'name=^rmoney-gateway-deployer$$'); \
	if [ -z "$$ids" ]; then \
		echo "no zombie containers"; \
	else \
		docker rm -f $$ids; \
	fi

testnet: teardown-zombies ## Boot the full-stack devnet (local ports only, no public URLs)
	cargo run -p smoke-test -- \
		--full-stack \
		--dapp-port 5173 \
		--rpc-port 18545 \
		--explorer-port 18546

# Include per-machine overrides if present (gitignored).
-include Makefile.local
