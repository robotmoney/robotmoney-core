# ADR-0004: Agent-token shortlist governance mechanism (production, router-eligible)

- **Status:** Accepted
- **Date:** 2026-06-03
- **Deciders:** Product owner
- **Related:**
  - `docs/technical/basket-vault-gap-report.md` §Eligibility-requirement-9, Appendix C
  - `docs/development/open-questions.md` §1.3, §1.4
  - `docs/adr/ADR-0001-mvp-agent-token-shortlist.md`
  - `docs/prd.md` §2, §11.3

## Context

ADR-0001 established that the MVP agent-token vault shortlist is hand-picked by
the product owner and managed via the existing Safe → TimelockController →
`ADMIN_ROLE` path with no separate token-holder vote. ADR-0001 explicitly deferred
the production governance model as out of scope for MVP and noted that the vault
"is not Router-eligible until shortlist governance ... [is] specified."

`docs/technical/basket-vault-gap-report.md` Appendix C formalises this gap as a
blocking requirement. It names four candidate models:

| Option | Summary |
|---|---|
| A. Admin multisig (current) | N-of-M multisig controls `addAsset`/`removeAsset`. No further governance. |
| B. RM-token inclusion vote | `$RM` holders propose and vote via an on-chain module. |
| C. Bribery/incentive mechanism | Token projects pay a fee to nominate; `$RM` holders vote on ranked inclusion. |
| D. Protocol-agent curation with timelock | Off-chain agent proposes; changes queue behind a timelock with a community veto window. |

The production model must satisfy `docs/prd.md` §2 (transparent-performance
requirement) and be implementable without introducing a parallel governance
contract surface before the Real-four-vault demo milestone.

## Decision

### Chosen model: Admin multisig + mandatory timelock with public veto window (Option A extended)

The production shortlist governance model **extends Option A** by imposing a
**mandatory on-chain timelock delay** on every `addAsset` and `removeAsset`
call, combined with a **published veto window** during which any observer may
raise a challenge before execution.

The model uses the existing `TimelockController` already deployed as the holder
of `ADMIN_ROLE`. No new governance contract is required. The Safe (≥2-of-3
multisig) queues every shortlist change through `TimelockController.schedule()`;
the change executes only after the timelock delay has elapsed.

This model was chosen over the alternatives for the following reasons:

- **Option B (RM-token vote)** requires a voting contract and `$RM` token-vote
  mechanics that are not yet specified (open-questions §3.9). Implementing it
  before the demo is not feasible and introduces significant scope.
- **Option C (bribery)** is explicitly flagged as future spec work in the gap
  report. It adds fee-collection, bribery-escrow, and ranked-vote logic — all
  unspecified.
- **Option D (protocol-agent curation)** adds off-chain agent-failure risk as a
  new attack surface and requires a separate agent-liveness dependency. The Safe
  signers already have operational accountability; adding an agent layer before
  that accountability is modelled is premature.
- **Option A extended** satisfies the transparent-performance requirement
  (all shortlist changes are observable on-chain before execution), uses
  the existing contract surface, and imposes a real-time delay that allows
  stakeholders to react before execution.

### Timelock parameters

| Parameter | Value | Rationale |
|---|---|---|
| Minimum delay for `addAsset` | 48 hours | Long enough for stakeholders to observe the pending change and raise a public challenge before the token appears in the vault. |
| Minimum delay for `removeAsset` | 24 hours | Removal is lower-risk than addition (no new exposure); a shorter window is sufficient. |
| Maximum shortlist size | 15 tokens | Inherited from PRD §11.3 cap. The `AgentTokenVault` contract enforces this via `maxAssets`. |
| Timelock executor | Safe (≥2-of-3) | No change from current configuration. The Safe must also be the `TimelockController` proposer. |
| Canceller | Any Safe signer (unilaterally) | Any single signer may cancel a queued change before execution, providing a low-friction veto path within the multisig. |

### Veto / challenge path

During the timelock delay window:

1. **Off-chain observation:** any observer (community member, protocol monitor,
   competing token project) may inspect the pending `TimelockController` queue
   via on-chain event `CallScheduled(id, target, value, data, predecessor, delay)`
   and decode the `addAsset` or `removeAsset` call parameters.

2. **Public challenge:** observers raise challenges via the protocol's
   public governance forum (off-chain). The Safe signers are expected to cancel
   the queued change (`TimelockController.cancel(id)`) if the challenge reveals
   the token fails the gate criteria (see `addAsset` gate additions below).

3. **Unilateral Safe cancellation:** any one Safe signer may call
   `TimelockController.cancel(id)` at any time before execution, stopping the
   change without requiring a full quorum. This is the cheapest veto path.

4. **Future upgrade path:** if the protocol adopts `$RM` token voting (Option B),
   the `TimelockController` `CANCELLER_ROLE` can be extended to a token-vote
   veto module without redeploying the vault. This upgrade path is reserved but
   not implemented now.

### `addAsset` gate additions

Before proposing a new token via `TimelockController.schedule()`, the Safe must
verify all of the following criteria. Verification is off-chain at proposal time;
the criteria are published in this ADR as the canonical gate:

| Gate | Requirement | Rationale |
|---|---|---|
| Market-cap floor | ≥ $10M 30-day trailing average | Filters micro-caps with severe liquidity risk. Aligns with PRD §11.3 quant-filter intent. |
| Listing age | ≥ 90 days on-chain (Base or bridged) | Prevents newly launched tokens from bypassing price-discovery risk. |
| Daily volume floor | ≥ $100K 30-day trailing average | Ensures the vault can enter/exit positions without significant market impact. |
| Holder count | ≥ 500 distinct holders | Basic distribution requirement; filters team-held or wash-traded tokens. |
| Oracle availability | Uniswap V3 pool on Base with ≥ 30-day TWAP history for the USDC pair, or a Chainlink feed with ≥ 30-day history | Required for TWAP pricing once the oracle ADR is implemented. Without an oracle, the vault cannot value the position. |
| Liquidity depth | ≥ $50K within 2% of mid-price on the primary Uniswap V3 pool | Synchronous-redemption guarantee requires the vault to exit a position without exceeding 300 bps slippage. |

Gate evidence is recorded in the `TimelockController.schedule()` transaction
calldata or a linked off-chain hash (IPFS CID or governance-forum post URL).
The Safe signers attest to gate satisfaction at proposal time.

### Attack economics

**Scenario 1: Malicious token inclusion**

An attacker controls a token project and wants to include a malicious or
worthless token in the shortlist to drain vault funds or inflate apparent TVL.

- The attacker must convince ≥2 of 3 Safe signers to propose the token.
  Assuming signers are independent, the attacker must compromise or bribe at
  least 2 signers simultaneously.
- If the attacker bribes signers, the bribe must exceed the signers' expected
  future income from the protocol, which grows with AUM. At $1M AUM and a
  notional 0.5% fee share, the annual value at stake per signer is ≥$1,667.
  The bribe must outcompete this on a net-present-value basis over the
  signer's expected tenure.
- The 48-hour timelock window allows the community to observe and challenge
  before execution. Even a successful 2-of-3 compromise would be visible
  on-chain before the malicious token enters the vault.
- **Attack cost at current scale:** low (small-team protocol; signers are
  likely known and accountable). **Mitigant:** named, accountable signers
  and public timelock reduce the viable attack surface to collusion + reputational
  destruction.

**Scenario 2: Low-value or illiquid token (inadvertent)**

A token passes the signer review but fails the liquidity or volume gate in
practice (e.g., volume spikes before proposal, drops after inclusion).

- The gate criteria are evaluated at proposal time, not continuously. A token
  that passes the gate and then loses liquidity remains in the shortlist until
  `removeAsset` is proposed and executed (24-hour delay).
- **Impact:** during a redemption while the illiquid token is in the basket, the
  vault may execute a swap at worse than 300 bps slippage, violating the
  synchronous-redemption guarantee.
- **Mitigant:** the vault's slippage cap (300 bps for AgentTokenVault) will
  revert the swap if slippage exceeds the cap, protecting depositors. The
  redemption blocks until the token is removed or liquidity recovers.
  The `removeAsset` admin path (24-hour delay) allows rapid response.

**Scenario 3: Griefing via spam proposals**

An attacker (or a corrupted signer) floods the `TimelockController` with
invalid `addAsset` proposals to consume Safe gas and operator attention.

- Each proposal requires ≥2-of-3 Safe signers to sign, making spam proposals
  expensive for an external attacker.
- A corrupted single signer cannot propose unilaterally (Safe threshold ≥ 2).
- **Attack cost:** at current gas prices on Base (≈ $0.01–0.10 per L2
  transaction), the gas cost alone is negligible. The real cost is social:
  each proposal requires at least 2 signers to sign and the community to
  evaluate it. Spam proposals would rapidly erode Safe signer credibility.
- **Conclusion:** griefing via proposals is not economically motivated;
  it harms the attacker's reputation without meaningfully harming the protocol.

## Consequences

**Positive.**

- The production shortlist governance model is implementable today using the
  deployed `TimelockController` with no new contracts.
- All shortlist changes are observable on-chain before execution, satisfying
  the transparent-performance requirement (`docs/prd.md` §2).
- The veto path is cheap (single Safe signer can cancel) and accessible
  (any observer can raise a challenge).
- The upgrade path to token-vote veto (Option B) is preserved without
  commitment.
- Resolves gap-report Appendix C blocking item. AgentTokenVault (rmAGENT)
  may proceed to router-eligibility once the TWAP oracle, rebalancing model,
  and liquidity proof gaps are also resolved.

**Negative / accepted risks.**

- Gate verification is off-chain and attestation-based. A compromised
  Safe could include a token that fails the gate; the only recourse is
  on-chain cancellation during the veto window.
- The 48-hour delay for `addAsset` slows legitimate shortlist updates.
  A token that gains rapid community support still waits 48 hours from
  proposal to inclusion.
- The governance model is still trust-centralized relative to a full
  token-vote model (Option B). This is accepted for the Real-four-vault demo
  phase; the upgrade path is documented.

**Out of scope of this decision.**

- RM-token weighted voting beyond what eligibility requires (Option B full
  implementation).
- Bribery/incentive mechanism (Option C).
- Protocol-agent curation (Option D).
- TWAP oracle source (separate ADR, gap-report Appendix A).
- Synchronous redemption guarantee implementation (gap-report §2–3).
- Liquidity proof process (gap-report Resolution Order §4).
- Intra-vault rebalancing — resolved by ADR-0003.

## Implementation checklist (for Phase A implementation issue)

- [ ] Confirm deployed `TimelockController` minimum delay is ≥ 48 hours, or
  queue an admin transaction to increase it to 48 hours before router registration.
- [ ] Document the `addAsset` gate criteria in the protocol operator runbook
  (`docs/development/` or `docs/technical/`).
- [ ] Add gate criteria reference to `AgentTokenVault` NatSpec on `addAsset`.
- [ ] Add a `ShortlistChangeProposed` event (or rely on `TimelockController`'s
  `CallScheduled` event) and document it in the dapp monitoring spec.
- [ ] Update `docs/development/open-questions.md` §1.3 and §1.4 to mark this
  question resolved and link this ADR.
