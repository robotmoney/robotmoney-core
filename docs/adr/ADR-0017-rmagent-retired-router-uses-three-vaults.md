# ADR-0017: rmAGENT is retired and the router routes across three vaults (rmUSDC, rmPROTO, rmRWA)

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Product owner
- **Supersedes in part:** [ADR-0001](ADR-0001-mvp-agent-token-shortlist.md) (the four-vault launch scope), [ADR-0015](ADR-0015-rm-parked-from-rmagent-until-market-depth.md) (decisions 2 to 4) and [ADR-0016](ADR-0016-bnkr-is-the-rmagent-test-asset-on-uniswap-v4-while-rm-is-parked.md) (in full)
- **Related:**
  - [ADR-0002](ADR-0002-router-default-weights-on-chain.md) (amended: the three-vault launch vector)
  - [ADR-0004](ADR-0004-agent-token-shortlist-governance.md) and [ADR-0005](ADR-0005-basketvault-multi-dex-routing.md) (stay Accepted for any future agent-token vault)
  - [ADR-0009](ADR-0009-vault-retirement-no-assisted-migration.md) (the retirement behaviour this ADR uses)
  - `docs/operations/contract-release-runbooks.md` section 4.14 (the governed retire batch)
  - `docs/code-review/20261022-code-review-internal-claude-retire-rmagent.md` (the gap list and the answers to the open unknowns)
  - core issue 1912, GitHub issue 1905 (multi-hop swaps, not a dependency)

## Context

The protocol is four vaults: rmUSDC, rmPROTO, rmAGENT and rmRWA. rmAGENT already carries weight 0 at launch (ADR-0002 amendment 2026-10-05, core 1580 and 1708). It is still router-eligible, so the router vector has four legs, and the stage table, the verifier, the frozen counts and the dependency manifest all describe a vault that holds no production weight.

Its only asset is a test asset. ADR-0015 parked RM out of rmAGENT. ADR-0016 listed BNKR so the Uniswap V4 swap adapter and the V4 price recorder could be tested end to end on a vault that carries no weight. Both decisions exist only to give rmAGENT a listing.

Owner request: "I think we need a /superfield-feature to deprecate the rmAgents vault, so that the router uses 3 vaults".

Owner decision (2026-10-22, verbatim): "rmAgent pre-0.6.0 will deprecate per its roles". Reading: the live pre-0.6.0 (v0.5.0) rmAGENT is deprecated through its governance roles, which is a Safe transaction through the timelock (ADR-0009: withdraw-only for existing holders). The 0.6.0 line carries three vaults.

## Decision

1. **The router routes across exactly three vaults: rmUSDC, rmPROTO and rmRWA.** The eligible set and the default vector have one entry per vault. The launch weights are rmUSDC 9500, rmPROTO 500, rmRWA 0 (sum 10000). The sheets carry `ELIGIBLE_VAULTS=PROTO,RWA` and `ROUTER_WEIGHTS=USDC:9500,PROTO:500,RWA:0`. `PortfolioRouter` needs no change: the default vector length equals `registry.routerEligibleCount()` (`_setDefaultWeights`), it is not a constant.
2. **rmAGENT is retired under ADR-0009.** Deposits are disabled, `redeem` and `redeemInKind` stay open for existing holders, router eligibility is false, the registry status is Retired, and there is no assisted migration. Nothing moves a holder's funds.
3. **The v0.6.0 line deploys no AgentTokenVault and no V4 price recorder.** The stage table, `VAULT_KEYS`, the sheet parser, the verifier (a three-leg default vector and a three-vault registry set), `pause-all`, the frozen counts and the dependency manifest describe three vaults. `contracts/script/DeployAgentTokenVault.s.sol`, `contracts/script/DeployUniswapV4PriceRecorder.s.sol`, the V4 adapter and `config/agent-token-shortlist.json` stay in the repository as parked code that no stage reads. The storage-layout gate keeps pinning the `AgentTokenVault` layout, because the live v0.5.0 rmAGENT runs it behind a governed proxy.
4. **The live v0.5.0 rmAGENT is retired by a governed configuration change, not a code change.** One timelock batch: `registry.migrateEligibility(rmAGENT, false, [rmUSDC, rmPROTO, rmRWA], [9500, 500, 0])` then `registry.retire(rmAGENT)`. The order is forced by the contracts: `retire` reverts `RetireWhileRouterEligible` while the vault is eligible, and the router reverts `LengthMismatch` unless the vector length equals the eligible count. The tool builds, previews and proves the batch (`govern --row retire-vault`, built from the `redeploy-vault` builders). This ADR does not schedule or run it. That is an owner-gated release step of runbook 4.14.
5. **RM and BNKR.** ADR-0015 decisions 2 to 4 and ADR-0016 do not survive as active decisions. BNKR is dropped. RM stays parked. The RM parking and its reactivation criteria move into the retired-vault note below. Reactivating RM now means a new vault, or `reactivate` on the retired rmAGENT, plus a new ADR.
6. **No bound is lowered.** `VAULT_AGENT_MIN_POOL_LIQUIDITY` stays 1e15 for any agent-token vault the parked scripts ever deploy again, and for the retired rmAGENT if it is reactivated. No guard, bound or executed-test floor is lowered, no test is skipped, and the storage layout is unchanged.
7. **ADR-0004 and ADR-0005 stay Accepted** for any future agent-token vault. No vault uses them while rmAGENT is retired. ADR-0002 gets an amendment with the three-vault launch vector.
8. **Issue 1905 stays open and is not a dependency.** Its candidate list (BNKR, RM, WOON, ZYFAI, JUNO) is rmAGENT-only. rmPROTO lists wETH and cbBTC on Uniswap V3 pools and needs no WETH-routed asset, so 1905 has no consumer today. This ADR does not edit it.

## The retired-vault note (rmAGENT)

- **Status of the contract.** On the live v0.5.0 deployment rmAGENT is Active and router-eligible at 0 bps until the batch executes. After it, the registry status is Retired and the vault's own `retired()` flag is set. `deposit` reverts (`maxDeposit` is 0), `PortfolioRouter` never routes into it, and `redeem` and `redeemInKind` keep working.
- **A holder exits two ways.** `redeem` pays USDC and reads the recorder (the TWAP and the 4 hour sell anchor), so it needs a recently recorded price. The recorder is permissionless: anyone can call `record()`, and `scripts/ops/recorder-keeper.sh` calls it. `redeemInKind` pays the asset with no oracle read and needs no keeper. Both stay open (ADR-0009, ADR-0007).
- **Unread balance.** Deposits were capped at 5 USDC per deposit and 20 USDC TVL. The live balance of the v0.5.0 rmAGENT is not in this repository, so it is read on chain before the batch is scheduled (runbook 4.14, step 1). If it holds BNKR, the holders redeem. `emergencyUnwind` and `removeAsset` are separate owner decisions and are not part of this change.
- **Reactivation criteria for RM (moved from ADR-0015).** Dollars at the live price, measured at one Base block: in-range USDC reserve of the RM/USDC pool at least $5,000 and at least 48 times the per-deposit cap; at least $1,000 of volume on each of the last 7 days; pool price within 5 percent of the price implied by the RM/WETH market; and a raw liquidity guard of 1e15 or higher (about 2.9e15 at the measured price). Meeting them is not enough on its own: the way back is a new vault, or `reactivate`, and a new ADR.
- **BNKR.** The test asset is dropped. The 5 USDC per-deposit cap and the 20 USDC TVL cap in `deployments/base-8453-rehearsal/deploy-3.env` describe the live v0.5.0 line only.

## Presentation of a retired vault (proposal)

- **Dapp.** A retired vault is shown as a withdraw-only card: the badge says Retired, the deposit form is disabled, the line reads "This vault is retired and takes no deposits. Withdraw and redeem stay open." (already the text of `vaultDepositState`). A holder's position keeps its Withdraw tab and the in-kind hint. The router deposit lists three legs and never an rmAGENT leg.
- **Explorer.** The explorer API returns the vault with `status` 2 (Retired) and `deposits_paused` as read. It is not hidden, because holders still need to see the position.
- **rmpc and the gateway.** A depositor's agent policy names its own allowed destinations. No gateway allow-list and no agent policy of the repository names rmAGENT. The docs and tests of rmpc and the gateway that named an rmAGENT destination name rmPROTO or rmRWA instead.

## Receipts

The consensus receipt schema keeps the `agent_tokens` bucket. It is the cross-repository contract of the Investment Committee (`tests/fixtures/consensus-receipt.bucket-vault-map.json`, the PRD section 11 catalog). The bucket maps to no vault now. `apply-receipt` accepts it at 0 bps and drops it from the vector, and refuses it with any weight. The deployment record (`schemas/fusion-stage-record.schema.json`) requires three vault addresses and treats `rmAGENT` as optional, present only on a deployment of the v0.5.0 line.

## Rejected options

- **Keep rmAGENT eligible at 0 bps.** The router vector keeps four legs, and every tool carries a vault that holds no production weight.
- **Delete the vault code.** The live v0.5.0 rmAGENT runs it, and a governed upgrade needs its layout and its source.
- **Migrate holders.** ADR-0009 forbids an assisted migration, and a user-signed redeem at the app layer is the only exit.
- **Change `PortfolioRouter` or `VaultRegistry`.** Neither needs it. A configuration batch retires the vault.

## Consequences

- A new deployment has three vaults, one fewer stage (`agent`) and one fewer contract (the recorder). The frozen counts of a new release lose the `agent` and `recorder` counts, and the dependency manifest loses the shortlist file.
- The v0.5.0 line is unchanged. It is retired through the Safe and the timelock, and its tooling stays at the v0.5.0 tag.
- The Twin proves the retire batch end to end on a four-vault populated deployment before anything is scheduled on Base.
- The gap list and the answers to the open unknowns are in `docs/code-review/20261022-code-review-internal-claude-retire-rmagent.md`.
