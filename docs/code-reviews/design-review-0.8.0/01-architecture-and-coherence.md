# Architecture & Internal Coherence Review (v0.8.0 / Step 3f Design)

> **Pass 3 final draft (2026-11-14).** The severities in this chapter are Pass 2's. Each finding carries its Pass 3 rating. `00-executive-summary.md` §4 and `06-pass-3-adversarial-critique.md` govern.

**Review Scope:** Design documents only (implementation code `.sol`, `.rs`, `.ts` excluded).  
**Worktree:** `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/design-review-0.8.0`  
**Disposition Tags:** `[DEFEATED]` (initial concern disproven by the design docs), `[CORRECTED]` (severity/framing calibrated to reflect intentional baseline vs. genuine defect), `[EXPANDED]` (scope enlarged with newly identified coherence/design gaps).

---

## 1. Scope & Documents Reviewed

| Document | Sections / Lines Reviewed | Role in Design |
| --- | --- | --- |
| `docs/technical/one-vault-rebalancer-proposal.md` | Full document (§1–§21, L1–3085) | Primary experiment design doc for single-vault `RobotMoneyFund`, `FlowQueue`, `Rebalancer`, `RebalanceGovernance`, Step 3d/3e (`v0.8.0-onevault` hardening), and Step 3f (`v0.9.0-onevault`) design & reviews. |
| `docs/technical/one-vault-timed-flows-eng-plan.md` | Full document (§1–§8, L1–562) | Engineering plan implementing Step 3d (§1–§7, `E1`–`E23`) and Step 3f (`§8`, `E24`–`E51`) contracts, checks, tests, and work packages. |
| `docs/technical/one-vault-prd-amendments.md` | Full document (§1–§5, L1–119) | Staged PRD amendments mapping Step 3d/3e (§1–§4) and Step 3f (§5) design breaks against `docs/prd.md`. |
| `docs/adr/ADR-0004-agent-token-shortlist-governance.md` | Full document (L1–268) | Canonical shortlist governance ADR (Safe + `TimelockController`), including 2026-10-05/06 amendments and 2026-11-13 `D4-10` addendum for the fund system. |
| `docs/prd.md` | §5–§6 (L181–334), §12 (L717–755) | Cross-checked only for line references cited in `one-vault-prd-amendments.md`. |

---

## 2. Summary of Architecture as Specified

The proposal tests invalidating the rejection of `ADR-0010` by replacing the three-vault + `PortfolioRouter` + `RouterGovernance` + `VaultRegistry` architecture with a single pooled USDC fund (`RobotMoneyFund`, share token `rmFUND`) governed by per-asset target weights (`docs/technical/one-vault-rebalancer-proposal.md` §1 L30–71, §4 L103–140, §6 L1377–1392):

1. **Flat Asset List & Sleeves-as-Labels (§4.1 L142–216):** On-chain contracts store no sleeve IDs or intra-sleeve weights. `ConsensusRecommendationReceipt` (schema 1.1) carries an optional `assets` list with per-asset `weight_bps` summing to 10,000, while `sleeve` is an off-chain reporting label audited off-chain against the four bucket weights.
2. **NAV & Valuation (§4.2 L218–234):** `totalAssets` combines idle USDC, exact 1:1 lending adapter `totalAssets()`, and basket token balances valued at pool TWAP. Outside price feeds (Chainlink on Base) act as guards (`ORA-4` spot-vs-TWAP, `refBandBps`, share-price breaker), not direct pricing sources.
3. **Async Netted, Forward-Priced Flows (§4.3–§4.4 L235–286, §5.11.1–§5.11.6 L950–1261):** Under Step 3d/3e (`§5.9`, `v0.8.0-onevault`), deposits and redemptions carry per-request price limits, do not match against each other, and `redeemInKind` stays instant (`§5.9.2–§5.9.4`). Under Step 3f (`§5.11`, `v0.9.0-onevault`), requests carry no per-request limit (`D17`), lock at epoch close (`RB-25`), match at TWAP-based NAV per share with only the net side trading (`D16`), undergo a 1-hour `minHold` (`D4-11`, `§5.11.8 L1310`, `§10 L1682–1683`), and restrict `redeemInKind` to a Safe-initiated wind-down state (`shutdown`, `D18`/`D24`).
4. **Asset Admission & Delisting (§4.5 L288–386):** Basket assets require a 24/7 independent Base price feed (excluding tokenized equities like `deSPXA`), ≥1 settlement window of TWAP history, `poolShareBps` capacity, `minPoolDepthUsdc` depth (Rule 4), and pool fee + `feeMarginBps` < `legBandBps` (Rule 6). Lending adapters must expose venue liquidity without overstating and book actual received USDC (`RB-34` L1549–1552). Failed assets are delisted via Safe + timelock and sold down via a dedicated keeper-only delisting path (`§4.5` Rule 5 L331–344).
5. **Governance & Roles (§5.6 L541–565, §5.11.5 L1215–1236, §5.11.6 L1246, §5.11.8 L1306–1312, `ADR-0004` L266–268):** `ADMIN_ROLE` is held exclusively by the fund-system `TimelockController`, where the Safe multisig is the sole proposer, canceller, and executor (`D4-10`). `EMERGENCY_ROLE` (hot key) holds only self-expiring pauses (`maxPause`, working default 72h in `§5.11.5 L1221–1222`) and single-settlement share freezes (`maxFreeze`, working default 7d in `§5.9.5 L816`). Under Step 3f, `KEEPER_ROLE` exclusively calls `settle` and `step` with no permissionless grace fallback (`D20`).

---

## 3. Numbered Findings

### Disposition Summary

| ID | Status | Severity | Summary |
| --- | --- | --- | --- |
| **ARCH-01** | `[CORRECTED]` | Medium | `§4` diagram (and `§5.6` forward-links) lack `v0.8.0-onevault` baseline labels; `§5.6`/`§5.9` themselves are intentional pre-3f baseline |
| **ARCH-02** | `[CORRECTED]` | Medium | `§1` (L61) & `§9` (L1612) hold stale "one day" hold (wrong even for `v0.8.0`); `§8` lacks Step 3f delta; early `unpause*` override ambiguous |
| **ARCH-03** | `[EXPANDED]` | High | `deSPXA` sub-point **`[DEFEATED]`**; expanded with missing `D30` slice-claim accounting (`RB-34`, `RB-19`, `step()`, `timed-flows-eng-plan.md §8.2`), `RB-22` & EIP-170 gaps |
| **ARCH-04** | **`[DEFEATED]`** | None (Defeated) | `§5.9.6` (L840–874) & `§5.11.6` (L1248) explicitly specify ERC-7575 split and all 7 departures; retired-vault PRD item stays under `ARCH-07` |
| **ARCH-05** | `[EXPANDED]` | High | Undefined Step 3f parameters, unspecified `D30` slice-claim NAV exclusion & proceeds split, `RB-19`/`step()` gaps, and 48h timelock deadlock on delisting |
| **ARCH-06** | Unchanged | Medium | `ADR-0004` L218 single-signer cancel contradiction; disconnected admission gates and unstated 48h timelock delay in `proposal.md` |
| **ARCH-07** | `[CORRECTED]` | Low (Tracked Open Work) | `one-vault-prd-amendments.md §5` (L109–118) explicitly tracks 4 unamended breaks; concrete timing bug in `§5` (L91) ("after the next settlement" vs. "when that round ends") |
| **ARCH-08** | `[EXPANDED]` | Medium | Role placement (`TARGET_SETTER_ROLE`), UUPS upgrade invariants, and missing `DEP-03`/`E47` exclusivity checks for internal system roles (`FLOW_ROLE`, `REBALANCER_ROLE`, `GOVERNANCE_ROLE`, `TARGET_SETTER_ROLE`, `RECEIPT_SUBMITTER_ROLE`) |
| **ARCH-09** | Unchanged | Low / Open Question | `VaultRegistry` removal (`D4`) & `G6` operational/client complexity gate remain unverified (`Not run`) |

---

### ARCH-01 `[CORRECTED]`: Top-level diagram (`§4`) lacks `v0.8.0-onevault` baseline scoping vs. Step 3f (`§5.11`), while `§5.6` is an intentional pre-3f baseline

> **Pass 3:** Low (was Medium). Captions and forward links only. See `06`.

- **Severity:** Medium (downgraded from High)
- **Exact Citations:**
  - Unqualified diagram / step descriptions: `docs/technical/one-vault-rebalancer-proposal.md` §4 (L116, L122, L124), §5.4 (L486–492), §5.6 (L533, L549)
  - Explicit `v0.8.0-onevault` baseline & Step 3f reconciliation docs: `docs/technical/one-vault-rebalancer-proposal.md` §5.9 (L610–612), §5.10 (L927–928, L934–935), §5.11 (L941–945), §5.11.8 (L1311), `docs/technical/one-vault-timed-flows-eng-plan.md` (L21–22)
  - Step 3f rules: `docs/technical/one-vault-rebalancer-proposal.md` §4.4 (L281–286), §5.11.5 (L1177–1206), §5.11.6 (L1244, L1246), §7 RB-20 (3f) (L1506–1507), §7 RB-26 (L1524–1525), `docs/technical/one-vault-timed-flows-eng-plan.md` E34 (L401)
- **Problem Description:**
  Earlier sections of `one-vault-rebalancer-proposal.md` intentionally document the active **Step 3d/3e (`v0.8.0-onevault`) baseline** until Step 3f (`v0.9.0-onevault`) is built. That baseline boundary is explicitly stated in `§5.9 (L610–612)` (*"§5.9.1 to §5.9.7 describe the flows as step 3d built them, and they stand until step 3f replaces the parts §5.11 names"*), `§5.10 (L934–935)` (*"Until step 3e is built, §5.3 to §5.8 and RB-4 and RB-5 describe the step as it is: priced and booked at the TWAP alone"*), `§5.11 (L941–945)`, and `timed-flows-eng-plan.md (L21–22)`. In particular, `§5.11.8 (L1311)` explicitly reconciles `§5.6`'s roles table against Step 3f (*"Three rows change from step 3f. `KEEPER_ROLE` is the only caller of `settle` and `step`, with no grace period (D20). `allowReturn` leaves `ADMIN_ROLE`'s list (D24). `pauseQueue` ends by itself (D24)."*). Consequently, `§5.6 (L533, L549)` keeping `keeperGrace` and pre-3f role text is **intentional `v0.8.0-onevault` baseline documentation**, not an unrecorded design contradiction.

  What remains genuinely un-reconciled is missing baseline scoping in the top-level overview and missing forward-pointers:
  1. **`§4` target architecture diagram (L105–133) lacks a baseline note:** It shows `Keeper (KEEPER_ROLE, or anyone after the grace period) -> Rebalancer.step()` (L116), `-> vault.redeemInKind (instant)` (L122), and `Keeper (KEEPER_ROLE, or anyone after the grace period) -> FlowQueue.settle(maxRequests, maxUsdc)` (L124) with no banner stating that the diagram depicts Step 3d/3e (`v0.8.0-onevault`) rather than Step 3f (`v0.9.0-onevault`), even though `§4.3 (L250–254)` and `§4.4 (L281–286)` below it each add explicit Step 3f delta paragraphs.
  2. **`§5.4` (L486–492) and `§5.6` (L533, L549) lack forward links to `§5.11.8`:** Unlike `§5.10 (L927–928)` and `§5.9 (L610–612)`, `§5.4` and `§5.6` do not warn readers that Step 3f removes `keeperGrace` and changes three rows of the roles table in `§5.11.8 (L1311)`.
- **Impact:** Moderate documentation confusion risk: a reader inspecting only `§4` or `§5.6` without reading `§5.11.8` can mistake `v0.8.0-onevault` mechanics (`keeperGrace`, instant `redeemInKind`) for the Step 3f (`v0.9.0-onevault`) target design.
- **Recommendation:** Add an explicit baseline caption to `§4` (L103–133) noting that the diagram shows Step 3d/3e (`v0.8.0-onevault`) and summarizing the Step 3f changes (`KEEPER_ROLE`-only `step`/`settle`, wind-down-only `redeemInKind`), and add brief forward references in `§5.4` and `§5.6` to `§5.11.8 (L1311)`.

---

### ARCH-02 `[CORRECTED]`: Stale 1-day hold in `§1` & `§9` (wrong even for `v0.8.0`), missing Step 3f delta in `§8`, and ambiguous early `unpause*` override

> **Pass 3:** Medium. Confirmed at `proposal.md` L61 and L1612. See `06`.

- **Severity:** Medium (downgraded from High)
- **Exact Citations:**
  - Genuinely stale even for `v0.8.0-onevault`: `docs/technical/one-vault-rebalancer-proposal.md` §1 (L61), §9 (L1612) — "held for one day" (vs. `D4-11` in §5.9.5 L809, L830–831; §5.11.8 L1310; §10 L1682–1683; `docs/technical/one-vault-timed-flows-eng-plan.md` L86–87; `docs/technical/one-vault-prd-amendments.md` §1 row 2 L22)
  - Intentional `v0.8.0-onevault` baseline in `§5.6`: `docs/technical/one-vault-rebalancer-proposal.md` §5.6 (L547) — `unpauseDeposits`, `unpauseQueue`, `allowReturn` — reconciled for Step 3f in §5.11.8 (L1311)
  - Missing Step 3f delta in `§8`: `docs/technical/one-vault-rebalancer-proposal.md` §8 (L1571–1592, specifically L1575 `quoteDeposit`/`quoteRedeem` and L1590 `allow-settlement-return`)
  - Early-unpause ambiguity: `docs/technical/one-vault-rebalancer-proposal.md` §5.11.3 item 8 (L1062), §5.11.5 (L1217–1222), §5.11.8 (L1311), §7 RB-32 (L1543–1545)
- **Problem Description:**
  Distinguishing the intentional `v0.8.0-onevault` baseline (`§5.6`, `§5.9`, reconciled in `§5.11.8 L1311`) from genuinely stale text isolates three real inconsistencies:
  1. **Stale 1-day hold (wrong even for `v0.8.0-onevault`):** `§1 (L61)` and `§9 (L1612)` still state that deposit shares are *"held for one day (§5.9)"*, even though `v0.8.0-onevault` decision `D4-11` (`§5.9.5 L809, L830–831`, `§5.11.8 L1310`, `§10 L1682–1683`, `timed-flows-eng-plan.md L86–87`, `one-vault-prd-amendments.md §1 row 2 L22`) lowered both the default and the floor to **1 hour**. (`timed-flows-eng-plan.md` E8 L58 also retains *"no exit for one day"* as part of the Step 3d historical section `§1–§7`, though `L86–87` adds the `D4-11` correction.)
  2. **Missing Step 3f delta in `§8` (`L1571–1592`):** Unlike `§4.3`, `§4.4`, `§5.10`, and `§7`, `§8` has no Step 3f update:
     - `§8 (L1575)` still points clients to *"the quotes (`quoteDeposit`, `quoteRedeem`)"* without noting Step 3f removes worst-case prices from both (`§5.11.3 L1027–1030`, `§5.11.6 L1243`, `E31`), closes `cancel` at epoch close (`RB-25 L1520–1521`), opens stopped-deposit cancel (`L1521–1522`), and adds post-`maxRoll` redemption notice (`L1522–1523`).
     - `§8 (L1590)` still lists `allow-settlement-return` as a `publish-contracts` govern row without noting its Step 3f removal (`§5.11.5 L1228–1230`, `§5.11.6 L1247`, `§5.11.8 L1311`) or the addition of Step 3f governance rows (`restore`, single-asset `emergencyUnwind`, delisting & delisted-sale parameters), and `§8 (L1591–1592)` does not note that the keeper loses `keeperGrace` (`D20`). Because `§8` is the direct input to Gate `G6` (`§13 L1948`, `§10 L1858–1861`), omitting Step 3f deltas distorts `G6` evaluation.
  3. **Ambiguous early-unpause authority under Step 3f:** While `§5.6 (L547)` listing `allowReturn` and `unpauseQueue` is intentional for `v0.8.0-onevault`, `§5.11.8 (L1311)` notes only that *"`pauseQueue` ends by itself (D24)"* without addressing `unpauseQueue`, `unpauseDeposits`, or `resumePlan` (`§5.6 L547`). Meanwhile `§5.11.5 (L1217–1222)` and `RB-32 (L1543–1545)` make all three pauses (`pauseQueue`, `pauseDeposits`, `pauseRebalance`) self-expiring after `maxPause`, yet `§5.11.3 item 8 (L1062)` still assumes `ADMIN_ROLE` can call `unpauseDeposits` early through the timelock (*"because `unpauseDeposits` goes through the timelock"*). Whether `ADMIN_ROLE` retains early manual unpause functions under Step 3f is never explicitly stated.
- **Impact:** Production migration docs (`§9`) and summary text (`§1`) misstate the `v0.8.0` hold as 24 hours instead of 1 hour; `G6` govern-row and client-surface counts derived from `§8` omit Step 3f changes and retain `allow-settlement-return`; runbook authors face ambiguity on early unpausing.
- **Recommendation:** Fix `§1 (L61)` and `§9 (L1612)` immediately to **1 hour (`D4-11`)**; add a clear Step 3f delta block to `§8` (price-less terms views, cancel cutoff/notice, removal of `allow-settlement-return`, addition of Step 3f govern rows); and state explicitly in `§5.11.5` / `§5.11.8 (L1311)` whether `ADMIN_ROLE` retains early `unpauseQueue` / `unpauseDeposits` / `resumePlan` calls before `maxPause` expires.

---

### ARCH-03 `[EXPANDED]`: Invariant list (`§7`), Step 3f eng plan (`§8.2`), library architecture (`§6.1`), and evidence log (`§14`) have critical gaps on delisted-asset slice claims (`D30`), `RB-19`/`RB-22`, and EIP-170 limits (`deSPXA` sub-point `[DEFEATED]`)

> **Pass 3:** Medium (was High). Its D30 part is SAFE-08 and its RB-22 part is FLOW-02. The residual is size headroom, which the plan already measures first. Root R8. See `06`.

- **Severity:** High
- **Exact Citations:**
  - `deSPXA` intentional framing (`[DEFEATED]` sub-point): `docs/technical/one-vault-rebalancer-proposal.md` §1 (L42–43), §4 (L131), §4.5 (L383–386), §6.1 (L1411)
  - Delisted-asset slice claims & omissions: `docs/technical/one-vault-rebalancer-proposal.md` §4.5 Rule 5 (L333–344, specifically L337–342), §5.11.4 (L1077–1079, L1154–1157), §7 RB-13 (L1451–1453), RB-19 (L1470–1471), RB-34 (L1549–1552), §11 D30 (L1905); `docs/technical/one-vault-timed-flows-eng-plan.md` §3.2 (L123–124), E42 (L409), E44 (L411), §8.2 (L437–444)
  - `RB-22` & match-library gaps: `docs/technical/one-vault-rebalancer-proposal.md` §7 RB-22 (L1477–1479), §5.11.9 (L1351–1352, L1367–1370)
  - Library & EIP-170 size pressure: `docs/technical/one-vault-rebalancer-proposal.md` §6.1 (L1394–1414), §14 (L2012–2013, L2093–2100)
  - `§14` Step 3f evidence lag: `docs/technical/one-vault-rebalancer-proposal.md` §14 (L2017–2024)
- **Problem Description:**
  1. **`[DEFEATED]` Sub-point — `deSPXA` references are intentional historical framing:** `proposal.md §4.5 (L383–386)` explicitly establishes that *"Steps 1 to 3c ran with deSPXA, and their results in §14 stand as recorded... The example in §4.1 and the parameter notes in §5 that name deSPXA describe the list before this rule."* Moreover, `§1 (L42–43)` notes `deSPXA` left after step 3c, `§4 (L131)` explicitly labels it `(steps 1 to 3c only, §4.5)`, and `§6.1 (L1411)` explicitly labels it `through step 3c`. These references are intentional historical framing, not stale defects. What genuinely lags in `§14 (L2017–2024)` is that `G4`, `G5`, `G8`, and `G9` reflect only Step 3d/3e/`v0.8.0` runs, with Step 3f unmeasured.
  2. **`[EXPANDED]` Unspecified delisted-asset slice claims (`§4.5` Rule 5 `L337–342`, `E42` `timed-flows-eng-plan.md L409`) create four coherence & safety gaps:**
     - **Missing NAV / balance exclusion (`RB-34` & `§5.11.4` gap):** `§5.11.4 (L1077–1079)` and `RB-34 (L1550–1552)` (and `timed-flows-eng-plan.md E44 L411`) exclude *lending* claim units (`D23`, `RB-21`) from `S` (NAV), caps, and the venue test, and `timed-flows-eng-plan.md §3.2 (L123–124)` says `mintInKind` and pro-rata sales use `heldBalance` for past in-kind exits. Neither `RB-34` nor `§5.11.4` excludes **delisted-asset slice claims (`D30`)** — neither the claimed delisted-token balance nor undistributed USDC proceeds owed to slice-claim holders — from `heldBalance`, `idle USDC`, `RB-13` (proportion check, `L1451–1453`), or NAV (`S` / check 6). Without exclusion, consecutive redemptions settling while a delisted asset is being sold down can double-count already-claimed delisted tokens (over-allocating claims beyond 100% of the balance), and keeper sale proceeds risk being counted as fund `idle USDC` before claim holders withdraw.
     - **Unspecified proceeds split during keeper delisting steps:** Unlike `D23` lending claims (`§5.11.4 L1155–1157`), which explicitly specify shared ownership by units and pro-rata splitting of later venue payments in the same call, `§4.5 (L337–342)` and `E42 (L409)` specify only *"paid in USDC as the keeper's sale proceeds come in"* without defining claim units, how partial keeper delisting steps split USDC between existing slice-claim holders and the fund's remaining units, how `emergencyUnwind` for one asset (`L342–344`, `E50 L417`) splits proceeds if slice claims exist, or when exit fees apply.
     - **Missing `RB-19` & `step()` rules when `RB-21` or `D30` claims exist:** `RB-19 (L1470–1471)` states *"a step changes only its two traded assets and idle USDC, never the supply, and runs only when the feed checks of §5.10 pass."* First, `E42` single-asset delisting steps (`§4.5 L333–335`) violate both "two traded assets" and the `§5.10` feed checks. Second, neither `RB-19` nor `step()` (`§5.3`, `§5.10`) defines how `step()` interacts with open `RB-21` lending claim units (which require splitting venue payouts by units in the same call per `§5.11.4 L1156–1157`, modifying claim liabilities alongside `idle USDC`, and sizing withdrawals from fund-only units) or open `D30` slice claims (modifying slice-claim USDC obligations during delisting steps).
     - **Omission from `timed-flows-eng-plan.md §8.2 (L441–444)`:** `§8.2 (L441–444)` lists `E38` wind-down, `E29` `redeemInKind`, `E37` lending position claims, and `E32` depth check for `RobotMoneyFund` and `FundFlowsLib`, **while completely omitting `E42`'s delisted-asset slice claims and proceeds distribution** — even stating *"`mintInKind` and `sellForFlow` are unchanged"* (`L444`), despite `sellForFlow` needing to carve out delisted assets into `D30` slice claims instead of selling them.
  3. **`RB-22` incomplete for Step 3f (`§7 L1477–1479`, `§5.11.9 L1367–1370`):** `§5.11.9 (L1367–1370)` explicitly flags two new Step 3f share movements — intra-queue match transfers between owners and wind-down escrow releases — that must receive paired `ExclusionLedger` checkpoints under `RB-22`, yet `RB-22` in `§7` has not been updated for Step 3f.
  4. **Library & EIP-170 size mismatch (`§6.1 L1404–1406` vs. `§14 L2012–2013, L2098–2100`):** `§6.1` still describes reusing `BasketViews`, `BasketAssetConfigGuard`, `TwapTickMath`, and one lending allocator library. In reality, `§14 (L2012–2013, L2098–2100)` shows the prototype already relies on `FundFlowsLib` (19,285 B), `FundAdminLib` (23,406 B — only 1,170 B under EIP-170), and `FundValuationLib` (8,038 B), plus a new match library (`§5.11.9 L1351–1352`). Meanwhile `RobotMoneyFund` itself is already **23,237 B** (`§14 L2012` — 1,339 B under 24,576 B) *before* adding Step 3f's wind-down state/escrow release (`E38`), `E37` position claims, `E32` depth checks, `E50` single-asset `emergencyUnwind`, and `E42` delisted-asset slice-claim accounting + proceeds distribution.
- **Impact:** Severe EIP-170 (`Gate G1`) blow-up risk on `RobotMoneyFund` and `FundAdminLib` once Step 3f (including omitted `E42` slice-claim logic) is implemented; double-counting / loss-allocation bugs in redemptions and keeper steps during asset delisting or active `RB-21` claims; untraced match/wind-down share movements breaking `ExclusionLedger` recovery (`RB-22`).
- **Recommendation:**
  1. Extend `RB-34`, `§5.11.4 (L1077–1079)`, and `RB-13` (`heldBalance`) to exclude `D30` delisted-asset slice claims and undistributed delisting USDC proceeds, and specify unit accounting, pro-rata step/unwind proceeds splitting, and pull claims (`E22`) for `D30` analogous to `D23`/`RB-21`.
  2. Update `RB-19` and `§5.3`/`§5.10` to permit single-asset delisting steps and define held-vs-claimed balance rules when `RB-21` or `D30` claims exist; update `timed-flows-eng-plan.md §8.2 (L441–444)` to cover `E42` slice claims in `RobotMoneyFund`/`FundFlowsLib` (`sellForFlow`) and `FlowQueue`.
  3. Update `RB-22` explicitly for intra-queue match transfers and wind-down escrow releases (`§5.11.9 L1367–1370`).
  4. Update `§6.1` to list actual linked libraries (`FundFlowsLib`, `FundAdminLib`, `FundValuationLib`, match library) and run the Step 3f throwaway `G1` size check (`timed-flows-eng-plan.md §8.4` package 1) inclusive of `E42` slice-claim logic.

---

### ARCH-04 `[DEFEATED]`: "ERC-4626 in shape" and ERC-7540 claims in `§1`, `§4`, `§6`, and `§5.11.6`

> **Pass 3:** Defeated. Agreed. See `06`.

- **Severity:** None — **`[DEFEATED]`** (was High)
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §5.9.6 (L840–874, 7-row departures table at L864–872), §5.11.6 (L1244, L1248)
  - Cross-references in §1 (L39), §4 (L121, L128), §6 (L1388), §8 (L1578), §11 D13 (L1888), §15.8 (L2490)
  - `docs/technical/one-vault-timed-flows-eng-plan.md` E1–E2 (L51–52)
  - Related unamended retired-vault PRD line: `docs/technical/one-vault-prd-amendments.md` §5 (L114, citing `§5, lines 303–309` — actually `docs/prd.md` §6 L303–309) -> tracked under `ARCH-07`
- **Why This Finding Is Defeated:**
  Re-checking `one-vault-rebalancer-proposal.md §5.9.6 (L840–874)` ("The vault interface: the ERC shape, not the letter") establishes that the design does **not** misrepresent ERC-4626 or ERC-7540 compliance to integrators:
  1. **Explicit ERC-7575 split:** `§5.9.6 (L846–850)` (and `timed-flows-eng-plan.md E1–E2 L51–52`) explicitly documents the two-address split: `FlowQueue` is the request/claim entry point and `RobotMoneyFund` is the share token and asset custodian.
  2. **Explicit 7-row departures table (`L864–872`):** `§5.9.6` explicitly enumerates every deviation from ERC-4626 and ERC-7540:
     - per-request limits and `quote*` views replacing `preview*`, which revert per ERC-7540 (`L858, L866`);
     - `cancel`, `exitInKind`, `redeemInKind`, and expired-escrow withdrawals (`L867`);
     - `minHold` post-settlement delivery delay (`L868`);
     - `withdraw` reverting `RedeemOnly` (`L869`);
     - `deposit`, `mint`, and `redeem` on `RobotMoneyFund` reverting and naming `FlowQueue` (`L870`);
     - `totalAssets` and `convert*` reverting when a feed is unhealthy, paired with `lastGoodNav` (`L871`);
     - no ERC-7540 `controller`/operators (`L872`).
  3. **Direct links from upstream sections:** `§1 (L39)`, `§6 (L1388)`, `§11 D13 (L1888)`, and `§15.8 (L2490)` explicitly cite `(§5.9.6)` wherever they say "ERC-4626 in shape" (and `§4 L128` follows the diagram pointing to `§5.9` at `L121`).
  4. **Explicit Step 3f reconciliation:** `§5.11.6 (L1248)` specifically notes that removing per-request limits eliminates only the first row of `§5.9.6`'s departures table (*"The departure from ERC-7540 'each request takes a limit' (§5.9.6)"*), while `L1244` removes `exitInKind` and gates `redeemInKind` on wind-down.
- **Residual Tracked Items:** Updating rows 1 and 2 of `§5.9.6`'s departures table for Step 3f is minor editorial hygiene under Step 3f; the unamended retired-vault promise in `docs/prd.md` (`one-vault-prd-amendments.md §5 L114`, citing `§5 L303–309` / `docs/prd.md §6 L303–309`) remains properly tracked under **`ARCH-07`**.

---

### ARCH-05 `[EXPANDED]`: Asset admission & delisting (`§4.5`, D12/D19/D30) has undefined parameters, unspecified slice-claim mechanics, and a timelock deadlock during market/feed failures

> **Pass 3:** Medium (was High). Its D30 part is SAFE-08. The parameters are already recorded open. A dead-feed halt is the stuck-fund case the owner accepted under D24; the design should say so for this trigger. See `06`.

- **Severity:** High
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §4.5 (L317–345, L348, L374–376), §5.6 (L562–565), §5.11.4 (L1077–1079, L1151–1157), §5.11.9 DEP-01 (L1347–1350), §7 RB-19 (L1470–1471) & RB-34 (L1549–1552), §11 D12/D19/D30 (L1887, L1894, L1905), §21.4 (L3071–3072)
  - `docs/technical/one-vault-timed-flows-eng-plan.md` E42 (L409), E44 (L411), §8.2 (L437–444)
  - `docs/adr/ADR-0004-agent-token-shortlist-governance.md` (L190–196, L266–268)
- **Problem Description:**
  1. **Undefined critical Step 3f parameters:** `§4.5` (and `§21.4 L3071–3072`) leave four safety-critical Step 3f parameters without defaults: `minPoolDepthUsdc` (Rule 4, `L374–375`), `feeMarginBps` (Rule 6, `L348`), and the delisting sale's price bound and cost budget (Rule 5, `L344`, `E42 L409`).
  2. **Unspecified delisted-asset slice-claim mechanics (`§4.5` Rule 5 `L337–342`, `E42` `timed-flows-eng-plan.md L409`):**
     - **No balance / NAV exclusion (`RB-34` gap):** `§5.11.4 (L1077–1079)` and `RB-34 (L1550–1552)` exclude lending claim units (`D23`, `RB-21`) from `S` (NAV), caps, and the venue test, **but do not exclude delisted-asset slice claims (`D30`)** from the fund's token balance (`heldBalance`), `idle USDC`, `RB-13` proportion checks, or NAV. While redemptions continue settling during delisting (`L337`), failing to deduct claimed delisted-asset slices from `heldBalance` causes subsequent redemptions to double-count already-claimed tokens and risks conflating claim-holders' sale proceeds with the fund's `idle USDC` during keeper sale steps.
     - **Unspecified proceeds split between slice-claim holders and remaining fund units:** `§4.5 (L340–341)` and `E42 (L409)` state only *"paid in USDC as the keeper's sale proceeds come in"*, without specifying unit representation, pro-rata vs. priority payout across multi-step keeper delisting sales (or `emergencyUnwind` for one asset, `L342–344`), exit-fee application, or pull-credit mechanics (`E22`).
     - **Missing `RB-19` & `step()` rules when `RB-21` or `D30` claims exist:** `RB-19 (L1470–1471)` assumes two traded assets, `§5.10` feed checks, and only asset + `idle USDC` deltas; `step()` has no specified rule for single-asset delisting steps or for handling open `RB-21` claim units / `D30` slice claims when withdrawing or selling (e.g., excluding claim-holder units from rebalance sizing and crediting pro-rata claim payouts in the same `step()` call per `§5.11.4 L1156–1157`).
     - **Omission from `timed-flows-eng-plan.md §8.2 (L441–444)`:** `§8.2` specifies `E37` lending claims for `RobotMoneyFund` and `FundFlowsLib`, but omits `E42`'s delisted-asset slice claims and proceeds distribution while asserting `sellForFlow` is unchanged (`L444`).
  3. **Timelock + Safe-only executor bottleneck on delisting:** Under `§4.5 (L325–344)`, nothing delists an asset automatically; delisting, setting target to 0, opening the delisting sale, or calling single-asset `emergencyUnwind` for a dead-feed asset all require the Safe to propose via `TimelockController`, wait the timelock delay (48h on Base mainnet per `ADR-0004` L190–196, unstated in `proposal.md`), and gather Safe signatures *again* to execute (`D4-10`, `§5.6 L562–565`). While an asset has a dead feed or is being sold out, deposits and matching stop (`§4.5 L336–337`), and before delisting executes, a dead feed halts **all** settlements (`§5.9.3` check 2 L717–718).
  4. **Asymmetric on-chain enforcement:** Rules 3, 4, and 6 are explicitly enforced at target changes, cap/parameter updates, or round checks, whereas Rules 1 (24/7 live feed) and 2 (1 settlement window of TWAP history) rely on admission-time existence without explicit on-chain enforcement rules in `§4.5` (and `§4.5 L341–342` does not specify how check 6 / `totalAssets` values a delisted asset after its checks "leave the round" if its feed is dead).
- **Impact:** If an asset's feed dies or its pool permanently loses depth, deposits, matching, and potentially redemptions freeze for at least the 48h timelock delay plus two rounds of Safe coordination; missing `D30` accounting rules risk double-counting balances and corrupting proceeds distribution; undefined defaults block Step 3f deployment verification (`DEP-01`, `§5.11.9 L1347–1350`).
- **Recommendation:** Specify concrete defaults/bounds for `minPoolDepthUsdc`, `feeMarginBps`, and the delisting sale bound/budget; fully specify `D30` slice-claim unit accounting, balance/NAV exclusion (`RB-34`/`RB-13`), pro-rata proceeds splitting on keeper delisting steps and single-asset `emergencyUnwind`, `RB-19`/`step()` behavior with open `RB-21`/`D30` claims, and `timed-flows-eng-plan.md §8.2`; document the 48h timelock delay in `§5.6`; and evaluate whether `emergencyUnwind` on a single dead-feed asset requires an accelerated operational path or stays intentionally behind the full Safe+timelock delay.

---

### ARCH-06: `ADR-0004` vs. `proposal.md` governance & admission rules divergence and internal `ADR-0004` contradiction

> **Pass 3:** Low (was Medium). Confirmed: ADR-0004 L218 contradicts its own amendment, which governs. See `06`.

- **Severity:** Medium
- **Exact Citations:**
  - `docs/adr/ADR-0004-agent-token-shortlist-governance.md` (L93–110, L172–178, L198–200, L218, L266–268)
  - `docs/technical/one-vault-rebalancer-proposal.md` §4.5 (L288–386), §5.11.5 (L1220–1222), §7 RB-31 (L1542)
- **Problem Description:**
  1. **Internal contradiction in `ADR-0004`:** The Consequences section (L218) still claims *"The veto path is cheap (single Safe signer can cancel)"*, directly contradicting the 2026-10-05 Amendment (L172–178, L198–200), which replaced single-signer cancel with Safe-threshold cancel (`≥ 2` signatures).
  2. **Disconnected admission criteria:** `ADR-0004` (L93–110) specifies off-chain `addAsset` gates (≥$10M market cap, ≥90d age, ≥$100K daily volume, ≥500 holders, 30d TWAP/Chainlink history, ≥$50K liquidity within 2%), whereas `proposal.md` §4.5 (`D12`, `D19`) specifies Rules 1–6 without referencing `ADR-0004` or stating whether `ADR-0004`'s off-chain gates still apply to `RobotMoneyFund`.
  3. **Unstated timelock delay in `proposal.md`:** `proposal.md` references *"the timelock's delay"* in `RB-31 (L1542)` and `§5.11.5 (L1220–1222)` (`maxPause` ≥ timelock delay, working default 72h) without stating the delay value or linking `ADR-0004`'s 48h Base floor (`L190–196`).
- **Impact:** Governance operators lack a single source of truth for asset admission criteria and timelock delays on the one-vault fund.
- **Recommendation:** Fix `ADR-0004` L218 to reflect Safe-threshold cancellation. Explicitly state in `proposal.md` §4.5 whether `ADR-0004`'s off-chain gates apply alongside `D12`/`D19`, and state the fund-system `TimelockController` minimum delay in `§5.6`.

---

### ARCH-07 `[CORRECTED]`: `one-vault-prd-amendments.md` tracks four unamended Step 3f PRD breaks and contains a concrete settlement-timing bug in `§5 (L91)`

> **Pass 3:** Low. Agreed. See `06`.

- **Severity:** Low (Tracked Open Work) (downgraded from Medium)
- **Exact Citations:**
  - `docs/technical/one-vault-prd-amendments.md` §3 (L59–63), §4 (L65–78), §5 (L80–118, specifically **L91** timing bug and **L109–118** explicit open-work table; L119 unverified line-number note)
  - Cross-checked against: `docs/technical/one-vault-rebalancer-proposal.md` §4.5 (L382–383), §5.11.3 item 7 (L1052–1056), §5.11.5 (L1174–1175), §7 RB-25 (L1522–1523), §11 D25 (L1900); `docs/technical/one-vault-timed-flows-eng-plan.md` E40 (L407); `docs/prd.md` §6 (L303–309)
- **Problem Description:**
  1. **Tracked open work (not an unrecorded omission):** `one-vault-prd-amendments.md` is explicitly a staged draft that stays unapplied until the experiment concludes (`L3–8`, `L67–78`). Its `§5 (L109–118)` is the author's own explicit tracking list of the four PRD passages broken by Step 3f that still lack replacement text: retired-vault synchronous ERC-4626 redemption (`L114`, citing `§5, lines 303–309` — actually `docs/prd.md §6 L303–309`), `INV-2` "always redeemable by holders" (`L115`, `§12 ~L736`), agent policy revocation/expiry vs. already-locked deposit requests (`L116`, `§6/§9 L318–320, L391–393`), and "itemize fees and slippage" (`L117`, `§9 L390`). Likewise, `§3 (L59–63)` and `§4 (L65–78)` explicitly track `D2`, `D8`, `G9` thresholds, `rmpc` design, and `PAXG` eligibility (`proposal.md §4.5 L382–383`) as prerequisites before applying any PRD edits.
  2. **Concrete timing bug in `one-vault-prd-amendments.md §5 (L91)`:** In `§5` row 1 (`L91`), **both** the *"What step 3f does"* description and the *"Proposed text"* state that after notice on an unfilled redemption, the owner receives the unfilled shares **"after the next settlement"** (*"After a fixed number of epochs its owner can give notice and get the unfilled shares back after the next settlement"* / *"After 48 hours the owner of an unfilled redemption can ask for the unfilled shares back, and gets them after the next settlement"*). By contrast, `proposal.md §5.11.3 item 7 (L1052–1055)`, `§5.11.5 (L1174–1175)`, `RB-25 (L1522–1523)`, `D25 (L1900)`, and `timed-flows-eng-plan.md E40 (L407)` all specify that the request still participates in the round that is open or forming when notice is given and the unfilled shares return **"when that round ends"**. Because a capped or throttled round (`basketCallBps`, `maxRequests`, `maxUsdc`) spans multiple `settle` calls (`§5.11.4 L1131–1136`), returning shares "after the next settlement" (a single `settle` call) misstates the protocol's round-completion rule (and `L91` also hardcodes `"48 hours"` instead of `maxRoll` epochs).
- **Impact:** The four `§5 (L109–118)` items are properly tracked as open work until Step 3f completes, whereas `§5 (L91)` would embed an inaccurate redemption-notice return timing guarantee ("after the next settlement" vs. "when that round ends") if applied as drafted.
- **Recommendation:** Fix `one-vault-prd-amendments.md §5 (L91)` from *"after the next settlement"* to *"when that round ends"* (and note `maxRoll` epochs rather than fixed `48 hours`), correct `L114`'s section label (`§6` rather than `§5` in `docs/prd.md`), and draft the four tracked `§5 (L109–118)` amendments alongside `D2`, `D8`, and `PAXG` resolution before production adoption.

---

### ARCH-08 `[EXPANDED]`: Role & authority inconsistencies (`TARGET_SETTER_ROLE`, UUPS upgrades) and missing `DEP-03`/`E47` exclusivity checks on internal system roles

> **Pass 3:** Medium. Confirmed. Root R9. See `06`.

- **Severity:** Medium
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` Header (L25–26), §4 (L108, L111–114), §5.6 (L545–551), §5.11.9 DEP-03 (L1353–1359), §6 (L1385), §9 (L1599–1600), §14 (L2161 R-F4)
  - `docs/technical/one-vault-timed-flows-eng-plan.md` E1 (L51), E47 (L414)
  - `docs/prd.md` §5 (L257–263)
- **Problem Description:**
  1. **`TARGET_SETTER_ROLE` placement (`§5.6 L550–551` vs. `§4 L111–114`, `§6 L1385`):** `§5.6 (L551)` assigns `TARGET_SETTER_ROLE` (`applyReceipt`) to *"The fund-system timelock"*, while `§4 (L111–114)` and `§6 (L1385)` route `TimelockController -> RebalanceGovernance.applyReceipt(...) -> vault.setTargetAndOpenPlan(...)` (which uses `GOVERNANCE_ROLE` per `§5.6 L550`). `§5.6` omits stating that `TARGET_SETTER_ROLE` lives on `RebalanceGovernance` rather than `RobotMoneyFund`.
  2. **Missing `DEP-03` & `E47` exclusivity checks on internal system roles:** `DEP-03` (`§5.11.9 L1353–1359`) and `E47` (`timed-flows-eng-plan.md §8.1 L414`) require the deployment verifier (`publish-contracts/src/verify/fund.ts`) to prove exclusive membership **only** for the timelock roles (Safe as sole proposer, canceller, executor), `ADMIN_ROLE` (timelock only), `KEEPER_ROLE` (one keeper), and `EMERGENCY_ROLE` (one emergency key). They **omit** exclusivity verification on all internal system and receipt/governance roles (`§5.6 L550–551`, `§4 L108`):
     - **`FLOW_ROLE`** (on `RobotMoneyFund`, should belong exclusively to `FlowQueue`): can mint/burn shares and buy/sell fund holdings (`mintInKind` and `sellForFlow` / pro-rata sale; `one-vault-rebalancer-proposal.md` §5.9.3 L738–748, `timed-flows-eng-plan.md` E1 L51, E3–E4 L53–54, §3.2 L122–123, §8.2 L444).
     - **`REBALANCER_ROLE`** (on `RobotMoneyFund`, should belong exclusively to `Rebalancer`): moves fund assets via `executeStep` outside `Rebalancer`'s cooldown, glide-path, and step-cap bounds.
     - **`GOVERNANCE_ROLE`** (on `RobotMoneyFund`, should belong exclusively to `RebalanceGovernance`): sets asset targets and opens rebalance plans (`setTargetAndOpenPlan`), bypassing receipt verification.
     - **`TARGET_SETTER_ROLE`** (on `RebalanceGovernance`, should belong exclusively to the fund-system `TimelockController`): invokes `applyReceipt` / `setTarget`.
     - **`RECEIPT_SUBMITTER_ROLE`** (on `ConsensusRecommendationReceipt`, omitted from both `§5.6` and `DEP-03`/`E47`): records receipts (`§4 L108`).
     Even though `§5.6 (L550)` describes the contract-to-contract roles as *"bound once"*, `ADMIN_ROLE` holds *"every role grant"* (`§5.6 L547`), and the explicit premise of `DEP-03` (`§5.11.9 L1356–1357`) is *"Presence of the right holder is not enough"* — an extra or stale deployer/EOA holder on `FLOW_ROLE` or `REBALANCER_ROLE` would bypass queue/rebalancer invariants completely.
  3. **UUPS upgrade authority & state-preservation invariants:** The header (`L25–26`) and `§9 (L1599–1600)` specify `ADR-0014` UUPS proxies, and `§14 (L2161, R-F4)` records an upgrade storage-initialization bug (*"An upgraded proxy reads the depth cap as 0"*). However, `§5.6` does not explicitly list `UPGRADER_ROLE` / `authorizeUpgrade` under `ADMIN_ROLE`, `DEP-03`/`E47` do not verify exclusive upgrade authority across all proxies, and `§7` has no invariant protecting non-zero parameter defaults or active `freezeSettlement`, `maxPause`, `WindDown`, or `D30`/`RB-21` claim state across upgrades.
- **Impact:** A deployment verifier that proves exclusivity only on `ADMIN_ROLE`, `KEEPER_ROLE`, `EMERGENCY_ROLE`, and timelock roles would pass a deployment where a stale or extra address still holds `FLOW_ROLE`, `REBALANCER_ROLE`, `GOVERNANCE_ROLE`, `TARGET_SETTER_ROLE`, `RECEIPT_SUBMITTER_ROLE`, or proxy upgrade authority — directly violating the custody and governance boundaries.
- **Recommendation:** Clarify contract placement for `TARGET_SETTER_ROLE` (`RebalanceGovernance`), `RECEIPT_SUBMITTER_ROLE` (`ConsensusRecommendationReceipt`), and `UPGRADER_ROLE` in `§5.6`; expand `DEP-03 (§5.11.9 L1353–1359)` and `E47 (timed-flows-eng-plan.md L414)` to prove exclusive membership on `FLOW_ROLE`, `REBALANCER_ROLE`, `GOVERNANCE_ROLE`, `TARGET_SETTER_ROLE`, `RECEIPT_SUBMITTER_ROLE`, and proxy upgrader authority; and add a `§7` / `§5.11.9` upgrade-safety check covering storage defaults and active state preservation.

---

### ARCH-09: `VaultRegistry` removal & `G6` operational complexity gate remain unverified

> **Pass 3:** Low. Agreed. See `06`.

- **Severity:** Low / Open Question
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §6 (L1384, L1386), §10 step 4 (L1858–1861), §11 D4 (L1879), §13 G6 (L1948), §14 G6 (L2021)
- **Problem Description:**
  `§6 (L1384, L1386)` and `§11 D4 (L1879)` drop `PortfolioRouter` and `VaultRegistry` for new deployments (*"Working default: not kept"*). Gate `G6` (`§13 L1948`) requires net contracts, deploy stages, govern rows, and `ADMIN_ROLE` holders all to decrease and every `§8` client change to map onto an existing surface. However, `§14 (L2021)` records `G6` as `Not run`, while Step 3f adds significant operational and client surface area (epoch cutoffs, notice-for-return, wind-down state, delisting sale path, and 10+ new govern rows in `§8 L1587–1590`, plus missing Step 3f govern rows noted in `ARCH-02`).
- **Impact:** Whether the one-vault system actually reduces operational and client surface area (the core rebuttal to `ADR-0010`'s migration-cost rejection) remains unmeasured.
- **Recommendation:** Reconcile `§8` with Step 3f (`ARCH-02`) and run and score `G6` explicitly (`§10 step 4 L1858–1861`) against the Step 3f contract, govern-row, and client-surface counts before concluding the experiment.

---

## 4. Coherence Matrix

| Topic | Earlier / Baseline Sections | Step 3f (§5.11) / `v0.8.0` / Eng Plan / PRD Amendments / `ADR-0004` | Status & Finding |
| --- | --- | --- | --- |
| **Keeper Execution (`settle` / `step`)** | `§4 (L116, L124)` lacks baseline note; `§5.4 (L486–492)` & `§5.6 (L533, L549)` describe intentional `v0.8.0` baseline (`§5.11 L941–945`). | `§5.11.6 (L1246)`, `§5.11.8 (L1311)`, `RB-20 (3f) (L1506–1507)`, `E34 (L401)`: `KEEPER_ROLE`-only, `keeperGrace` removed (`D20`). | **Unmarked Baseline in `§4` / Missing Forward-Link in `§5.6` (`ARCH-01` — Medium `[CORRECTED]`)** |
| **In-Kind Exit (`redeemInKind`)** | `§4 (L122)` lacks baseline note; `§4.4 (L269–274)` & `§5.9.4 (L779–790)` are intentional `v0.8.0` baseline (`§5.9 L610–612`). | `§4.4 (L284–286)`, `§5.11.5 (L1177–1209)`, `RB-26 (L1524–1525)`, `E29 (L397)`: wind-down only (`D18`); `prd-amendments.md §5 (L91–92)` overrides `§1`. | **Unmarked Baseline in `§4` (`ARCH-01` — Medium `[CORRECTED]`; PRD in `ARCH-07`)** |
| **Deposit Share Hold (`minHold`)** | `§1 (L61)` and `§9 (L1612)` state `"one day"` (24h). | `§5.9.5 (L809, L830–831)`, `§5.11.8 (L1310, D4-11)`, `§10 (L1682–1683)`, `timed-flows-eng-plan.md (L86–87)`, `prd-amendments.md §1 (L22)` set default & floor to **1 hour**. | **Stale Even for `v0.8.0` (`ARCH-02` — Medium `[CORRECTED]`)** |
| **Freeze Return (`allowReturn`), Pauses & `§8` Surfaces** | `§5.6 (L547)` is `v0.8.0` baseline (`§5.11.8 L1311`); `§8 (L1575, L1590)` has `quote*` prices & `allow-settlement-return` with no Step 3f delta; `§5.11.3 (L1062)` cites timelock `unpauseDeposits`. | `§5.11.5 (L1217–1230)`, `§5.11.6 (L1243, L1247)`, `§5.11.8 (L1311)`, `RB-25 (L1519–1523)`, `RB-32 (L1543–1545)`: `allowReturn` removed, pauses self-expire, quotes drop prices; early `unpause*` override unstated. | **Missing `§8` Step 3f Delta / Ambiguous Early Unpause (`ARCH-02` — Medium `[CORRECTED]`)** |
| **ERC-4626 / ERC-7540 Interface Shape** | `§1 (L39)`, `§4 (L128)`, `§6 (L1388)` call fund "ERC-4626 in shape" and link `§5.9.6`. | `§5.9.6 (L840–874)` specifies ERC-7575 two-address split and 7-row departures table (`L864–872`); `§5.11.6 (L1248)` removes Row 1 (`limits`). | **`[DEFEATED]` (`ARCH-04` — None; retired-vault PRD line in `ARCH-07`)** |
| **`deSPXA` Asset References** | `§1 (L42–43)`, `§4 (L131)`, `§4.1 (L170)`, `§5 (L458, L526, L593, L596)`, `§6.1 (L1411)` reference `deSPXA`. | `§4.5 (L383–386)` explicitly defines `§4.1` & `§5` `deSPXA` text as pre-rule list; `§4 (L131)` & `§6.1 (L1411)` explicitly qualify `"steps 1 to 3c only"` / `"through step 3c"`. | **`[DEFEATED]` Sub-Point (`ARCH-03` — Intentional Historical Framing)** |
| **Linked Libraries, EIP-170 Size & `§14` Evidence** | `§6.1 (L1404–1406)` lists `BasketViews`, `BasketAssetConfigGuard`, `TwapTickMath` + 1 lending lib. | `§14 (L2012–2013, L2098–2100)` uses `FundFlowsLib` (19,285 B), `FundAdminLib` (23,406 B), `FundValuationLib` (8,038 B), `RobotMoneyFund` (23,237 B) before Step 3f + match lib (`§5.11.9 L1351`); `§14` lacks Step 3f `G4/G5/G8/G9` runs. | **Stale `§6.1` / High EIP-170 Risk (`ARCH-03` — High `[EXPANDED]`)** |
| **Delisted Slice Claims (`D30`), `RB-19`, `RB-22`, `RB-34` & Eng Plan `§8.2`** | `RB-19 (L1470–1471)` says 2 assets + `§5.10` checks; `RB-22 (L1477–1479)` lacks Step 3f traces; `RB-34 (L1549–1552)` & `§5.11.4 (L1077–1079)` exclude only `D23`/`RB-21` lending claims. | `§4.5 Rule 5 (L333–342)`, `D30 (L1905)`, `E42 (L409)` add 1-asset delisting steps + `D30` slice claims without balance/NAV exclusion, proceeds split, or `RB-19`/`step()` rules; `§5.11.9 (L1367–1370)` flags untraced `RB-22` movements; `timed-flows-eng-plan.md §8.2 (L441–444)` omits `E42` slice claims. | **Contradiction / Unspecified Accounting (`ARCH-03`, `ARCH-05` — High `[EXPANDED]`)** |
| **Asset Admission, Undefined Defaults & Delisting Deadlock** | `§4.5 (L317–386)` defines `D12`/`D19` Rules 1–6 & `D30` delisting. | `minPoolDepthUsdc`, `feeMarginBps`, delist bound/budget undefined (`L344, L348, L374–375`); 48h timelock + Safe-only executor deadlock (`D4-10`, `ADR-0004 L190–196, L266–268`); Rules 1–2 enforcement asymmetric. | **Undefined Params / Deadlock Risk (`ARCH-05` — High `[EXPANDED]`)** |
| **`ADR-0004` vs. `proposal.md`** | `§5.6 (L562–565)` & `ADR-0004 (L266–268)` set Safe-only executor (`D4-10`); `proposal.md` omits 48h delay value. | `ADR-0004 (L190–196)` enforces 48h Base delay; `ADR-0004 (L93–110)` off-chain gates disconnected from `§4.5`; `ADR-0004 (L218)` falsely says single-signer cancel. | **Internal `ADR-0004` Contradiction / Disconnect (`ARCH-06` — Medium)** |
| **Staged PRD Amendments (`one-vault-prd-amendments.md`)** | `§3 (L59–63)`, `§4 (L65–78)`, `§5 (L109–118)` explicitly track `D2`, `D8`, `PAXG`, and 4 unamended Step 3f PRD breaks (`L114` cites `§5 L303–309` for `docs/prd.md §6`). | **Timing bug in `§5 (L91)`:** says unfilled redemption shares return *"after the next settlement"* vs. `proposal.md §5.11.3 (L1052–1055)`, `RB-25 (L1522–1523)`, `E40 (L407)` (*"when that round ends"*). | **Tracked Open Work + `§5 (L91)` Timing Bug (`ARCH-07` — Low `[CORRECTED]`)** |
| **Roles, Upgrades & Verifier Exclusivity (`DEP-03`, `E47`)** | `§5.6 (L551)` puts `TARGET_SETTER_ROLE` on timelock; `§4 (L108)` shows `RECEIPT_SUBMITTER_ROLE`; UUPS upgrader unstated; `§14 (L2161 R-F4)` zero-default upgrade bug. | `§4 (L112)` & `§6 (L1385)` route via `RebalanceGovernance`; `DEP-03 (§5.11.9 L1353–1359)` & `E47 (L414)` omit exclusivity checks for `FLOW_ROLE`, `REBALANCER_ROLE`, `GOVERNANCE_ROLE`, `TARGET_SETTER_ROLE`, `RECEIPT_SUBMITTER_ROLE`, and UUPS upgrade authority. | **Role & Verifier Exclusivity Gap (`ARCH-08` — Medium `[EXPANDED]`)** |
| **`VaultRegistry` Removal & `G6` Gate** | `§6 (L1384, L1386)`, `§11 D4 (L1879)` drop `PortfolioRouter` & `VaultRegistry`. | `§13 G6 (L1948)` requires complexity counts & client surfaces not to expand; `§14 G6 (L2021)` is `Not run`. | **Unverified Experiment Gate (`ARCH-09` — Low / Open Question)** |
