# Convenience targets for the ethereum-testnet harness.
#
# `deploy-gateway` runs the Foundry deploy script (Deploy.s.sol) against
# the running Geth devnet, writes deployments/devnet.json at the repo root,
# and exercises a `cast call` smoke check.
#
# Two flavors:
#   make deploy-gateway          → runs locally (forge + cast on the host).
#   make deploy-gateway-docker   → runs the deployer container against the
#                                  running compose stack (no host forge
#                                  required).

CONFIG_DIR := config
COMPOSE_BASE := $(CONFIG_DIR)/docker-compose.yaml
COMPOSE_DEPLOYER := $(CONFIG_DIR)/docker-compose.deployer.yaml

.PHONY: up down deploy-gateway deploy-gateway-docker smoke-deposit

up:
	cd $(CONFIG_DIR) && docker compose up -d

down:
	cd $(CONFIG_DIR) && docker compose down -v

deploy-gateway:
	./scripts/deploy-gateway.sh

deploy-gateway-docker:
	cd $(CONFIG_DIR) && docker compose \
	    -f $(notdir $(COMPOSE_BASE)) \
	    -f $(notdir $(COMPOSE_DEPLOYER)) \
	    up --abort-on-container-exit gateway-deployer

# `cast send` smoke deposit: pulls deployment JSON, signs as the agent EOA,
# calls gateway.deposit() with a tiny amount.
smoke-deposit:
	./scripts/smoke-deposit.sh
