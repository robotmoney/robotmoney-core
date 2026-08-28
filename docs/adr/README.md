# Architecture Decision Records

Each ADR records a single non-obvious decision: the context, the choice
that was made, and the consequences. ADRs are append-only; supersede an
old ADR with a new one rather than rewriting history.

File names follow `ADR-NNNN-short-kebab-title.md`.

| # | Title | Status |
| --- | --- | --- |
| 0001 | [MVP agent-token shortlist is hand-picked, not quant-filtered](ADR-0001-mvp-agent-token-shortlist.md) | Accepted |
| 0002 | [Router default weights live on-chain, not derived from the front-end](ADR-0002-router-default-weights-on-chain.md) | Accepted |
| 0003 | [Slippage-adjusted basket-vault previewRedeem/previewDeposit (worst-case floor)](ADR-0003-slippage-adjusted-basket-vault-preview.md) | Accepted |
| 0003 | [BasketVault rebalancing model — trigger, target weights, cost disclosure](ADR-0003-basketvault-rebalancing-model.md) | Accepted |
| 0004 | [Agent-token shortlist governance mechanism enabling rmAGENT router-eligibility](ADR-0004-agent-token-shortlist-governance.md) | Accepted |
| 0005 | [BasketVault multi-DEX routing — per-asset venue abstraction for Aerodrome and Uniswap V4](ADR-0005-basketvault-multi-dex-routing.md) | Accepted |
| 0006 | [deSPXA RWA vault — asset, Chronicle oracle, Aerodrome swap-only entry/exit, freeze risk](ADR-0006-despxa-rwa-vault-design.md) | Accepted |
| 0007 | [Basket-vault drawdown redemption policy — NAV haircut at current per-share NAV](ADR-0007-basket-vault-drawdown-redemption-policy.md) | Accepted |
| 0008 | [AgentTokenVault trading authority and strategy — deferred indefinitely (non-goal)](ADR-0008-agent-token-vault-trading-authority.md) | Accepted |
| 0009 | [Vault retirement — no on-chain migration; withdraw-only is the production behavior](ADR-0009-vault-retirement-no-assisted-migration.md) | Accepted |
| 0010 | [Unified Vault architecture — one Vault class, position adapters for every theme](ADR-0010-unified-vault-architecture.md) | Proposed |
| 0011 | [Fork tests run against checked-in golden fixtures on every merge; live drift is a non-blocking nightly](ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md) | Accepted |
| 0012 | [Ed25519 is the default identity algorithm; secp256k1 is confined to the EVM boundary; one keystore primitive serves both curves](ADR-0012-dual-curve-identity-policy.md) | Accepted |
