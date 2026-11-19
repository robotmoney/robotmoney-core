# ADR-0019: Fund swap adapters run behind governed UUPS proxies, vetted by proxy and implementation code hash

- **Status:** Accepted
- **Date:** 2026-11-19
- **Deciders:** Product owner
- **Supersedes in part:** [ADR-0014](ADR-0014-governed-uups-upgrades-and-freeze.md) and `docs/technical/contract-upgradeability-plan.md` where they keep every adapter a direct deployment. The no-proxy rule stays for lending (strategy) adapters.
- **Related:**
  - `docs/technical/security-model.md` (adapter rows), `docs/architecture.md` (proxy invariant)
  - `docs/technical/one-vault-timed-flows-eng-plan.md` E43 (fixed-fee pools only), `docs/technical/one-vault-rebalancer-proposal.md` §4.5 rule 6
  - `docs/runbooks/contract-qa/releases/v0.9.0-onevault-upgrade.yaml` (the Deploy 4 in-place upgrade)

## Context

The v0.9.0 queue's `setFlowParams` asks every funded basket asset's swap adapter `isFixedFeePool(pool)` (E43). Deploy 4's live Uniswap adapter (`0xd077628B001C71d97443750aEC9e2aE62e6C98db`, runtime hash `0x98c15bc7…b142ef`) was deployed before that call existed. It has no answer, so the call reverts `FlowParamOutOfBounds(14)`. The pools are Uniswap V3 pools with immutable 500-pip fees, so the rule holds. Only the adapter cannot say so.

Adapters were direct deployments. The fund binds an asset to its adapter only at `addAsset`. Changing it meant delisting the asset, which sells the position on chain, and adding it again.

Owner, 2026-11-19: adapters should be upgradeable. "I would rather not roll our own upgradeability if openzeppelin has hardened this." The owner chose to pin both the proxy and the implementation code hash over trusting the timelock alone.

## Decision

1. **Swap adapters for basket assets run behind an ERC-1967 proxy with the repo's `GovernedUUPS` base** (OpenZeppelin `ERC1967Proxy`, `Initializable`, `ERC1967Utils`). The upgrade authority is the fund system's Safe-controlled timelock, written once at initialization, the same as for the fund and queue. `freezeUpgrades` is available as for every governed proxy.
2. **The fund vets a proxy adapter by two code hashes.** The fund keeps a second allowlist, `adapterProxyCodeHash`, of the proxy runtime hashes it treats as proxies (`setAdapterProxyCodeHash`, ADMIN_ROLE, so the timelock). An adapter whose code hash is on both lists must report its ERC-1967 implementation (`implementation()`), and that implementation's code hash must be on `codeHashAllowed` and not itself a proxy hash. An adapter upgrade therefore needs two governed steps: allow the new implementation hash, then upgrade the proxy. A proxy whose implementation is not allowed is refused at the next use.
3. **The check runs on every use of a basket swap adapter**: admission (`addAsset`), the adapter swap (`setAssetAdapter`), every swap, every TWAP price read, and the fixed-fee check (E43). A failed check reverts `AdapterCodeHashNotAllowed(adapter, hash)`.
4. **`setAssetAdapter(index, adapter)`** (ADMIN_ROLE, so the timelock) points an active basket asset at another vetted adapter. The new adapter must report the asset's pool as fixed-fee (E43) and the fee band must still fit (`requireBasketFeeAdmission`). It moves no tokens: a swap adapter holds none between calls. It is allowed while a plan is live, for that reason. Lending assets are refused: their adapter holds the fund's deposit.
5. **Lending adapters stay direct deployments.** They hold the fund's position, and their replacement path stays revoke-and-exclude (ADP-2) into the `ExclusionLedger`.

## Consequences

- Deploy 4 leaves its legacy adapter in the v0.9.0 upgrade: deploy the new adapter implementation and its proxy, allow both hashes, mark the proxy hash, then `setAssetAdapter` for each basket asset before `setFlowParams` (P3.80).
- The implementation hash is what the proxy's own code reports. A malicious implementation could misreport it, but it can only be installed by the timelock that also controls the allowlist. The pin makes every upgrade an explicit, reviewed allowlist change.
- Each swap and price read costs two extra `EXTCODEHASH` reads and one `implementation()` call for a proxy adapter.
- The fund's storage gains one mapping, appended to `FundState` (layout gate: append-only).
