# Full-stack containerized devnet runbook

> **Canonical:** `docs/implementation-plan.md` §2 (Phase 1 gateway + vault),
> §11 (Phase 5 explorer), §12 (Phase 6 dapp).
> **Issue:** #146.
>
> One documented command spins up the entire Robot Money stack from a
> checked-in fork-state fixture: Anvil node, Postgres, the explorer
> indexer + API, and the human dapp. **No upstream RPC is contacted at
> runtime.** The fixture is generated offline by
> `scripts/devnet/snapshot-fork.sh` and committed under
> `testing/fixtures/fork-state/`.

## Architecture

The devnet boots in two phases:

- **Phase A — Fixture generation (developer-run, periodic).**
  `scripts/devnet/snapshot-fork.sh` forks an upstream Base RPC, runs
  `forge script Deploy.s.sol`, and dumps Anvil's state to
  `testing/fixtures/fork-state/CURRENT.anvil-state` (plus a sibling
  `CURRENT.json` manifest and `deployments/full-stack.json`). The
  resulting files are committed to the repo (~155 KB).
- **Phase B — Devnet boot (CI + local).** `docker-compose.full-stack.yaml`
  and `deploy/k3d/anvil-fork.yaml` start Anvil with `--load-state` —
  the chain initializes from the checked-in fixture, with no
  `--fork-url`, no `--fork-block-number`, and no upstream RPC.

This means CI is fully hermetic: no `RMPC_FORK_RPC_URL` secret, no
rate-limit risk, no skip gates. The fixture is the single source of
state truth for the devnet.

## Service map

| Service | Image / Build context | Port (host) | Purpose |
|---|---|---|---|
| `anvil-fork` | `ghcr.io/foundry-rs/foundry:latest` | `8545` | Anvil node loaded from the checked-in fork-state fixture. |
| `postgres` | `postgres:16-alpine` | `5432` | Indexer + API database. |
| `explorer-indexer` | build `services/explorer-indexer/Dockerfile` | — | §11 long-running poll loop. Reads gateway/vault from `deployments/full-stack.json`. |
| `explorer-api` | build `clients/explorer-api/Dockerfile` | `8080` | §11 GET-only HTTP API. |
| `dapp` | build `clients/dapp/Dockerfile` | `5173` | §12 Vite-built bundle, served via `vite preview`. |

The previously-required `gateway-deployer` service has been removed:
the fork-state fixture already contains the Phase 1 contracts (the
snapshot script ran the deploy before the dump), and
`deployments/full-stack.json` records their addresses for the indexer.

## Fork-state fixture

### What is checked in

Under `testing/fixtures/fork-state/`:

- `base-<BLOCK>.anvil-state` — the raw `anvil --dump-state` JSON, ready
  to be passed to `anvil --load-state`.
- `base-<BLOCK>.json` — metadata envelope (chain id, fork block,
  captured-at timestamp, upstream RPC source, deployment addresses).
- `CURRENT.anvil-state` — copy of the most recent state file (stable
  filename consumed by `docker-compose.full-stack.yaml`,
  `deploy/k3d/anvil-fork.yaml`, and CI ad-hoc Anvils).
- `CURRENT.json` — copy of the matching metadata file.

Plus `deployments/full-stack.json` at the repo root — written by the
same snapshot run, consumed by the indexer.

Total checked-in size is a few hundred kilobytes.

### Refreshing the fixture

```bash
# Default upstream is https://base-rpc.publicnode.com (no key needed).
bash scripts/devnet/snapshot-fork.sh

# Or override the upstream:
RMPC_FORK_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> \
  bash scripts/devnet/snapshot-fork.sh
```

Or the named convenience wrapper:

```bash
bash scripts/devnet/refresh-fork-fixture.sh
```

The script:

1. Reads `RMPC_FORK_RPC_URL` (defaults to the public Base RPC).
2. Queries the upstream tip and pins 100 blocks behind to avoid reorg.
3. Boots Anvil with `--fork-url` against that block and chain-id 8453.
4. Runs `forge script contracts/script/Deploy.s.sol:Deploy` so the
   deployed contracts (and any storage they touch) become part of
   Anvil's modified state.
5. Warms a small allowlist of well-known upstream addresses (Base
   USDC, etc.) via `anvil_setCode` so their bytecode is captured in
   the dump.
6. Sends `SIGINT` to flush `--dump-state`.
7. Writes the dated state file, the dated metadata file, the
   `CURRENT.*` pointers, and `deployments/full-stack.json`.

`RMPC_FORK_RPC_URL` is consumed **only** by this script — never at
devnet boot, never in CI's runtime.

Refresh cadence: monthly is fine. Bump it whenever the fixture is more
than ~6 months old or when an upstream contract the devnet exercises
changes at a known block.

## One-command bring-up (Compose)

```bash
# 1. Configure environment (POSTGRES_PASSWORD only).
cp .env.example .env

# 2. Boot the stack (first run builds three Rust/JS images; ~3-5 min).
docker compose -f docker-compose.full-stack.yaml up --build
```

Expected sequence:

1. `anvil-fork` loads `testing/fixtures/fork-state/CURRENT.anvil-state`
   and becomes healthy (`cast chain-id` returns 8453).
2. `postgres` becomes healthy.
3. `explorer-indexer` reads gateway+vault from
   `deployments/full-stack.json`, applies migrations, and starts
   ticking.
4. `explorer-api` serves `/health` on `:8080`.
5. `dapp` serves on `:5173` (configured via build-time `VITE_*` args
   to point the browser at `http://localhost:8545` and
   `http://localhost:8080`).

Optional overrides (chain id, indexer tick, dapp env class, wallet
flags) are documented inline in `.env.example`.

## Verifying `rmpc self-check` from outside the compose network

The Anvil RPC is on `127.0.0.1:8545`. Read the gateway address from
the checked-in deployment artifact:

```bash
GATEWAY=$(grep -o '"gateway":[[:space:]]*"0x[0-9a-fA-F]*"' \
            deployments/full-stack.json | grep -o '0x[0-9a-fA-F]*')

RMPC_RPC_URL=http://127.0.0.1:8545 \
RMPC_GATEWAY_ADDRESS="$GATEWAY" \
  cargo run -p rmpc -- self-check
```

`self-check` issues read-only RPCs (chain id, gateway view functions)
and exits non-zero if the gateway is unreachable or misconfigured.

## Verifying explorer event coverage

Once the stack is up, deposit events are indexed within one tick
(`INDEXER_TICK_SECONDS`, default 12s):

```bash
curl -fsS http://127.0.0.1:8080/health

AGENT=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
curl -sf "http://127.0.0.1:8080/v1/agents/$AGENT/deposits" | jq '.'

curl -sf http://127.0.0.1:8080/v1/vault/snapshot/latest | jq '.'
```

After issuing a deposit through `rmpc deposit-once`, the deposit row
appears in `/v1/agents/$AGENT/deposits` within one tick. The API never
signs or writes — see `docs/implementation-plan.md` §11 "Boundaries".

## Connecting the dapp

Browse to `http://localhost:5173`. The bundle was built with:

- `VITE_FORK_RPC_URL=http://localhost:8545`
- `VITE_EXPLORER_API_URL=http://localhost:8080`
- `VITE_USE_MOCK_WALLET=true`

For hosted deployments, override the `VITE_*` build args via `.env` or
`docker compose build --build-arg` so the bundle points at the public
hostnames.

## CI smoke test

`.github/workflows/full-stack-devnet.yml` exercises the compose graph
and the k3d manifests on every PR that touches the relevant paths:

- `compose-validate` runs `docker compose config` and asserts the
  `gateway-deployer` service is **absent** (the fixture supersedes it),
  plus the fork-state fixture + `deployments/full-stack.json` files
  exist and the state file is valid JSON.
- `manifest-validate` renders `deploy/k3d/` with `kubectl kustomize`
  and asserts the gateway-deployer Job is absent, plus every expected
  service/deployment is present.
- `architecture-guard` greps `_devnet-k3d.yml` and the composite
  action for any reappearance of `secrets_check`, `HAVE_FORK_RPC`,
  `secrets.RMPC_FORK_RPC_URL`, or `fork-rpc-url`. Locks the
  no-upstream-RPC architecture.
- `k3d-smoke` (push/dispatch/nightly) boots the live cluster
  end-to-end, submits an `agentDeposit`, asserts the explorer indexes
  the event, runs `k3d-down.sh`, re-runs to assert idempotent
  tear-down, and re-runs `k3d-up.sh` to assert idempotent re-up.

## k3d single-command bring-up

Same services, same host port surface (8545/5432/8080/5173), running
inside a [k3d](https://k3d.io) Kubernetes cluster instead of Compose.
Manifests live under `deploy/k3d/` and are applied through a
kustomization so the bring-up is a single `kubectl apply -k`.

### Prerequisites

- [`docker`](https://docs.docker.com/engine/install/) (image build +
  k3d node runtime).
- [`k3d`](https://k3d.io) v5.7+ (`brew install k3d` or `curl -fsSL
  https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh |
  TAG=v5.7.4 bash`).
- [`kubectl`](https://kubernetes.io/docs/tasks/tools/) (any 1.27+
  release works against the k3d-shipped k3s server).

The fork-state fixture must be present in the repo (it is, by
default). If you have removed it, regenerate with
`bash scripts/devnet/snapshot-fork.sh`.

### Optional environment overrides

| Var | Purpose | Default |
|---|---|---|
| `POSTGRES_PASSWORD` | Postgres password. | `rmoney_dev` |
| `K3D_CLUSTER_NAME` | Override cluster name. | `rm-devnet` |
| `FORK_CHAIN_ID` | Override `--chain-id`. | `8453` |

### Bring up

```bash
bash scripts/devnet/k3d-up.sh
```

Expected sequence:

1. `k3d cluster create` (or reuse) with host ports
   `8545/5432/8080/5173` published through `k3d`'s built-in load
   balancer (`klipper-lb`).
2. `docker build` then `k3d image import` for the three custom images
   (`rm-explorer-indexer`, `rm-explorer-api`, `rm-dapp`).
3. The script creates the `robotmoney` namespace, then imperatively
   creates the `fork-state` ConfigMap (from
   `testing/fixtures/fork-state/CURRENT.anvil-state`), the
   `deployment-artifact` ConfigMap (from `deployments/full-stack.json`),
   and the `postgres-credentials` Secret. Doing this BEFORE step 4
   ensures the `anvil-fork` pod boots once with real state — booting
   against a placeholder and then `kubectl rollout restart`ing produces
   a CrashLoopBackOff race (kubelet exponential backoff +
   `RollingUpdate` with `replicas=1` defaulting to `maxUnavailable=0`)
   that wedges the deployment for several minutes.
4. `kubectl apply -k deploy/k3d/` applies the rest of the services.
   Because the `fork-state` ConfigMap is no longer in the kustomize
   tree (intentionally — see `deploy/k3d/kustomization.yaml`), this
   step does not overwrite the real data uploaded in step 3.
5. `anvil-fork` rolls out with the real fork state on first boot;
   `explorer-indexer` starts ticking; `explorer-api` becomes healthy
   on `:8080`; `dapp` serves on `:5173`.
6. The script polls `http://127.0.0.1:8080/health` and exits 0 on the
   first 200.

### Tear down

```bash
bash scripts/devnet/k3d-down.sh
```

Idempotent: succeeds whether or not the cluster exists.

### CI integration

`.github/workflows/_devnet-k3d.yml` is a reusable workflow (`uses:`)
that any caller can consume to provision the devnet inside a GitHub
Actions runner. It wraps the
`.github/actions/devnet-k3d/action.yml` composite action, which is
the right granularity for callers that need to run their assertions
in the same job as the cluster (reusable workflows run on their own
runner and can't share cluster state with the caller).

Workflows that consume the reusable workflow (issue #146 migration):

- `fork-e2e.yml`
- `demo.yml`
- `opencode-walkthrough.yml`
- `opencode-headless-deposit.yml`
- `opencode-headless-read.yml`
- `dapp.yml` (Playwright path)

None of them pass `secrets:` to the reusable workflow — the cluster
boots from the checked-in fixture and never needs an upstream RPC
secret.

## Troubleshooting

- **Anvil fails to start with "failed to parse json file".** The
  fixture is malformed. Regenerate with
  `bash scripts/devnet/snapshot-fork.sh`. Anvil's `--load-state`
  expects the structured JSON written by `--dump-state`, not the
  hex-blob string returned by the `anvil_dumpState` JSON-RPC.
- **A test calls a Base mainnet contract and gets "0x" code.** Add
  the contract's address to the `WARM_ADDRESSES` allowlist in
  `scripts/devnet/snapshot-fork.sh`, regenerate the fixture, and
  commit. Proxy-pattern contracts may need both the proxy and
  implementation addresses warmed.
- **`explorer-indexer` exits with "deployment artifact missing".**
  The fixture and `deployments/full-stack.json` must be in lockstep.
  Regenerating the fixture rewrites both. Stale repos can be
  resynced with `bash scripts/devnet/snapshot-fork.sh`.
- **Port 8545 / 5432 / 8080 / 5173 already in use.** Stop other
  devnets (`testing/ethereum-testnet/config/docker-compose.yaml` also
  binds 8545) or override `EXPLORER_API_PORT` in `.env`.
- **Dapp cannot reach RPC / API.** The dapp bundle hard-codes the
  `VITE_*` URLs at build time. Rebuild with
  `docker compose build dapp` after changing `.env`.
