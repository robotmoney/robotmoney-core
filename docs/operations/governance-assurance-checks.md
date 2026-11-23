# Governance assurance checks (deploy time and run time)

Issue 2047. This spec lists every check that proves who can change the live
one-vault fund system, and how the proof is gathered without bulk log reads.
Follow-up implementation issues are derived from the rows marked `deferred`.
It is linked from `contract-release-runbooks.md`.

## Why

On 2026-11-20 the v0.9.0 one-vault upgrade run on Base 8453 failed P3.83 and
P9.83 with `RPC_REFUSED` on eight role-exclusivity checks. The verifier scans
every `RoleGranted`/`RoleRevoked` log since deployment, and
`https://mainnet.base.org` refuses bulk `eth_getLogs`. The owner accepted those
steps. The checks were also not the most relevant ones: they prove role
membership, not what the Safe and the timelock actually did.

## RPC feasibility rules

- **Default RPC is public** (`mainnet.base.org`). It answers `eth_call`,
  `eth_getStorageAt`, `eth_getCode`, `eth_getTransactionByHash` and
  `eth_getTransactionReceipt`. It refuses `eth_getLogs` over wide ranges. Issue
  2046 owns the RPC default. No check here may require a wide log scan.
- **On-chain counters beat log scans.** The fund `AdminFloorAccessControlCounter`
  exposes `adminCount()` (1 on mainnet 2026-11-21, held by the timelock). The
  `ProposerFloorTimelock` exposes `proposerCount()` (1 on mainnet 2026-11-21,
  held by the Safe). `count == 1` plus `hasRole(expected) == true` proves
  exclusivity in two `eth_call`s at any block.
- **Roles without a counter** (timelock CANCELLER/EXECUTOR, fund
  EMERGENCY/GOVERNANCE/REBALANCER/FLOW, receipt DEFAULT_ADMIN) are proven at
  deploy time from the deployment's own receipts, then kept proven at run time
  by a bounded scan of `(pin, head]` only (issue 2044 owns that window).
- **Safe history** comes from the Safe `nonce()` and the recorded transaction
  hashes in the release record, never from a log scan of the Safe.
- **Timelock history** comes from the release record's operation ids and
  `getOperationState(id)` / `isOperationDone(id)` reads.

Cost tiers used below: `calls` = a constant number of `eth_call` reads;
`receipts` = one receipt read per recorded transaction; `window` = bounded
`eth_getLogs` over `(pin, head]` in chunks; `scan` = logs since deployment
(not RPC-feasible on the public default).

## Coverage definitions

- **Safe transactions.** Complete when every Safe nonce in `[0, nonce())` maps
  to a transaction hash in the release record, each receipt shows
  `ExecutionSuccess` or a recorded failure, and no nonce is unaccounted for.
- **Timelock operations.** Complete when every operation id the release record
  scheduled is `Done` or recorded as cancelled, no recorded id is `Waiting` or
  `Ready` past its window, and `(pin, head]` shows no `CallScheduled` id outside
  the record.
- **Role changes.** Complete when each governed role has its holder set proven
  at the pin (deploy receipts or counter), and `(pin, head]` has no
  `RoleGranted` to an unexpected account and no `RoleRevoked` from an expected
  holder.
- **Upgrades.** Complete when every proxy's implementation slot equals the
  manifest, `upgradeTimelock()` is the deployed timelock, and every upgrade
  since the pin is a recorded timelock operation.

## Checks

The `Verifier check` column holds the verifier label text that implements the
row (a verbatim substring of a label in `publish-contracts/src/verify/`), or
`deferred` when no implementation exists yet. The structural test
`publish-contracts/tests/verify/governance-spec.test.ts` enforces the columns.

| ID | Threat | Timing | Data source | RPC cost | Verifier check |
|----|--------|--------|-------------|----------|----------------|
| GA-SAFE-01 | Safe owners differ from the sheet, so an unknown key can sign | deploy, run | `getOwners()` | calls | safe: owners equal the sheet |
| GA-SAFE-02 | Safe threshold lowered so fewer keys can sign | deploy, run | `getThreshold()` | calls | safe: threshold equals the sheet |
| GA-SAFE-03 | A Safe module bypasses owner signatures | deploy, run | `getModulesPaginated()` | calls | safe: modules equal sheet (default none) |
| GA-SAFE-04 | A Safe guard blocks or reroutes transactions | deploy, run | `getStorageAt(guard slot)` | calls | safe: guard equals sheet (default zero) |
| GA-SAFE-05 | A malicious fallback handler answers signature checks | deploy, run | `getStorageAt(fallback slot)` | calls | safe: fallback handler equals expected |
| GA-SAFE-06 | An unrecorded Safe transaction ran (nonce gap) | run | `nonce()` versus release record tx hashes | receipts | deferred |
| GA-TL-01 | Timelock delay shortened so changes land before review | deploy, run | `getMinDelay()` | calls | timelock: getMinDelay() equals the sheet |
| GA-TL-02 | A proposer other than the Safe can schedule | deploy, run | `proposerCount()` + `hasRole(PROPOSER, safe)` | calls | timelock: PROPOSER_ROLE held exclusively by the Safe |
| GA-TL-03 | A canceller other than the Safe can cancel governance | deploy, run | deploy receipts, then `(pin, head]` window | window | timelock: CANCELLER_ROLE held exclusively by the Safe |
| GA-TL-04 | An executor other than the Safe can execute | deploy, run | deploy receipts, then `(pin, head]` window | window | timelock: EXECUTOR_ROLE held exclusively by the Safe |
| GA-TL-05 | The deployer kept timelock admin | deploy | `hasRole(DEFAULT_ADMIN, deployer)` | calls | timelock: DEFAULT_ADMIN not held by the deployer |
| GA-TL-06 | A scheduled operation is not in the release record | run | record op ids + `getOperationState`, `CallScheduled` over `(pin, head]` | window | deferred |
| GA-ROLE-01 | Fund ADMIN held by someone besides the timelock | deploy, run | `adminCount()` + `hasRole(ADMIN, timelock)` | calls | : ADMIN_ROLE held exclusively by the timelock |
| GA-ROLE-02 | Emergency key replaced or duplicated | deploy, run | deploy receipts, then `(pin, head]` window | window | : EMERGENCY_ROLE held exclusively by the emergency key |
| GA-ROLE-03 | GOVERNANCE_ROLE granted outside governance | deploy, run | deploy receipts, then `(pin, head]` window | window | fund: GOVERNANCE_ROLE held exclusively by governance |
| GA-ROLE-04 | REBALANCER_ROLE granted outside the rebalancer | deploy, run | deploy receipts, then `(pin, head]` window | window | fund: REBALANCER_ROLE held exclusively by the rebalancer |
| GA-ROLE-05 | FLOW_ROLE granted outside the queue | deploy, run | deploy receipts, then `(pin, head]` window | window | fund: FLOW_ROLE held exclusively by the queue |
| GA-ROLE-06 | Receipt DEFAULT_ADMIN held outside the timelock | deploy, run | deploy receipts, then `(pin, head]` window | window | receipt: DEFAULT_ADMIN held exclusively by the timelock |
| GA-ROLE-07 | The deployer kept any role after the handover | deploy | `hasRole(role, deployer)` per role | calls | : ADMIN_ROLE not held by the deployer |
| GA-UPG-01 | A proxy points at an implementation outside the manifest | deploy, run | `getStorageAt(ERC-1967 impl slot)` | calls | implementation slot equals the manifest |
| GA-UPG-02 | A proxy authorises upgrades from another timelock | deploy, run | `upgradeTimelock()` | calls | upgradeTimelock() is the fund-system timelock |
| GA-UPG-03 | Freeze state disagrees with the release mode | deploy, run | `upgradesFrozen()` | calls | upgradesFrozen() agrees with the sheet's release mode |
| GA-UPG-04 | An upgrade landed that no recorded timelock op explains | run | impl slot at pin versus head + record op ids | calls | deferred |

## Follow-up

Each `deferred` row (GA-SAFE-06, GA-TL-06, GA-UPG-04) becomes one
implementation issue. Rows with cost `window` depend on issue 2044.
