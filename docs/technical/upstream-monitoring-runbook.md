# Upstream Contract Monitoring — Runbook

> Canonical for: `docs/technical/security-model.md` §5 and §8.
> Implements: issue #686.

This runbook documents the three monitoring processes required by the security model
and the pause-and-review procedure for each alert class.

## Overview

Three CI/cron jobs monitor upstream contract liveness and governance:

| Job | Script | Alert condition |
|-----|--------|-----------------|
| Venue liveness | `scripts/monitor-venue-liveness.sh` | Compound v3 or Aave v3 paused or unresponsive |
| Governance proposals | `scripts/monitor-governance-proposals.sh` | On-chain proposal targeting adapter contracts |
| Circle USDC upgrade | `scripts/monitor-usdc-upgrade.sh` | `Upgraded` or `AdminChanged` event on USDC proxy |

All three jobs run on a nightly schedule (GitHub Actions: `.github/workflows/suite-18-upstream-monitoring.yml`)
and on every push to `main` and `dev`. Each job emits structured JSON to stdout and
exits non-zero when an alert condition is detected.

---

## §1 Venue offline — Compound v3 and Aave v3 {#venue-offline}

### What is monitored

- **Compound v3 (Comet):** `comet.isAbsorbing()` — returns `true` when the
  protocol is in absorption mode (market paused/absorbing underwater positions).
  Also detects RPC timeouts or reverts, which indicate the node cannot reach the contract.
- **Aave v3 Pool:** `pool.paused()` — returns `true` when the pool is paused by
  the emergency guardian or governance.

### Alert trigger

`scripts/monitor-venue-liveness.sh` exits 1 and emits:

```json
{
  "alert": true,
  "venues": {
    "compound_v3": { "status": "paused", "alert": true, ... },
    "aave_v3":     { "status": "live",   "alert": false, ... }
  },
  "runbook": "docs/technical/upstream-monitoring-runbook.md#venue-offline"
}
```

### Pause-and-review procedure

1. **Do not accept new deposits** — notify the on-call operator immediately.
   The relevant adapter: `contracts/adapters/CompoundV3Adapter.sol` or
   `contracts/adapters/AaveV3Adapter.sol`.

2. **Assess the situation** — check the Compound / Aave governance forums and
   Discord for a root cause. Distinguish:
   - Temporary pause (emergency guardian) → likely recovers automatically.
   - Governance-initiated pause pending upgrade → may require adapter changes.
   - Chain-level issue (sequencer outage) → wait for recovery.

3. **If paused for > 1 hour:** invoke the vault pause mechanism (operator
   multisig) to prevent further `deploy()` calls to the affected adapter.

4. **Unpausing:** Only unpause the vault adapter after confirming the venue is
   live (`isAbsorbing()` = false / `paused()` = false) via a fresh on-chain call.

5. **Post-incident:** file an incident report in `docs/incidents/` and update
   this runbook if the procedure needs amendment.

### Relevant files

- `contracts/adapters/CompoundV3Adapter.sol` — Comet address, `IComet` interface
- `contracts/adapters/AaveV3Adapter.sol` — Pool address, `IAavePool` interface
- `docs/technical/security-model.md` §5 (Dead-market pricing without circuit breaker)

---

## §2 Governance proposals affecting adapter contracts {#governance-proposal}

### What is monitored

Compound v3 and Aave v3 are upgradeable by their own governance (see
`docs/technical/security-model.md` §8). A governance proposal that targets the
Comet contract or the Aave Pool/PoolConfigurator could change the interface used
by our adapters.

- **Compound v3 Configurator:** scanned for `ProposalCreated` events.
- **Aave v3 PoolConfigurator:** scanned for `ProposalCreated` events.

The look-back window is configurable via `BLOCKS_TO_SCAN` (default: 302400 ≈ 7 days
on Base at ~2 s/block).

### Alert trigger

`scripts/monitor-governance-proposals.sh` exits 1 and emits:

```json
{
  "alert": true,
  "governance": {
    "compound_v3": { "status": "alert", "alert": true, ... },
    "aave_v3":     { "status": "clear", "alert": false, ... }
  },
  "runbook": "docs/technical/upstream-monitoring-runbook.md#governance-proposal"
}
```

### Pause-and-review procedure

1. **Read the proposal** — fetch the proposal details from the Compound or Aave
   governance forum. Identify which contract functions are targeted.

2. **Assess interface impact** — check whether the proposal changes any function
   signature, storage layout, or behaviour that `CompoundV3Adapter.sol` or
   `AaveV3Adapter.sol` depends on:
   - `supply(address asset, uint256 amount)` / `withdraw(address asset, uint256 amount)` (Compound)
   - `supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)` /
     `withdraw(address asset, uint256 amount, address to)` (Aave)
   - `balanceOf(address)` on the cToken / aToken

3. **No interface change:** close the alert; document the review in `docs/incidents/`.

4. **Interface change incoming:**
   - Freeze new deposits to the affected vault.
   - Draft an adapter upgrade PR with the updated interface.
   - Stage a vault upgrade through the timelock before the governance proposal executes.
   - Test the upgraded adapter against a fork at the post-upgrade block.

5. **Post-incident:** update `docs/technical/security-model.md` §8 if the upstream-trust
   assumption needs revision.

### Relevant files

- `contracts/adapters/CompoundV3Adapter.sol`
- `contracts/adapters/AaveV3Adapter.sol`
- `contracts/interfaces/IComet.sol`
- `contracts/interfaces/IAavePool.sol`
- `docs/technical/security-model.md` §8 (Adapter target contract upgrade)

---

## §3 Circle USDC upgrade proposals {#usdc-upgrade}

### What is monitored

USDC on Base uses a transparent proxy (EIP-1967). Circle (the proxy admin /
implementation owner) can upgrade the implementation or change the admin.

Two event types are monitored on the USDC proxy (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`):

- `Upgraded(address indexed implementation)` — implementation replaced.
- `AdminChanged(address previousAdmin, address newAdmin)` — proxy admin changed.

### Alert trigger

`scripts/monitor-usdc-upgrade.sh` exits 1 and emits:

```json
{
  "alert": true,
  "usdc": {
    "proxy_address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "status": "alert:upgraded",
    "alert": true,
    "event_type": "upgraded"
  },
  "runbook": "docs/technical/upstream-monitoring-runbook.md#usdc-upgrade"
}
```

### Pause-and-review procedure

1. **Freeze all vault operations immediately** — USDC semantics may have changed.
   Fee-on-transfer, rebase, or decimals changes would silently break vault accounting.

2. **Read the upgrade diff** — compare the new implementation bytecode / ABI against
   the previous version. Focus on:
   - `transfer` / `transferFrom` — is there a fee deducted?
   - `balanceOf` — is it still a 1:1 nominal balance (no rebase)?
   - `decimals()` — still 6?

3. **No semantic change:** re-enable vault operations and document the review.

4. **Semantic change (fee-on-transfer, rebase, decimals change):**
   - Keep the vault frozen.
   - Audit all balance-accounting paths in `contracts/` for the new USDC behaviour.
   - Issue a security advisory to depositors.
   - Plan and test a migration or adapter upgrade before re-enabling.

5. **Post-incident:** update `docs/technical/security-model.md` §8 (Token-rebase or
   fee-on-transfer upstream change) with the review outcome.

### Relevant files

- All contracts that hold or account for USDC balances
- `docs/technical/security-model.md` §8 (Token-rebase or fee-on-transfer upstream change)

---

## §4 Automated test coverage {#tests}

Tests for all three monitoring scripts live in:

```
.github/scripts/tests/test_upstream_monitoring.sh
```

Run them locally:

```bash
bash .github/scripts/tests/test_upstream_monitoring.sh
```

Each test uses `MOCK_*` environment variables to simulate alert conditions without
a live RPC. The test suite verifies:

- Each alert condition causes a non-zero exit and `"alert": true` JSON output.
- No-RPC mode produces valid JSON and exits 0 (ambiguous state ≠ alert).
- All three alert JSON payloads include a `runbook` field pointing here.
- This runbook file exists and contains sections matching the test-plan `grep` patterns.
- `docs/technical/security-model.md` cross-links this runbook.

---

## §5 CI wiring {#ci}

CI workflow: `.github/workflows/suite-18-upstream-monitoring.yml`

The workflow runs:

1. **On schedule** (nightly at 03:00 UTC) against the live Base mainnet RPC.
2. **On push** to `main` and `dev` — runs the mock tests only (no live RPC needed).
3. **On `workflow_dispatch`** — for manual operator runs.

The nightly run requires the `BASE_RPC_URL` secret to be set in the repository.
If the secret is absent, the live-check steps are skipped and only the mock tests run.
