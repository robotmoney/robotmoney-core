# ADR-0001 — MVP AgentTokenVault shortlist

- Status: Accepted
- Context docs: `docs/prd.md` §11.3 (Agent Token Vault); `docs/development/open-questions.md` §1.3 (shortlist ownership), §3.1 (quant-filter methodology); `docs/technical/basket-vault-gap-report.md`

## Context

`AgentTokenVault` (`contracts/vaults/AgentTokenVault.sol`) ships an
admin-curated, equal-weight basket of agent-economy tokens. The contract
accepts an arbitrary ADMIN_ROLE-curated shortlist, but no canonical MVP
configuration exists in code or in the demo seed. The demo deploy chain
(`contracts/script/DeployDemoExtraVaults.s.sol`) therefore stands the vault
in with `RobotMoneyVault` placeholders and a comment marking it
"ADR-blocked".

Two distinct blocks have historically been conflated:

1. **Shortlist ownership** — who decides which tokens are in the basket
   (`open-questions.md` §1.3). The long-term model (token-holder inclusion
   vote vs. bribery flow vs. quant filter) is unresolved.
2. **Router eligibility** — whether `AgentTokenVault` may receive Portfolio
   Router weight. This is gated by the basket-vault gap report (TWAP
   hardening, slippage-bounded `previewRedeem`) and is independent of the
   shortlist question.

This ADR resolves only the **shortlist-side** block for the MVP.

## Decision

For the MVP, the `AgentTokenVault` shortlist is a hand-picked, six-token,
equal-weight basket curated by ADMIN_ROLE through the existing
Safe → Timelock → ADMIN_ROLE path:

| Symbol     | Notes                       |
| ---------- | --------------------------- |
| JUNO       | Base mainnet                |
| ROBOTMONEY | Base mainnet (protocol token) |
| BANKR      | Base mainnet                |
| ZYFAI      | Base mainnet                |
| GIZA       | Base mainnet                |
| DEUS       | Base mainnet                |

- Base-only. PEAQ is **excluded** (not natively on Base).
- Equal-weight at deposit time, enforced by `BasketVault._routeDeposit`.
- Token addresses live in `config/` (see
  `config/agent-token-shortlist.json`), never hardcoded in Solidity source.
- Devnet/test deploys substitute stand-in ERC20s via a devnet override map,
  selected by chain id.

### Explicitly deferred past MVP

- Token-holder inclusion vote, bribery flow, quorum / displacement, and the
  15-token-cap machinery (`open-questions.md` §1.3, §1.4).
- The quant-filter analytics ($10M mcap / 90d / $100K volume / 500 holders)
  and its measurement methodology (`open-questions.md` §3.1).
- Marking `AgentTokenVault` Router-eligible — still blocked by the
  basket-vault gap report (TWAP hardening, slippage-bounded `previewRedeem`).

## Consequences

- A demo visitor sees `AgentTokenVault` populated with the six MVP tokens,
  equal-weighted, sourced on-chain via `AgentTokenVault.shortlist()`.
- ADMIN_ROLE may add / remove / swap shortlist entries; there is no
  token-holder vote or bribery surface in the MVP.
- `AgentTokenVault` remains PROTOTYPE-labeled and is not Router-eligible
  until the basket-vault gap closes.
