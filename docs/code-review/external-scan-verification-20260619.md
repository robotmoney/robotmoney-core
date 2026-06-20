# External Scan Verification — Full-Stack Automated Audit — 2026-06-19

**Scope:** Independent source-level verification of an external automated security
scan of `robotmoney/robotmoney-monorepo` that reported **95 findings (6 High,
61 Medium, 28 Low, 0 Critical)**. Unlike the
[multi-contract lifecycle audit](./external-audit-verification-20260619.md)
(which focused on gateway↔router↔registry↔vault control flow), this scan swept
the **entire stack**: the Rust `explorer-indexer`, the `watchdog` service, the
Solidity contracts (gateway, router, vault, adapters), the `rmpc` Rust payment
client, the `dapp` (React/TypeScript), and the `smoke-test`/`fork-e2e` harness.

**HEAD commit:** `e8712ae37e435f5bb82b7017b5079f735817142c` (branch `dev`).

**Prior audits / companions:**
[`external-audit-verification-20260619.md`](./external-audit-verification-20260619.md),
[`smart-contract-holistic-review-20260618.md`](./smart-contract-holistic-review-20260618.md),
[`smart-contract-vulnerability-audit-20260609.md`](./smart-contract-vulnerability-audit-20260609.md),
[`confused-deputy-access-control-audit-20260602.md`](./confused-deputy-access-control-audit-20260602.md).

**Method:** Every substantive finding was independently re-checked against HEAD
source. For each, the cited file was read at the named symbol (line numbers in the
scan were treated as advisory and re-derived from current source), the actual code
quoted, and the claim graded **CONFIRMED / PARTIAL / MITIGATED / REFUTED**. Each
finding then received an **n-order pass** (cross-finding / second-order effects)
and a **severity re-grade** (UP / DOWN / SAME) against the documented trust model.
Verification was fanned out across seven reviewer passes (indexer+API, watchdog,
router+gateway, vault+adapters, rmpc client, harness, dapp).

---

## Headline verdict

**Most findings reproduce at the code level, but the scan's severity labels are
badly miscalibrated in both directions, and a meaningful slice rests on a stale
code snapshot.** Three corrections dominate:

1. **The four "High access-control" contract findings collapse.** They claim an
   attacker can drain a victim's vault shares through the gateway/router. Verified
   end-to-end against the actual allowance flow and the documented trust model
   ([each depositor is sole authority over her own agent](../technical/security-model.md)),
   they do **not** hold: every share movement on the withdrawal side is a vanilla
   ERC-20 `safeTransferFrom` whose authority is the victim's *own* approval **to the
   gateway**, and `rmpc` only ever grants that approval transiently for the
   victim's own withdrawal. Consent is structurally enforced by the token. The
   genuine residue is one **availability** bug (USDC dust bricks router deposits)
   plus low-grade DoS/nuisance items — not a fund-theft hole.

2. **The single most severe *real* finding was rated only "High" and is arguably
   Critical.** The indexer has a **duplicate `erc4626_withdraw` branch**: the first
   branch `return`s after writing account history, making the *only* writer of
   `vault_transfer_events(direction='withdrawal')` permanently unreachable. The
   watchdog's burn-volume circuit breaker reads exclusively from that table, so
   **the automated burn/redemption alarm can never fire**, regardless of outflow
   pressure. For a fund-drain monitor, blindness to burns is the dangerous
   direction. Re-graded **UP → Critical**.

3. **A cluster of "Medium" contract findings are stale-snapshot artifacts or
   by-design.** Several cite `src/…`/`lib/…` paths (the real layout is
   `contracts/…`), and two **directly contradict each other** (one claims
   `totalAssets()` *excludes* idle USDC, another that it *includes* it — only the
   latter matches HEAD). The adapter "ABI mismatch" cluster (Aerodrome / Uniswap
   V4 / Chronicle) all target the repo's *own* interface shims, which are
   internally consistent; the residual risk is external integration, and those
   vaults are demo-only with audit-gated router eligibility — only
   `RobotMoneyVault` carries a mainnet deployment.

Net posture: consistent with the 2026-06-18 holistic review — **no
unauthenticated EOA fund-drain**. The real, actionable surface is concentrated in
the **off-chain observability/safety services** (indexer + watchdog), a handful of
**client correctness footguns** (`rmpc`, dapp), and a small set of genuine
**contract hardening gaps** (emergency-unwind deposit-pause lock, basket-vault
retire selectors, Morpho-illiquidity redemption revert).

> The severity column records the **scan's original** grade; the **Re-grade**
> column records the verified, composition-aware grade where it differs.

---

## Severity re-grade summary — the corrections that matter

### Upgraded (under-rated by the scan)

| ID | Finding | Scan | Verified | Why |
|----|---------|------|----------|-----|
| IDX-1 | Duplicate `Withdraw` handler ⇒ burn rows never written | High | **Critical** | Watchdog burn alarm is permanently inert; only writer of withdrawal rows is dead code |
| WD-1 | Pause awaited before alert, no RPC timeout, SLA unenforced | Med | **High** | A hung RPC stalls the whole single-threaded cycle: alert never fires *and* next poll never runs |
| WD-6 | Per-block thresholds only check the latest indexed block | Med | **High** | Indexer advances >1 block/tick; a spike in any non-MAX block is never per-block-evaluated (deterministic bypass) |
| RPC-2 | Deposit replay cache written before receipt success | Med | **High (local)** | Reverted/timed-out tx poisons cache with no remove API → legitimate retry permanently refused |
| RPC-5 | Vote proposal-id parsed hex-first despite "decimal" doc | Med | **High** | `"10"`→16, `"100"`→256: silently votes the wrong proposal, no error surfaced |
| RPC-7 | Router withdraw preflight hard-codes allowance/balance = 0 | Med | **High (router leg)** | Preflight reports false success; on-chain revert + wasted gas (single-vault path is mitigated) |
| DAPP-4 | Destination selector does not control direct-deposit target | Med | **High** | Live + unremediated: picking vault B deposits into default vault A → wrong risk class |
| IDX-8 | Reorg rollback does not revert in-place status updates | Med | **Med (strengthened)** | Worse than claimed — the `vaults` table is not in the `delete_above_block` list *at all* |
| VLT-25 | Emergency-unwind deposit-pause cannot be cleared | Low | **Med** | `emergencyUnwind` sets `depositsPaused` but not `Pausable`; `unpause()`→`_unpause()` reverts `whenPaused`, leaving deposits stuck |
| DAPP-5 | `VaultDetail` decodes `shortlist` as structs not parallel arrays | Low | **Med** | Hard ABI decode break — composition view throws for every basket vault |

### Downgraded (over-rated by the scan)

| ID | Finding | Scan | Verified | Why |
|----|---------|------|----------|-----|
| RTR-3 | Router withdrawal "pulls from arbitrary shareReceiver" (×2) | High | **Low / Refuted** | Share pull is a plain ERC-20 `transferFrom` needing the victim's own allowance *to the gateway*; consent is structural. Listed twice. |
| RTR-2 | Router redeemer guard checks unconsumed allowance | High | **Low** | Gateway self-custodies (`msg.sender==shareHolder`), and user→router approvals are explicitly prohibited; confused-deputy is theoretical |
| RTR-4 | Agent authorization needs no consent from agent address | Med | **Low** | Squatter's policy only moves *its own* funds; `_assertRoleSeparation` blocks the squat-to-AGENT_ROLE escalation |
| RTR-1 | Pre-existing USDC balance bricks router deposits | High | **Med** | Real and has no recovery path, but pure griefing DoS — no funds at risk |
| VLT-7 | "Idle assets excluded from `totalAssets()`" | Med | **Refuted (stale)** | HEAD `totalAssets()` sums idle `balanceOf` first; contradicts VLT-8 (which matches HEAD) |
| VLT-2/14/16 | Aerodrome / Chronicle / Uniswap-V4 "ABI mismatch" | Med | **Info/Refuted** | Each targets the repo's own interface shim; internally consistent, not a HEAD code bug |
| VLT-24 | Exit-fee rounding makes `maxWithdraw` unwithdrawable | Med | **Refuted** | `maxWithdraw` was reworked (audit L-1) to floor gross→net; counter-example to the claim |
| HARN-1 | Checked-in devnet faucet private key | Med | **Info/Low** | By-design throwaway genesis key for an ephemeral chain; controls nothing of value |
| HARN-3/4/7/8 | Genesis-alloc / USDC-seed "can be corrupted" | Med | **Low** | All require an attacker who already controls the committed snapshot/seed fixtures |
| RPC-17 | Vault share-price saturates on overflow | Low | **Info** | Overflow needs absurd decimals/supply; effectively unreachable |

---

## Cross-cutting root causes (n-order synthesis)

The scan reports findings as independent items; verification shows they cluster
around a few shared root causes, which is where remediation effort is best spent.

1. **The watchdog's volume accounting is corrupted by upstream indexer bugs, and
   the bias is dangerously asymmetric.** On the **burn** side it is effectively
   non-functional: IDX-1 (duplicate withdraw branch) means withdrawal rows are
   never written, and WD-6 (latest-block-only) + WD-2 (wall-clock hour window)
   would starve it anyway. On the **mint** side it is simultaneously *inflated*
   (IDX-7 double-counts routed deposits as parent + legs → ~2×) and *deflated*
   (IDX-4 omits direct ERC-4626 deposits). The composite: a monitor that may
   **falsely pause** on routed mints yet is **structurally blind to redemptions**.
   This is the highest-leverage area in the entire scan.

2. **"`Ok(None)` is terminal" defeats `rmpc` RPC failover (RPC-3, RPC-4).** The
   single-endpoint client maps both a transient `-32000` indexing error and a
   malformed (missing-`result`) response to `Ok(None)`; the failover wrapper only
   advances on `Err`, so a healthy second endpoint is never tried — multi-endpoint
   redundancy silently does nothing for receipt lookups.

3. **"Envelope block sampled separately from a `latest` read" (RPC-9, RPC-15,
   RPC-16).** Read commands advertise a `block_number` from `eth_blockNumber` but
   resolve data against `"latest"`/unbounded, so the envelope block and the data
   can disagree. Pinning reads to the sampled block tag (the pattern `get-vault`
   already uses) fixes the whole cluster.

4. **"Error coerced to a benign zero/skip with no `partial` flag" (RPC-11, RPC-13,
   RPC-17, and the watchdog SLA path).** RPC failures masquerade as legitimate
   empty/zero/cancelled results, masking real state — each should set the
   envelope's `partial`/`errors` channel instead of fabricating a value.

5. **"Unordered grant/revoke replay" — one bug, two clients (RPC-14 + DAPP-6).**
   Both `rmpc get-timelock` and the dapp `TimelockPanel` reconstruct role
   membership by adding all `RoleGranted` then removing all `RoleRevoked` as set
   arithmetic, ignoring chronology. A grant→revoke→re-grant sequence drops a
   currently-active member. Same fix belongs in both.

6. **Stale-snapshot contamination of the scan itself.** A subset of contract
   findings cite `src/…`/`lib/…` paths and HEAD-contradicting code (VLT-7 vs
   VLT-8; the simplified `MorphoAdapter`/`_pullProportional` in VLT-6/VLT-11).
   These were generated against an older tree and should be discounted.

---

## Verification detail by subsystem

### explorer-indexer + explorer-api (Rust)

| # | Finding | Verdict | Re-grade |
|---|---------|---------|----------|
| IDX-1 | Duplicate `Withdraw` handler ⇒ burn rows never written | ✅ CONFIRMED | **UP → Critical** |
| IDX-2 | Failed run after reorg advances cursor past deleted blocks | ✅ CONFIRMED | SAME (High) |
| IDX-3 | Account positions endpoint never populated (`insert_wallet_position` 0 sites) | ✅ CONFIRMED | SAME (Med) |
| IDX-4 | Direct ERC-4626 deposits excluded from mint-volume | ✅ CONFIRMED | SAME (Med) |
| IDX-5 | Vote tally counts voters (`+1`) not power | ✅ CONFIRMED | SAME (Med) |
| IDX-6 | Registry-discovered vaults not in `watched_addresses` for burns | ✅ CONFIRMED | SAME (Med) |
| IDX-7 | Routed deposits double-counted (parent + legs) in mint-volume | ✅ CONFIRMED | SAME (Med) |
| IDX-8 | Reorg rollback doesn't revert in-place status updates | ✅ CONFIRMED (strengthened: `vaults` not in delete list) | UP within Med |
| IDX-9 | Legacy agent lookup ignores owner scope | ⚠️ PARTIAL / REFUTED as vuln | DOWN |
| IDX-10 | Direct ERC-4626 deposits omitted from per-account history | ✅ CONFIRMED | SAME (Low) |
| IDX-11 | Proposal status never advanced to passed/expired | ✅ CONFIRMED | SAME (Low) |
| IDX-12 | Legacy agent status marks expired policies authorized | ✅ CONFIRMED | SAME (Low) |
| IDX-13 | Policy-change history attributed to agent not owner | ✅ CONFIRMED | SAME (Low) |
| IDX-14 | Routed deposits show share receiver as vault in stats feed | ✅ CONFIRMED | SAME (Low) |
| IDX-15 | Explorer-API chain scoping bypass on several reads | ⚠️ PARTIAL | SAME (Low) |
| IDX-16 | Vault detail history stale after 500-snapshot ascending cap | ✅ CONFIRMED | SAME (Low) |

*Path note: `explorer-api` lives at `clients/explorer-api/`, not `services/…`; many
line numbers drifted but symbols matched.*

### watchdog (Rust)

| # | Finding | Verdict | Re-grade |
|---|---------|---------|----------|
| WD-1 | Pause awaited before alert; no RPC timeout; SLA unenforced | ✅ CONFIRMED | **UP → High** |
| WD-2 | Hourly window uses wall-clock not chain time | ✅ CONFIRMED | SAME (Med) |
| WD-3 | Pause tx RLP encodes r/s as non-minimal fixed 32 bytes | ✅ CONFIRMED | **DOWN → Low** (≈1/256 per scalar; most clients accept) |
| WD-4 | Per-vault thresholds parsed but never enforced (**listed ×2**) | ✅ CONFIRMED (one issue) | SAME (Med) |
| WD-5 | Pause retries use pending nonce; can't replace stuck tx | ✅ CONFIRMED | SAME (Med) |
| WD-6 | Per-block thresholds only inspect latest indexed block (**listed ×2**) | ✅ CONFIRMED (one issue) | **UP → High** |

### PortfolioRouter + RobotMoneyGateway (Solidity)

| # | Finding | Verdict | Re-grade |
|---|---------|---------|----------|
| RTR-1 | Pre-existing USDC dust permanently bricks router deposits | ✅ CONFIRMED | **DOWN → Med** (availability-only) |
| RTR-2 | Redeemer guard checks an allowance it does not consume | ⚠️ PARTIAL / MITIGATED | **DOWN → Low** |
| RTR-3 | Router withdrawal "pulls from arbitrary shareReceiver" (**×2**) | ❌ REFUTED | **DOWN → Low/Info** |
| RTR-4 | Agent authorization needs no consent from agent address | ✅ CONFIRMED (low impact) | **DOWN → Low** |
| RTR-5 | Commit/reveal front-run by precommitted squatter (DoS) | ✅ CONFIRMED | SAME (Med, nuisance) |
| RTR-6 | `depositTo` paymentId omits destination + minSharesPerLeg | ✅ CONFIRMED (benign, self-affecting) | **DOWN → Low** |
| RTR-7 | Empty `allowedSourceVaults` not enforced on router withdrawals | ✅ CONFIRMED | SAME (Med, hardening) |
| RTR-8 | Gateway router withdrawals can't enforce per-leg min assets | ✅ CONFIRMED (by design, L-8) | **DOWN → Low** |
| RTR-9 | Router withdrawal paymentId binds only `totalShares` | ✅ CONFIRMED (benign) | **DOWN → Low** |
| RTR-10 | Rounding remainder lets tiny split deposits bypass weights | ✅ CONFIRMED (cosmetic) | **DOWN → Low** |

*Path note: findings citing `PortfolioRouter.sol` lines >817 actually reference
`RobotMoneyGateway.sol`.*

### RobotMoneyVault + BasketVault/RwaVault + adapters (Solidity)

| # | Finding | Verdict | Re-grade |
|---|---------|---------|----------|
| VLT-1 | `IUpstreamMonitor` health gate not enforced | ✅ CONFIRMED (by design stub) | DOWN → Info |
| VLT-2 | Aerodrome Slipstream `slot0` ABI mismatch | ❌ REFUTED (own shim) | DOWN → Info |
| VLT-3 | Chronicle RWA route vs V3-style `addAsset` checks | ⚠️ PARTIAL (latent integration) | SAME |
| VLT-4 | Compound rewards not harvested / sweepable | ❌ REFUTED (accrue in share price) | DOWN → Info |
| VLT-5 | Deposits mint on max-slippage haircut | ✅ CONFIRMED (by design, H-1) | SAME |
| VLT-6 | Greedy deposit reverts on one unavailable adapter | ❌ REFUTED for HEAD (skips + idles); stale `src/` | DOWN |
| VLT-7 | Idle assets excluded from `totalAssets()` | ❌ REFUTED (stale; HEAD includes idle) | n/a |
| VLT-8 | Idle-first withdrawals (`totalAssets` includes idle) | ✅ CONFIRMED (matches HEAD), benign | DOWN |
| VLT-9 | Inactive asset entries consume basket capacity | ✅ CONFIRMED | SAME (Med, low impact) |
| VLT-10 | Morpho reports illiquid shares as withdrawable | ✅ CONFIRMED | SAME (Med) |
| VLT-11 | Proportional withdraw reverts on one illiquid adapter | ⚠️ PARTIAL (stale dup of VLT-10) | SAME |
| VLT-12 | Registry `Paused` doesn't halt direct deposits | ⚠️ PARTIAL (router gates by design) | DOWN |
| VLT-13 | RWA redemption blocked by price deviation from NAV | ✅ CONFIRMED (by design, ADR-0006) | SAME |
| VLT-14 | RWA freshness uses noncanonical `latestTimestamp()` | ❌ REFUTED (own `IChronicleOracle`) | DOWN → Info |
| VLT-15 | Receipt-token donation inflation attack | ⚠️ MITIGATED (1e18 `_decimalsOffset`) | DOWN |
| VLT-16 | Uniswap V4 adapter noncanonical router ABI | ❌ REFUTED (own shim) | DOWN → Info |
| VLT-17 | Uniswap V4 pricing assumes V3 `observe()` pool | ⚠️ PARTIAL (demo vault, not router-eligible) | SAME |
| VLT-18 | Retire leaves router-eligibility state stale | ✅ CONFIRMED | SAME (Med) |
| VLT-19 | Registry `retire()` reverts on basket-vault subclasses | ✅ CONFIRMED (latent; only `RobotMoneyVault` implements it) | SAME |
| VLT-20 | Withdrawals/rebalance push adapters above caps | ✅ CONFIRMED (by design, re-converges) | DOWN |
| VLT-21 | `redeem()` return diverges from USDC transferred | ✅ CONFIRMED | SAME (Low) |
| VLT-22 | Exact-asset withdraw overcharges fee (ceil gross-up) | ✅ CONFIRMED (±1 unit dust) | SAME (Low) |
| VLT-23 | Exit fee rounds to zero on dust chunks | ✅ CONFIRMED (±1 unit dust) | SAME (Low) |
| VLT-24 | Exit-fee rounding makes `maxWithdraw` unwithdrawable | ❌ REFUTED (L-1 floor fix) | DOWN |
| VLT-25 | Emergency-unwind deposit-pause cannot be cleared | ✅ CONFIRMED | **UP → Med** |
| VLT-26 | Dust donations block asset removal | ✅ CONFIRMED | SAME (Low) |
| VLT-27 | `decimals()=6` vs `_decimalsOffset()=18` | ✅ CONFIRMED (documented) | DOWN → Info |

### rmpc payment client (Rust, prod-only)

| # | Finding | Verdict | Re-grade |
|---|---------|---------|----------|
| RPC-1 | `get-agent` uses deprecated calendar-window gross | ✅ CONFIRMED | SAME (Med) |
| RPC-2 | Replay cache written before receipt success (no remove) | ✅ CONFIRMED | **UP → High (local)** |
| RPC-3 | Failover stops on transient indexing error (`Ok(None)` terminal) | ✅ CONFIRMED | SAME (Med) |
| RPC-4 | Missing `result` accepted as null receipt | ✅ CONFIRMED | SAME (Med) |
| RPC-5 | Vote proposal-id parsed hex-before-decimal | ✅ CONFIRMED | **UP → High** |
| RPC-6 | Keystore files created without 0600 | ✅ CONFIRMED | **DOWN → Low** (encrypted blob) |
| RPC-7 | Withdraw preflight omits share allowance/balance | ⚠️ PARTIAL | **UP → High (router)** / DOWN (single-vault) |
| RPC-8 | Agent expiry preflight uses wall-clock | ✅ CONFIRMED | SAME (Low) |
| RPC-9 | Deposit/status logs unbounded by envelope block | ✅ CONFIRMED | SAME (Low) |
| RPC-10 | Keystore import leaves key in non-zeroized buffers | ✅ CONFIRMED | SAME (Low) |
| RPC-11 | Pending timelock ops dropped on `getTimestamp` failure | ✅ CONFIRMED | SAME (Low) |
| RPC-12 | Router deposits share vault-deposit replay namespace | ✅ CONFIRMED | SAME (Low) |
| RPC-13 | Self-check exposure reports zero allowance on read failure | ✅ CONFIRMED | SAME (Low) |
| RPC-14 | Role membership ignores grant/revoke chronology | ✅ CONFIRMED | SAME (Low) |
| RPC-15 | `get-tx` receipt postdates envelope block | ✅ CONFIRMED (dup of RPC-9 class) | SAME (Low) |
| RPC-16 | Unpinned balance/allowance reads | ✅ CONFIRMED (dup of RPC-9 class) | SAME (Low) |
| RPC-17 | Vault share-price saturates on overflow | ✅ CONFIRMED | **DOWN → Info** |
| RPC-18 | Withdraw flows omit local replay-cache checks | ✅ CONFIRMED | SAME (Low) |

### smoke-test / fork-e2e harness (Rust — test/devnet)

| # | Finding | Verdict | Re-grade |
|---|---------|---------|----------|
| HARN-1 | Checked-in devnet faucet private key | ✅ CONFIRMED (by-design throwaway) | **DOWN → Info/Low** |
| HARN-2 | Faucet key in public Vite bundle + cloudflared tunnel + printed | ✅ CONFIRMED | SAME (Med — most-real) |
| HARN-3 | Holder allowances/blacklist not scrubbed before grant | ✅ CONFIRMED | **DOWN → Low** |
| HARN-4 | Ingested impl account bypasses seed bytecode | ✅ CONFIRMED | **DOWN → Low** |
| HARN-5 | Pinned manifest doesn't authenticate snapshot bytes | ✅ CONFIRMED | SAME (Med — supply-chain) |
| HARN-6 | USDC grant ignores packed blacklist bit (V2_1-vs-V2_2 mismatch) | ✅ CONFIRMED | SAME (Med — robustness bug, no attacker needed) |
| HARN-7 | Seed can preserve/grant minter authority | ✅ CONFIRMED | **DOWN → Low** |
| HARN-8 | Seed not tied to pinned manifest (chain/fork_block ignored) | ✅ CONFIRMED | **DOWN → Low** |
| HARN-9 | New run force-removes other runs' live containers | ✅ CONFIRMED | **DOWN → Low** (local concurrent-run DoS) |

### dapp (React/TypeScript)

| # | Finding | Verdict | Re-grade |
|---|---------|---------|----------|
| DAPP-1 | Governance UI gates on current power, not snapshot power | ✅ CONFIRMED | SAME (Med) |
| DAPP-2 | Router deposit UI submits zero per-leg share floors | ✅ CONFIRMED | SAME (Med) |
| DAPP-3 | Stale-allowance UI checks agent, not shareReceiver, allowance | ✅ CONFIRMED (but unwired dead code) | **DOWN → Low** |
| DAPP-4 | Destination selector doesn't control direct-deposit target | ✅ CONFIRMED (live, unremediated) | **UP → High** |
| DAPP-5 | `VaultDetail` decodes `shortlist` as structs not parallel arrays | ✅ CONFIRMED | **UP → Med** (hard ABI decode break) |
| DAPP-6 | Timelock panel ignores grant/revoke chronology | ✅ CONFIRMED (mirrors RPC-14) | SAME (Low) |

---

## Recommended remediation priority

1. **IDX-1 (Critical).** Remove the dead second `erc4626_withdraw` branch; route
   the topic to the `vault_transfer_events` writer (or add a regression test that
   asserts a withdrawal produces a `direction='withdrawal'` row). This single fix
   restores the entire burn-side safety alarm. Pair with a watchdog integration
   test that a synthetic burn above threshold triggers a breach.
2. **Watchdog reliability (WD-1, WD-6, IDX-4/6/7).** Add per-call RPC timeouts and
   enforce the SLA; iterate over *all* newly-indexed blocks per cycle, not just the
   MAX; de-duplicate routed mint volume; include direct/registered-vault flows.
3. **rmpc correctness footguns (RPC-5, RPC-2, RPC-3/4, RPC-7).** Parse proposal-id
   decimal-first; add a `ReplayCache` remove/finalize-on-failure path; treat
   transient/malformed RPC as retryable across failover endpoints; implement real
   share allowance/balance checks in the router-withdraw preflight.
4. **DAPP-4 / DAPP-5.** Thread the selected vault address into the single-vault
   deposit allowance/sim path; fix the `shortlist` ABI to parallel arrays.
5. **Contract hardening (VLT-25, VLT-19, VLT-10, RTR-1).** Add a deposit-pause
   clear that doesn't depend on `Pausable` state; implement `retire()/unretire()`
   on basket-vault subclasses (or stop calling them from the registry); cap Morpho
   pulls by `maxWithdraw` (or `try/catch` per adapter); add a router USDC
   minimum-balance carve-out / sweep for donated dust.
6. **Shared-root fixes.** One chronology-aware role reconstruction for both
   `rmpc get-timelock` and the dapp `TimelockPanel` (RPC-14 + DAPP-6); pin read
   commands to the sampled block tag (RPC-9/15/16); surface RPC errors via
   `partial`/`errors` instead of fabricating zeros (RPC-11/13/17).

---

## Summary

- An external automated scan reported 95 findings (6H/61M/28L). Verified against
  HEAD `e8712ae3`, **most reproduce at the code level but severities are badly
  miscalibrated**, and part of the scan ran on a **stale code snapshot**.
- The **four "High" contract access-control findings collapse**: share movement
  requires the victim's own ERC-20 allowance to the gateway, so consent is
  structural — no fund-theft hole. They reduce to one availability DoS (USDC dust)
  plus low-grade nuisance items.
- The **most severe real finding was under-rated**: a duplicate indexer `Withdraw`
  branch makes the watchdog's burn alarm **permanently inert** — re-graded
  **Critical**. The watchdog's volume accounting is broadly unreliable (blind to
  burns, double-counts mints).
- **Upgraded:** IDX-1→Critical; WD-1, WD-6, RPC-2, RPC-5, RPC-7, DAPP-4→High;
  VLT-25, DAPP-5→Med. **Downgraded:** most contract access-control to Low/Refuted,
  ABI-shim and exit-fee findings to Info/Refuted, devnet faucet-key findings to
  Info/Low.
- Real work concentrates in **off-chain services** (indexer + watchdog), a few
  **client footguns** (rmpc, dapp), and a small set of **contract hardening gaps**.
