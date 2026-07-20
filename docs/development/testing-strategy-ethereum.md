# Ethereum Test Stacks Guide

Robot Money runs contract and integration tests against two Ethereum test
stacks: (a) a local Post-Merge PoS devnet (Geth + Lighthouse) that deploys
fresh contracts on an empty chain, and (b) a forked-Base-mainnet harness
(anvil) that exercises the real deployed Base contracts. This guide covers
both.

## Local PoS devnet (Geth + Lighthouse)

This document describes how to build, run, and debug a faithful Post-Merge Ethereum local testnet based on the logic implemented in `testing/ethereum-testnet/config/`.

### Architecture Overview

The testnet is designed for **maximum reliability** in a single-node development environment using a **Self-Initializing Node Pattern**.

#### Core Clients
- **Execution Layer (EL)**: Official Geth (`ethereum/client-go:v1.13.14`)
- **Consensus Layer (CL)**: Official Lighthouse (`sigp/lighthouse:v5.3.0`)
- **Validator Layer**: 4 isolated Official Lighthouse containers.

#### The Init Sequence
Before the chain starts, a single ephemeral service prepares the shared Docker volume (`testnet-data`):

1.  **`setup`**: Runs `generate.sh` to generate the common "source of truth":
    - EL `genesis.json` and CL `genesis.ssz`.
    - 4 unique validator keys organized into indexed folders (`/data/node-keys/1..4/`).
    - The shared `jwtsecret`.

2.  **Runtime Nodes (Geth & Validators)**: 
    Each node type uses its official binary to perform its own disk preparation on first boot:
    - **Geth**: Runs `geth init` if it detects an empty database.
    - **Validators**: Run `lighthouse account validator import` if they detect missing keystores, pulling from their assigned index in `node-keys`.

---

### Conceptual Model: Understanding the Layers

The post-merge Ethereum stack is split into three distinct specialized layers. Understanding their 1:N relationship is key to debugging.

#### 1. Execution Layer (Geth) — "The Engine"
- **Role**: Manages the EVM, smart contracts, account balances, and transaction mempool.
- **Independence**: Cannot produce a block on its own; waits for instructions from the Consensus Layer via the Engine API.

#### 2. Consensus Layer (Beacon Node) — "The Brain"
- **Role**: Handles P2P networking, fork-choice (voting on the "correct" chain), and tracking validator duties.
- **Independence**: Does not understand smart contracts; asks Geth to "validate" the transactions inside a block.

#### 3. Validator Client (Signers) — "The Keys"
- **Role**: A secure signing service. It holds the private keys and asks the Beacon Node: *"Is it my turn? What do I sign?"*
- **Scaling (1:N)**: In production (e.g., Coinbase), a single cluster of Beacon/Execution nodes can host **thousands** of validator keys.

#### Why this Devnet has 4 Validator Containers?
In our `docker-compose.yaml`, we use **1 Geth** and **1 Beacon Node** for efficiency, but **4 Validator Containers** to simulate a distributed network. This allows us to observe how the protocol distributes duties and sync-committee slots across distinct identities without the resource overhead of 4 full nodes.

---

### Directory Layout (Runtime)

All state is persisted in the `testnet-data` Docker volume, organized as follows:

```text
/data (testnet-data volume)
├── geth/                  # Geth database and genesis.json
├── beacon-config/         # CL config.yaml, genesis.ssz, deploy_block.txt
├── node-keys/             # Raw keys indexed 1-4 for the validator nodes
├── validator-1/           # Lighthouse-encrypted wallet for Val 1
├── ...
└── jwtsecret              # shared 32-byte hex secret
```

---

### Configuration (`docker-compose.yaml`)

The entire network is controlled via one command. The configuration ensures:
- **TTD=0**: PoS is active from Block 0.
- **Forced Liveness**: `--staking`, `--subscribe-all-subnets`, and `--always-prepare-payload` are enabled on the Beacon node to support single-node block production.
- **Deneb Support**: Correct fork epochs (Altair, Bellatrix, Capella, Deneb at 0).

#### Key Command
```bash
cd testing/ethereum-testnet/config
docker compose down -v && docker compose up -d --build
```
*Note: The `-v` is critical to ensure a fresh genesis timestamp on every restart.*

---

### Critical Invariants (Debugging)

#### 1. The Syncing Deadlock (Slot 0 Gap)
Lighthouse will **refuse to propose blocks** if it starts and finds itself already behind the "wall clock" (i.e., Slot 0 timestamp is in the past).
- **The Symptom**: `SERVICE_UNAVAILABLE: beacon node is syncing: sync is stalled`.
- **The Fix**: The `generate.sh` script automatically sets the `GENESIS_TIME` to `Now + 30s`. This allows Docker orchestration to finish before the chain technically begins.

#### 2. Validator Isolation
Each validator container **must** have its own data directory. If multiple containers share a single validator directory, they will lock each other out or risk slashing protection errors.
- **The Fix**: Our setup uses `/data/validator-1` through `/data/validator-4`.

#### 3. Geth Sync Status
Lighthouse requires Geth to report as "fully synced" before it will accept its payloads.
- **The Symptom**: `Execution endpoint ... not yet synced`.
- **The Fix**: We use `--txlookuplimit=0` and `--history.transactions=0` in Geth to prevent long background indexing phases that trigger "syncing" status.

---

### Validation Checklist

| Target | Expected Log / Result | Status |
| :--- | :--- | :--- |
| **Beacon** | `INFO Execution enabled from genesis` | ✅ Ready |
| **Validator** | `INFO All validators active slot: X, epoch: 0` | ✅ Proposing |
| **Geth RPC** | `curl ... "method":"eth_blockNumber"` | ✅ > 0 |
| **Block Rate** | New block every 12 seconds | ✅ Stable |

### Troubleshooting Matrix

| Symptom | Root Cause | Fix |
| :--- | :--- | :--- |
| `no beacon client seen` (Geth) | Beacon hasn't sent first instruction yet. | Wait for Genesis Timestamp. |
| `Bad Request` (Duties) | Fork version or config mismatch. | Wipe volumes and rebuild. |
| `InsufficientPeers` (Beacon) | Solo network behavior. | Ignore; normal for devnets. |
| `Waiting for genesis` | Chain hasn't started yet. | Check `date` vs `genesis_time`. |

---

### Roadmap & Future Improvements

- [ ] **Native Artifact Generation**: Replace the dependency on `ethpandaops/ethereum-genesis-generator` by implementing the `genesis.json` and `genesis.ssz` generation logic directly (likely using Geth's genesis utils and Lighthouse's `lcli` or a custom Go/Rust tool). This would allow for a 100% "from scratch" setup without external tool dependencies.

---

## Forked Base mainnet harness (fork-e2e)

The second stack forks **Base mainnet** into a local `anvil` backend and runs
the shipping `rmpc` client against the **real deployed Base contracts**, to
catch ABI/address/RPC-shape drift that the empty-genesis PoS devnet cannot see.
Its durable design is recorded here; the CI goldens-vs-live decision lives in
[ADR-0011](../adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md), and
the run/refresh commands live in
[environments.md](./environments.md) §2 (Fork e2e).

### Design

- **Chain:** Base mainnet (chain id 8453). Tests exercise the real deployed
  Base contracts (vault, adapters, USDC, DEX pools) — the point is to test the
  actually-shipped bytecode, not fresh deployments.
- **Harness driver:** a Rust integration crate, `testing/fork-e2e-rust/`, that
  drives the same `rmpc` command surface that ships to users (no read/write
  path bypasses the CLI). It is a distinct crate from the PoS-devnet harness
  (`testing/ethereum-testnet/e2e-rust/`); the two deliberately do not share a
  `Fixture` type.
- **Backend:** `anvil` as the fork backend — `anvil --fork-url` for a live
  fork, `anvil --load-state` for the checked-in fixture
  (`testing/fixtures/fork-state/`). Chosen because anvil is the single tool
  that offers `eth_impersonate` (whale funding), fork-block pinning, and a
  one-binary backend with no consensus layer to run.
- **Per-test isolation:** fork-restart-per-test — each test boots its own anvil
  child and tears it down at exit (no `evm_snapshot`/`evm_revert`
  orchestration). Each test uses an ephemeral signer (`alloy-signer-local`)
  funded by impersonating a known Base USDC whale.
- **Block pin:** `RMPC_FORK_BLOCK` (decimal block number) pins the fork block;
  when it is unset, the harness uses `eth_blockNumber − N` (latest-minus-N) for
  local runs. Refresh cadence and CI wiring are ADR-0011's domain, not a fixed
  schedule.

### Current reality vs. target (fixture storage)

The anvil backend supports both a live fork and the checked-in `--load-state`
fixture, but the two modes are **not yet interchangeable**. The checked-in
fixture carries contract **bytecode but not the full storage** of the Base
contracts, so the flagship Rust scenarios (`vault_deposit_redeem_smoke`,
`dex_route_smoke`, `abi_address_sanity`) still require a **live**
`RMPC_FORK_RPC_URL` fork today and skip without it
(`testing/fork-e2e-rust/src/lib.rs:150-164`). ADR-0011's offline-goldens
end-state — every merge-gating fork test running against the fixture with no
secret — is the **target**, not something already achieved; reaching it
requires enriching the fixture with the full storage those scenarios read.
