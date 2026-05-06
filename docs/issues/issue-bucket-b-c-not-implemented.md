# Issue — Bucket B and Bucket C have no on-chain implementation; the CLI basket is a different product

> Summary: The roadmap (Phase 5 / Phase 8) and the website describe three allocation buckets: Bucket A (stable yield, via vault adapters), Bucket B (governance-selected agent tokens, 25%), and Bucket C (revenue-generating tokens, 25%). The deployed vault implements Bucket A only. Bucket B and C have no on-chain presence at any address. The CLI's 5% hardcoded basket sidecar is a client-side approximation of Bucket B at a different scale (5% vs. 25%) with no governance and no on-chain enforceability. Depositors expecting 50/25/25 allocation are currently receiving ~95/5/0.

## 1. Severity

**High for product completeness; low for current user safety.** No funds are at risk — the vault correctly holds and yields on USDC. But the advertised product is a three-bucket allocation protocol and only one bucket exists. The 5% CLI basket is explicitly not Bucket B: it is not in the vault, not governance-allocated, not weighted 25%, and its composition is hardcoded in a CLI binary rather than voted on-chain.

## 2. Background

Roadmap Phase 5:
> "Agent executes autonomous three-bucket allocation"
> "First weekly allocation vote with live vault rebalancing"

Roadmap Phase 8:
> "Bucket B (governance-selected agent tokens) and Bucket C (revenue liquid tokens) activation"

Website product page:
> "Bucket A (50%): Stable Yield — 3-6% APY on stablecoins"
> "Bucket B (25%): Diversified Agents — agent tokens selected through governance voting"
> "Bucket C (25%): Revenue Liquid Tokens — tokens selected via $ROBOTMONEY tokenholder voting: $10M+ market cap, 90+ days live"

### What the CLI basket is NOT

From `plugins/robotmoney-cli/skills/robotmoney-cli/references/basket.md`:
> "The basket is hardcoded — 6 agent tokens on Base. Composition changes only via a new release."

The CLI basket:
- Is 5% of a deposit (not 25%)
- Buys tokens off-chain via Uniswap UniversalRouter in a transaction the vault never sees
- Has a fixed composition that requires a new CLI release to change
- Has no governance mechanism
- Does not affect vault TVL
- Tokens land directly in the depositor's wallet, not in any shared bucket

It is a user-experience feature, not a protocol-level implementation of Bucket B.

## 3. What Bucket B/C implementation requires

**On-chain (new contracts or vault upgrade):**

Bucket B and C require an allocation mechanism that:
1. **Holds positions on behalf of depositors** — unlike the CLI basket where tokens land in the user's wallet, a shared-bucket design would hold positions in a managed strategy or pool.
2. **Reads governance-determined weights** — `bucketBWeightBps`, `bucketCWeightBps` settable by governance vote result.
3. **Routes deposit funds** — at deposit time, the vault splits assets across adapters (Bucket A) and routes the B/C share to a strategy or liquidity pool.
4. **Rebalances on vote execution** — when weekly governance changes Bucket B composition, a rebalance sells old tokens and buys new ones.

Design options (not exhaustive):
- **Sub-vault architecture**: Bucket B/C are separate ERC-4626 vaults whose shares the main vault holds. Composition is changed by the sub-vault admin.
- **Direct token holdings in vault**: The main vault holds basket tokens directly and tracks their value in `totalAssets()`. Requires a price oracle (Uniswap TWAP or Chainlink).
- **Delegated strategies**: The current delegated-strategy tracking (ZYFAI, Giza) is the closest existing approximation — positions held externally, tracked via API.

**Governance integration** is a prerequisite (see `issue-governance-vault-integration.md`). Without on-chain vote execution, there is no trustless way to change Bucket B/C composition.

## 4. Immediate action: correct the advertised allocation

Until Bucket B/C are implemented, the website and SKILL.md should state:
> "Current allocation: ~95% Bucket A (stable yield via Morpho/Aave/Compound), ~5% agent token sidecar (client-side, not governance-allocated). Target allocation of 50/25/25 is a Phase 5/8 deliverable."

This prevents depositors from making allocation decisions based on the target state rather than the current state.

## 5. Acceptance criteria

- Bucket B and C are implemented as on-chain mechanisms (exact architecture TBD per governance decision in Phase 2/5).
- Vault `totalAssets()` includes Bucket B/C positions.
- `get-vault` output surfaces per-bucket allocation (A/B/C weights and values).
- Governance vote outcomes are reflected in bucket weights on-chain.
- SKILL.md and website correctly describe current vs. target allocation until B/C are live.

## 6. References

- Roadmap Phase 5, Phase 8: https://www.robotmoney.net/changelog
- CLI basket (not Bucket B): [`../../plugins/robotmoney-cli/skills/robotmoney-cli/references/basket.md`](../../plugins/robotmoney-cli/skills/robotmoney-cli/references/basket.md)
- Vault source (Bucket A only): [`../../contracts/RobotMoneyVault.sol`](../../contracts/RobotMoneyVault.sol)
- Related: [`issue-governance-vault-integration.md`](issue-governance-vault-integration.md), [`issue-get-governance-missing.md`](issue-get-governance-missing.md)
