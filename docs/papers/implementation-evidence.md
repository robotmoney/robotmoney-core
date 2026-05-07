# Implementation Evidence for the Open Questions

Companion to `open-questions.md`. The questions there were derived from the three source documents in `docs/papers/`. This document does not answer them. It catalogs what the **deployed contract** (`contracts/RobotMoneyVault.sol`, deployed at `0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd` on Base mainnet), the **adapters** (`contracts/adapters/{Aave,Compound,Morpho}*.sol`), the **gateway** (`contracts/gateway/RobotMoneyGateway.sol`), and the repo's own product spec at `docs/prd.md` reveal about each question — so that readers can use the implementation as *one input* when deciding how to resolve the contradictions.

The code and repo PRD were reverse-engineered from a deployed demo contract. They show what was actually built, which is not necessarily what was intended, agreed, or final. Treat the evidence below as data, not as a verdict. In several places the code is *silent* on a question; that silence is itself worth noting but does not constitute an answer.

> Pointers in this document are file paths and section references. Readers can verify each claim directly.

---

## 1.1 One token or two?

**What the implementation shows.** No token contract is in this repo. The repo PRD (`docs/prd.md` §5.3) refers to `$ROBOTMONEY` as a single fixed-supply token, with no staking and no fee distribution to holders. There is no v1/v2 migration scaffolding anywhere.

**What that does and doesn't tell readers.** The repo's product narrative is consistent with the whitepaper's single-token model. It is not consistent with plan v4's `$RM v1`/`$RM v2` migration. But the absence of a token contract means the repo cannot rule out a future v2 — it simply doesn't reflect one. The decision is still open; readers should weigh the repo PRD's framing against plan v4's explicit migration path.

---

## 1.2 Vault: three-bucket from launch, or stables-first?

**What the implementation shows.** `RobotMoneyVault.sol` is an ERC-4626 vault whose asset is USDC. It holds a **flat array of strategy adapters** — no bucket A/B/C structure. The three deployed adapter types (Aave V3, Compound V3, Morpho) are all USDC stable-yield venues. The repo PRD §5.2 contains a notable claim:

> *"Bucket-B and bucket-C tokens land directly in the depositor's wallet at deposit time. The treasury custodies stable-yield positions only."*

**What that does and doesn't tell readers.** The vault as built only does Bucket A. Whether that's because (a) the team chose a stables-only treasury permanently and B/C are an off-treasury delivery layer (the repo PRD's framing), or (b) the team is shipping in phases with B/C to be added later (plan v4's framing), or (c) the whitepaper's three-bucket-in-vault model was abandoned in favor of (a) — the code alone cannot distinguish. The repo PRD §5.2 supports (a). Plan v4 is consistent with (b). The whitepaper is incompatible with both.

The decision readers face: is the "B/C delivered to depositor's wallet" design from the repo PRD intentional and final, or transitional?

---

## 1.3 Shortlist curation: top-down or bottom-up?

**What the implementation shows.** No governance contract is in the repo. The vault uses OpenZeppelin `AccessControl` with three roles: `ADMIN_ROLE`, `EMERGENCY_ROLE`, `KEEPER_ROLE`. Adapters are added/removed by ADMIN_ROLE. There is no on-chain proposal, vote, snapshot, or quorum logic. The repo PRD §7 says: *"The path from a vote to an admin action is bounded by the multisig operating within published constraints."*

**What that does and doesn't tell readers.** Whatever shortlist curation happens, it currently happens off-chain and is executed by a multisig. This is silence on the curated-vs-proposal-driven question, not an answer to it. Readers should treat this as: the implementation has not committed either way, and the choice is still genuinely open.

---

## 1.4 Voting mechanic: ranked choice or weighted bps?

**What the implementation shows.** No on-chain voting. Adapter target weights inside the vault are computed dynamically: `targetBps = MAX_BPS / activeAdapterCount` (`_targetBpsFor()`), with per-adapter `capBps` ceilings. No vote inputs feed into this calculation.

**What that does and doesn't tell readers.** The voting-mechanism question has no implementation footprint at all yet. Readers cannot infer a preference from absence. Whatever is decided will be a green-field design.

---

## 1.5 Tier system: yes or no?

**What the implementation shows.** The gateway implements **per-agent policies** via `authorizeAgent`: `maxPerPayment`, `maxPerWindow`, `validUntil`, `shareReceiver`. These are operator-set, not derived from `$RM` balance. There is no Observer/Participant/Analyst/Strategist mapping in the code.

**What that does and doesn't tell readers.** The repo's access control model is *operator-administered per-agent* rather than *balance-tier-gated*. This is a different axis from the source PRD's tier system — the source PRD's tiers gate posting, voting, and proposal rights, while the gateway gates deposit caps. The two could coexist (tiers for a CFO Feed and governance, per-agent policies for deposits). Readers deciding whether to keep the tier system should note it is not contradicted by the implementation; it is simply not built.

---

## 1.6 Vault structure: bucketed or flat?

**What the implementation shows.** The vault data model is flat: `AdapterInfo[] public adapters`. No bucket struct. Drift reporting (`getAdapterDrift`) is per-adapter. There is no monthly bucket-weight reweighting surface.

**What that does and doesn't tell readers.** As built, "buckets" exist only as a product narrative, not as a contract concept. Whether the bucket vocabulary is the right narrative for a flat multi-adapter vault, or whether the vault should grow a bucket layer to match the papers' framing, is a design decision the implementation does not make for readers.

---

## 1.7 Sequencing: what ships first?

**What the implementation shows.** The vault, adapters, and gateway are deployed (`README.md` cites a BaseScan address for the vault). No `$ROBOTMONEY` token contract, no governance contract, no CFO Feed code is in the repo.

**What that does and doesn't tell readers.** As of now, the *vault* shipped first. This contradicts the source PRD's premise (*"$RM token is live and trading … before the vault ships"*) and is consistent with the whitepaper's launch sequence. Readers should note: the source PRD's CFO-Feed-as-stopgap rationale presumes a state that has not occurred. Whether the team's next move is to launch the token, build the CFO Feed, or harden the vault is a roadmap decision the deployment alone doesn't reveal.

---

## 1.8 Customer wedge

**What the implementation shows.** The Rust client (`clients/rust-payment-client/`), the gateway's per-agent caps, the windowed limits, idempotent payment IDs, and encrypted-keystore signer — all of it is engineered for autonomous-agent USDC deposits. `docs/architecture.md` §1 names the access-layer goal explicitly: agents depositing USDC into the vault under bounded policy.

**What that does and doesn't tell readers.** The infrastructure investment to date is concentrated on the whitepaper's wedge (agents with idle USDC). It does not preclude the other wedges — there is just no code yet for a swap-into-USDC primitive (plan v4's de-risking flow) or for the CFO Feed (the source PRD's analytical-credibility wedge). Readers choosing a primary wedge should note: the as-built infra is committed to one of the three; the other two would each require new product surfaces.

---

## 2. Source-doc open questions, against the implementation

### 2.1 Legal entity → no on-chain reflection.

### 2.2 Performance fee → not implemented.
The vault charges only `exitFeeBps` (capped at 1% by `MAX_EXIT_FEE_BPS`). There is no management-fee accrual and no performance fee in the contract. The whitepaper's 2% management fee and the repo PRD §5.4's three-fee structure are not yet reflected in code.

### 2.3 Deposit caps → both global and per-deposit caps are present.
`tvlCap` and `perDepositCap`, both admin-settable; the gateway adds `maxPerWindow` and `maxPerPayment` per agent. The whitepaper's recommendation of a "$500K cap in Phase 2" is straightforwardly implementable with the existing setters.

### 2.4 Multi-chain → Base only.
Adapter addresses are Base-mainnet pinned. No CCIP, no LayerZero. A second chain would require new deployments.

### 2.5 Agent identity verification → split.
The vault itself is permissionless via the standard ERC-4626 `deposit`. The gateway, however, only accepts deposits from agent addresses that an operator has explicitly authorized via `authorizeAgent`. So the vault is permissionless and the gateway is allow-listed; both readings of the question can be true depending on the path used.

### 2.6 Plan-v4 immediate-decisions list →
- Direct integrations (custom adapters) for Aave V3, Compound V3, Morpho. No Compass Labs API in code.
- USDC is the vault's hardcoded asset.
- Agent persona: not in this repo.
- Tokenomics: token not yet deployed.
- Clanker terms: not yet relevant.
- `$RM v2` audit: no v2 in plan based on code presence (see §1.1).

---

## 3. Gaps from §3 — against the implementation

### 3.1 Quant-filter operationalization → off-chain. Not in code.

### 3.2 Bucket B trading → not in vault.
If the repo PRD §5.2 framing holds, B-token trading does not happen at the treasury layer at all. Position sizing, stop losses, and intra-trade NAV impact would live in whatever deposit-routing code delivers B/C tokens to the depositor — that code is not in this repo.

### 3.3 Prop-wallet accounting → no prop wallet exists yet.
With no token deployed, there is no buyback to fund and no prop wallet operating. The whitepaper's flywheel is a forward-looking design, not an active mechanism.

### 3.4 Multisig composition → not specified in code.
AccessControl admits role grants but says nothing about the multisig signer set or threshold. That is a deployment-time configuration, not a contract property.

### 3.5 Vault upgrade path → bytecode immutable, parameters mutable, strategy set mutable.
Hardcoded floors (`MAX_EXIT_FEE_BPS = 100`, `MAX_REBALANCE_BPS_CEILING = 5000`, `MIN_REBALANCE_INTERVAL_FLOOR = 1 hours`, `MAX_ADAPTERS = 20`) cannot be changed by any role. Configurable params (`tvlCap`, `perDepositCap`, `exitFeeBps`, `feeRecipient`, rebalance throttling) are admin-settable within those floors. Adapters can be added, recapped, removed, force-removed. There is no proxy. There is an irreversible `shutdownVault` flag. So "immutable contract" is true at the bytecode level and false at the strategy-set level. The whitepaper's blanket "immutable" claim and plan v4's "progressive expansion" claim are both partially right; neither matches the code exactly.

### 3.6 CFO Feed economics → not in this repo.

### 3.7 Withdrawal under drawdown → not a vault concern, given §3.2.
Vault redemptions pull proportionally from active stable-yield adapters and apply the exit fee. There is no asynchronous queue and no NAV haircut path; withdrawals are synchronous as long as adapter liquidity is available.

### 3.8 Inclusion-attack bounds → no on-chain attack surface today.
With no on-chain governance, the immediate attack surface is the multisig, not a vote tally. Once a token and on-chain voting exist, the question reopens.

### 3.9 Quorum cliff → no on-chain quorum logic.

### 3.10 Agent failure modes → strong operator override at the contract layer.
The vault provides `pause`/`unpause`, `emergencyWithdraw` (yanks all adapter balances and pauses), `emergencyWithdrawAdapter`, `forceRemoveAdapter`, and the irreversible `shutdownVault`. The gateway has its own pause and per-agent revocation. Admin and emergency powers are on roles held by humans/multisig — *not* on the protocol agent. The keeper role can call `rebalance()` but is bounded by hard ceilings. Whether this is *enough* operator surface for the agent-driven product narrative is a judgment call; the surface exists.

---

## 4. What patterns this evidence suggests, without committing to answers

A few things stand out across the evidence above. They are signals worth weighing — not findings.

1. **The vault as built is a stables-only multi-venue product.** Whatever is decided about Bucket B and C, the current treasury contract does not custody them. Any reader resolving §1.2/§1.6 has to either accept that as the design (per repo PRD §5.2) or plan a different vault for B/C exposure.

2. **There is no on-chain governance and no token.** Every governance-shaped question (§1.3, §1.4, §1.5, §3.8, §3.9) has zero implementation footprint. Decisions in those areas are unconstrained by existing code.

3. **The deployed sequencing inverts the source PRD's premise.** The PRD-paper assumed a token-without-vault state and proposed CFO Feed as a stopgap. The actual deployment is the opposite: vault-without-token. Readers re-evaluating the PRD-paper should ask whether its rationale survives the inverted sequencing.

4. **The repo PRD (§5.2 in particular) is the most decisive document about how the implementation is framed.** Where the three source papers conflict, the repo PRD's framing — vault-as-stables-engine, B/C delivered at deposit time, single token, multisig-mediated governance — is the closest to the as-built. Readers may want to treat the repo PRD as the de-facto v1 spec and the three source papers as inputs to a v2 reconciliation rather than treating any source paper as canonical.

5. **The implementation has quietly resolved some of the *gaps* in §3 by avoiding them.** Strong operator override (§3.10), per-agent caps (§3.4 partially), bounded keeper actions, and irreversible shutdown all reduce the attack surface relative to what the source papers describe. But this is risk-reduction by *what was not built* (no governance contract, no prop wallet, no token), so the gaps reopen as soon as any of those pieces ship.

These patterns are intended to help readers structure their own decisions — not to make those decisions for them.
