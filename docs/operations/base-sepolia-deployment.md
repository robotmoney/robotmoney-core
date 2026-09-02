# Base Sepolia deployment runbook + rehearsal

## Why this exists — the D9 no-man's-land

D9 scoped Project Fusion to "build and prove locally": the pipeline ends
demonstrated against a local fork or the Robot Money Devnet, and Base mainnet is
a separate, deliberately-costed decision (a Safe with hardware-wallet signers,
`ADMIN_ROLE` transfer to a deployed `TimelockController`, an audit pass, a
funded submitter key, registered genesis agents).

Base Sepolia (chain `84532`) sits **between** those two states. It is the
cheapest rehearsal of most of the mainnet list — real network conditions, real
gas and nonce behaviour, real deploy sequencing against a chain nobody can
restart — without the audit or hardware-signer costs.

This document is the **canonical, step-ordered runbook** for that rehearsal. It
names the exact script each step runs and the postcondition that proves the step
worked. Per the repo's runbook-honesty policy, the ceremony steps are **also
executed** by `scripts/base-sepolia-rehearsal/dry-run.sh` against a fresh local
fork (offline, no secret) and by `scripts/base-sepolia-rehearsal/live.sh`
against real Base Sepolia — they are not merely described here.

## Non-goals — what this rehearsal is NOT

The rehearsal deliberately does **not** cover any of the following, so it can
never be mistaken for mainnet readiness:

- **No audit.** This is a deploy-mechanics rehearsal, not a security
  certification. Nothing here overrides the requirement for a full audit pass
  before any mainnet deployment.
- **No Safe / hardware-wallet signers.** The ceremony here uses a funded
  testnet EOA as deployer and, where a Safe would be referenced, a stand-in
  testnet address. The multisig/hardware-signer surface is out of scope.
- **No real funds.** Only testnet ETH and testnet USDC are involved. A Base
  Sepolia deployment never holds or moves real value.
- **No genesis agent registration.** The IC/receipt/submitter registration is
  rehearsed with testnet identities, not the real genesis agent roster.
- **Not a graduation.** The Robot Money Devnet remains Fusion's acceptance
  environment. The devnet is the gate; this rehearsal is the dress rehearsal.

The D9 boundary stays legible: nothing in this runbook re-opens or changes D9.

## Preconditions

Before any ceremony step, the following must be true. The rehearsal scripts
enforce each of these (see "Guard" column); a human operator follows the same
checks in the live path.

| # | Precondition | Guarded by |
|---|--------------|------------|
| P1 | Deployer EOA is funded with testnet ETH (gas) and testnet USDC (seed deposit). The dry-run counterpart is the fork-funding step. | `rehearsal.sh --check-funding` / dry-run funding |
| P2 | `ADMIN_ADDRESS`, `PAUSER_ADDRESS`, `AGENT_ADDRESS`, `SHARE_RECEIVER_ADDRESS` are distinct, non-zero addresses. | `Deploy.s.sol` `_validate` |
| P3 | `USDC_ADDRESS` is the canonical Base Sepolia USDC and has deployed bytecode. | `Deploy.s.sol` `_validate`; record validator |
| P4 | The exact broadcast bytecode of every contract to deploy is within the EIP-170 24,576-byte limit, and no env-default `0` hazard (e.g. `EXECUTION_DELAY`) is live. | `preflight-guards.sh` |
| P5 | A `TimelockController` and a Safe (threshold ≥ 2) exist (or a testnet stand-in), so the role handover has an honest destination. | `DeployTimelock.s.sol` `_validate` |
| P6 | The deployer holds `ADMIN_ROLE`/`DEFAULT_ADMIN_ROLE` on the freshly deployed contracts before the timelock handover. | each deploy script's grant→verify |

## Chain / environment facts

| Fact | Value |
|------|-------|
| Chain id | `84532` |
| Canonical USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle `FiatTokenProxy`) |
| RPC | `https://sepolia.base.org` (public) or a private provider RPC |

> **Adapter address honesty.** `Deploy.s.sol` pins the **Base-mainnet** Aave V3
> Pool / Compound V3 Comet / Morpho Gauntlet addresses as constants. On Base
> Sepolia those exact pools are not deployed, so the adapters register (the
> registration is a no-delegatecall bytecode + codehash pin, not a pool
> interaction) but their yield legs do not resolve against a live pool until a
> Base-Sepolia-compatible adapter set is supplied. The dry-run rehearsal forks
> the **Base mainnet** golden fixture, so the protocol storage resolves there;
> the live Base Sepolia run currently exercises the core ceremony and the
> adapter *registration*, not live pool yield. Tracked separately.

## Ceremony — one-ceremony rule (task 4.10)

The `InvestmentCommitteePolicy` and its accompanying
`ConsensusRecommendationReceipt` contract deploy in **one** ceremony, in **one**
deploy script (`DeployInvestmentCommitteePolicy.s.sol`), and pass through **one**
timelock role-wiring pass. `DeployInvestmentCommitteePolicy.s.sol` already
deploys both contracts together, wires both into the gateway
(`setICPolicy` + `setConsensusReceipt`), and routes the receipt contract's
`ADMIN_ROLE` to `RECEIPT_ADMIN_ADDRESS` (the `TimelockController` in production,
`INV-3`).

> **Sequencing note — IC policy `ADMIN_ROLE` handover (#1319).** `DeployTimelock`
> currently hands elevated roles to the timelock only on the five core
> contracts (Vault, Gateway, Registry, Router, Governance). It does **not** yet
> move the `InvestmentCommitteePolicy`'s `ADMIN_ROLE`/`DEFAULT_ADMIN_ROLE` or
> the receipt contract's roles to the timelock.
>
> This forces the ceremony order this runbook documents: the IC + receipt
> ceremony runs **before** the timelock handover, because
> `DeployInvestmentCommitteePolicy` wires the gateway
> (`setICPolicy` + `setConsensusReceipt`) as its broadcaster and the broadcaster
> only holds gateway `ADMIN_ROLE` until `DeployTimelock` revokes it. Until #1319
> lands the rehearsal asserts, exactly and no more than:
>
> - `INV-3` on the **five core contracts** (timelock holds `ADMIN_ROLE`, deployer
>   holds none — `DeployTimelock`'s own grant→verify→revoke postconditions).
> - The **wiring happened**: gateway `icPolicy()`/`consensusReceipt()` point at
>   the two deployed contracts, and the receipt contract's `ADMIN_ROLE` equals
>   the configured `RECEIPT_ADMIN_ADDRESS` (which must be the timelock once
>   #1319 lands — then and only then is that assertion `INV-3`).
> - The IC policy's `ADMIN_ROLE` holder is **recorded, not asserted** as the
>   timelock: it is set to `ADMIN_ADDRESS` at construction and its handover is
>   exactly #1319's scope.
>
> The live rehearsal gates its full `INV-3` proof on #1319.

## Ceremony steps (in order)

Each step names the exact `forge script` invocation (or script) and the
postcondition check. The order is dependency-ordered: nothing runs before its
inputs exist.

### Step 1 — Preflight guards

**Script:** `scripts/base-sepolia-rehearsal/preflight-guards.sh`

**What.** Against the exact `forge build` artifacts the deploy will broadcast:

1. **EIP-170 size gate** — assert `RwaVault`, `AgentTokenVault`, and every
   contract in the ceremony's runtime set is `<= 24576` bytes before any
   transaction is sent (the `#865` class).
2. **Env-default guard** — reject a ceremony that would deploy
   `RouterGovernance` with `EXECUTION_DELAY`/`QUORUM_THRESHOLD` left at their
   unsafe defaults of `3600`/`1` if the operator intends a real governance
   round-trip, and reject `EXECUTION_DELAY=0` outright (the `#864` revert
   class).

**Postcondition:** every size check passes and no `0`-delay env default is live,
**before** any broadcast. The script exits non-zero otherwise, so the ceremony
cannot proceed on an oversized or mis-defaulted artifact.

### Step 2 — Core stack: vault, adapters, gateway

**Script:**

```bash
forge script contracts/script/Deploy.s.sol \
  --rpc-url "$RPC_URL" \
  --private-key "$DEPLOYER_KEY" \
  --broadcast --slow \
  --chain-id 84532 \
  # env:
  #   ADMIN_ADDRESS PAUSER_ADDRESS AGENT_ADDRESS SHARE_RECEIVER_ADDRESS
  #   USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
  #   DEPLOYMENT_OUT=deployments/84532.json
```

**What.** Deploys `RobotMoneyVault`, the three adapters, and `RobotMoneyGateway`; grants
roles; authorizes the agent; performs the mandatory `1,000` USDC seed deposit;
pins the gateway runtime hash.

**Postcondition (checked by `rehearsal.sh`):**

```bash
cast call "$GATEWAY" "hasRole(bytes32,address)(bool)" \
  "$(cast keccak 'ADMIN_ROLE')" "$ADMIN" --rpc-url "$RPC_URL"   # expect: true
cast call "$GATEWAY" "hasRole(bytes32,address)(bool)" \
  "$(cast keccak 'AGENT_ROLE')" "$AGENT" --rpc-url "$RPC_URL"   # expect: true
cast call "$VAULT" "totalAssets()(uint256)" --rpc-url "$RPC_URL" # expect: >= 999_000_000
```

### Step 3 — Vault registry

**Script:** `forge script contracts/script/DeployVaultRegistry.s.sol` (env:
`VAULT_ADDRESS`, `USDC_ADDRESS`, `ADMIN_ADDRESS`).

**Postcondition:** `listVaults()` reports the vault as `Active`; the registry is
idempotent (re-running does not double-register).

### Step 4 — Portfolio router

**Script:** `forge script contracts/script/DeployPortfolioRouter.s.sol` (env:
`REGISTRY_ADDRESS`, `VAULT_ADDRESS`, `USDC_ADDRESS`).

**Postcondition:** `getWeights()` sums to `10000` bps with `100%` on the vault;
the vault is router-eligible.

### Step 5 — Router governance

**Script:** `forge script contracts/script/DeployRouterGovernance.s.sol` (env:
`ROUTER_ADDRESS`, plus `VOTING_PERIOD`/`EXECUTION_DELAY`/`QUORUM_THRESHOLD`
explicitly, never left to the `EXECUTION_DELAY=0` default).

**Postcondition:** the deployed `RouterGovernance` returns
`executionDelay() >= RouterGovernance.MIN_EXECUTION_DELAY` and
`quorumThreshold() > 0`.

### Step 6 — IC policy + consensus receipt (one ceremony)

**Script:** `forge script contracts/script/DeployInvestmentCommitteePolicy.s.sol`
(env: `ADMIN_ADDRESS`, `GATEWAY_ADDRESS`, `RECEIPT_ADMIN_ADDRESS`).

**What.** One ceremony deploys both `InvestmentCommitteePolicy` and
`ConsensusRecommendationReceipt`, wires both into the gateway, grants the
gateway the IC's `ADMIN_ROLE`, and grants the receipt contract's
`ADMIN_ROLE`/`DEFAULT_ADMIN_ROLE` to `RECEIPT_ADMIN_ADDRESS`. The ceremony must
run while the broadcaster still holds gateway `ADMIN_ROLE` — i.e. **before**
Step 7.

**Postcondition (checked by `rehearsal.sh`):**

```bash
# IC wired; receipt wired; receipt ADMIN_ROLE on the configured address only
cast call "$GATEWAY" "icPolicy()(address)" --rpc-url "$RPC_URL"   # == policy
cast call "$GATEWAY" "consensusReceipt()(address)" --rpc-url "$RPC_URL" # == receipts
cast call "$RECEIPTS" "hasRole(bytes32,address)(bool)" \
  "$(cast keccak 'ADMIN_ROLE')" "$RECEIPT_ADMIN" --rpc-url "$RPC_URL"  # expect: true
```

> `RECEIPT_ADMIN_ADDRESS` is the `TimelockController` once #1319 lands (then
> this assertion is `INV-3`); until then it is an explicitly-configured address
> and the rehearsal asserts the wiring, not the INV-3 target. See the
> sequencing note in the one-ceremony section above.

### Step 7 — Timelock + role handover

**Script:** `forge script contracts/script/DeployTimelock.s.sol` (env:
`VAULT_ADDRESS`, `GATEWAY_ADDRESS`, `REGISTRY_ADDRESS`, `ROUTER_ADDRESS`,
`GOVERNANCE_ADDRESS`, `SAFE_ADDRESS`, `EMERGENCY_ADDRESS`,
`TIMELOCK_MIN_DELAY`).

**What.** Deploys `TimelockController` and, on the five core contracts, moves
`ADMIN_ROLE` (and the Gateway's `DEFAULT_ADMIN_ROLE`) to the timelock,
grant→verify→revoke, so no EOA retains a privileged role. Also moves the vault's
`EMERGENCY_ROLE` to the independent emergency hot key and verifies the Safe.

**Postcondition (checked by `rehearsal.sh`):** for each of the five core
contracts, the timelock holds `ADMIN_ROLE` and the deployer does not; the
gateway's `DEFAULT_ADMIN_ROLE` is the timelock; the vault `EMERGENCY_ROLE` is the
emergency address and not the deployer. (See #1319 for the IC-policy/receipt
extension.)

### Step 8 — Record

**What.** Write the deployment record to `deployments/base-sepolia.json` with
the real, on-chain-verified addresses replacing Anvil defaults, distinguishing
this rehearsal from the devnet record. The record validator
(`.github/scripts/check_base_sepolia_record.py`) asserts the record is
well-formed, that `chain_id` is `84532`, that every address field is present and
`0x`-prefixed, and that no field claims "live"/"mainnet" status.

## Verification of the whole ceremony

The rehearsal scripts assert every step's postconditions and fail loudly (with
the offending `cast` output) if any step produces a state that does not match —
they never silently skip and never report green on a half-deployed stack.

## Related

- Issue #1303 — this rehearsal (runbook + dry-run + live).
- Issue #1319 — `DeployTimelock` extension to hand `ADMIN_ROLE` for the IC
  policy and `ConsensusRecommendationReceipt` to the timelock (`INV-3`).
- `docs/scout/base-testnet-guide.md` — the older Base-testnet adapter e2e guide.
- `docs/operations/manual-admin-actions.md` — the mainnet manual actions this
  rehearsal rehearses.
- `docs/product/20260623-product-proposal-investment-committee-v0.md` §3.3 /
  §2.1 — the one-ceremony rule and the receipt contract.
- Deploy-script hazards `#865` (EIP-170), `#864` (env-default revert), `#880`
  (deploy-sequence race under slow conditions).
