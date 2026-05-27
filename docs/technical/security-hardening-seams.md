# ADR — Security hardening seam map

> Scope: dev-scout report for issue #434, covering the Security hardening
> phase in `docs/implementation-plan.md`. This report is documentation only:
> no allowlist, eligibility, unwind, dapp, or signer behaviour changes are
> introduced here.
>
> Canonical inputs: `docs/technical/security-model.md`, `docs/architecture.md`, and
> `docs/implementation-plan.md`.

## 1. Status

Accepted for implementation planning. Authored 2026-05-19 against the current
contracts, dapp, and `rmpc` surfaces.

## 2. Shared-file pressure

| Downstream issue | Primary files | Shared pressure |
| --- | --- | --- |
| #425 adapter allowlist | `contracts/RobotMoneyVault.sol`, adapter tests, deploy scripts | Adds approval checks on `addAdapter`, and must ensure `_routeDeposit`, `rebalance`, and `adminRebalance` cannot allocate to an ineligible adapter. |
| #426 router vault eligibility | `contracts/VaultRegistry.sol`, `contracts/PortfolioRouter.sol`, router tests, generated dapp ABI | Adds router-specific eligibility state or checks that are distinct from registry lifecycle status. |
| #427 prototype basket vault exclusion | `contracts/vaults/BasketVault.sol`, `contracts/vaults/AgentTokenVault.sol`, `contracts/PortfolioRouter.sol`, deploy/config tests | Must reuse the #426 router eligibility gate instead of adding a second router exclusion mechanism. |
| #428 emergency unwind guard | `contracts/vaults/BasketVault.sol`, basket vault tests, operator docs | Adds minimum-output storage and events to the basket vault emergency path. |
| #429 withdrawal policy risk display | `contracts/gateway/interfaces/IGateway.sol`, `contracts/gateway/RobotMoneyGateway.sol`, `clients/dapp/src/components/*`, `clients/rust-payment-client/src/commands/*` | Reads existing withdrawal fields and allowances; should not change gateway authorization semantics. |
| #430 production signer backend | `clients/rust-payment-client/src/signer/*`, `clients/rust-payment-client/src/config.rs`, `clients/dapp/src/lib/configExport.ts`, docs | Adds environment-aware refusal for software signing and labels software exports as non-production. |
| #431 bundled faucet key guard | `clients/dapp/src/lib/faucetClient.ts`, chain classifier, Vite/env validation, `.env` docs | Independent from contract changes; shares only dapp build/test lanes with #429. |

The only high-conflict pair is #426/#427. Both must land on a single
Portfolio Router eligibility gate, and #427 must not create a parallel
prototype-vault blocklist in router deposit code.

## 3. Adapter allowlist decision for #425

Adapter allowlist state belongs in `RobotMoneyVault`, not in `VaultRegistry`
and not in a new `AdapterRegistry` contract for this phase.

The adapter surface is vault-internal: `RobotMoneyVault.addAdapter` registers an
`IStrategyAdapter`, `_routeDeposit` allocates idle USDC to active adapters,
`rebalance` and `adminRebalance` move assets between adapters, and emergency
paths withdraw or force-remove adapter entries. `VaultRegistry` is an outer
product registry of ERC-4626 vaults for router, dapp, `rmpc`, and indexer
discovery. Extending it with strategy-adapter approvals would mix vault-internal
strategy custody with product-level vault discovery and would make every vault
adapter change a registry concern.

Implementation contract:

```solidity
mapping(address => bool) public adapterAllowed;
mapping(bytes32 => bool) public adapterCodeHashAllowed;

event AdapterAllowedSet(address indexed adapter, bool allowed);
event AdapterCodeHashAllowedSet(bytes32 indexed codeHash, bool allowed);

error AdapterNotAllowed(address adapter);
error AdapterCodeHashNotAllowed(address adapter, bytes32 codeHash);
```

`addAdapter(address adapter, uint16 capBps)` should require both:

1. the adapter address is explicitly allowed for this vault, and
2. `adapter.codehash` is approved for the expected implementation family.

The address allowlist lets operators approve exact deployed adapter instances.
The code-hash allowlist prevents an approved address entry from being used for
an unexpected implementation in tests and deployment scripts. Devnet
`PassthroughAdapter` can be allowed by deployment profile, but production deploy
scripts must not approve devnet-only adapter code hashes.

Allocation code should treat the `active` flag as necessary but not sufficient:
any path that can send USDC to an adapter (`_allocateTo`, `rebalance`,
`adminRebalance`) should either rely on the `addAdapter` invariant or re-check
the adapter allowlist before transfer. Emergency withdrawal and force-removal
must remain available for already-active adapters even if a later governance
transaction removes that adapter from the allowlist.

## 4. Portfolio Router eligibility gate for #426 and #427

Router eligibility is a separate contract-level concept from registry lifecycle
status. Registry status answers whether a vault is active, paused, or retired
for discovery. Router eligibility answers whether a vault may receive
Portfolio Router deposit flow.

Use `VaultRegistry` as the storage owner for router eligibility so dapp, `rmpc`,
indexer, governance, and router all read one source of truth:

```solidity
enum RouterEligibility {
    Ineligible,
    Eligible,
    PrototypeOnly
}

mapping(address => RouterEligibility) public routerEligibility;

event RouterEligibilitySet(
    address indexed vault,
    RouterEligibility oldEligibility,
    RouterEligibility newEligibility,
    bytes32 reason
);

error VaultRouterIneligible(address vault, RouterEligibility eligibility);
error VaultAssetMismatch(address vault, address expectedAsset, address actualAsset);
```

`VaultRegistry` should expose `setRouterEligibility(address vault,
RouterEligibility eligibility, bytes32 reason)` behind `ADMIN_ROLE`. The setter
must reject unknown vaults. For `Eligible`, it should verify ERC-4626
`asset() == metadata.asset`, and issue #426 should require `metadata.asset ==
PortfolioRouter.usdc()` when the router sets weights or deposits.

`PortfolioRouter.setWeights` and the live deposit path should reject any
weighted vault whose registry eligibility is not `Eligible`. `previewDeposit`
should mark non-eligible legs unavailable with a machine-readable reason, but
live deposits should revert all-or-nothing as required by `docs/architecture.md`
§4.2.

#427 should mark `BasketVault`, `ProtocolAssetVault`, and `AgentTokenVault`
production deployments as `PrototypeOnly` until TWAP/liquidity hardening is
complete. Devnet/test fixtures may set `PrototypeOnly` or use a test-only
override, but production router weights must require `Eligible`.

## 5. Emergency unwind storage layout for #428

`BasketVault` currently holds basket assets in `assets[]` and calls
`SWAP_ROUTER.exactInputSingle` from `emergencyUnwind()` with
`amountOutMinimum: 0`. Add storage after the existing BasketVault configuration
fields only; do not insert into the middle of existing storage:

```solidity
struct EmergencyUnwindGuard {
    uint256 minUsdcOut;
    bool overrideAllowed;
}

mapping(address => EmergencyUnwindGuard) public emergencyUnwindGuard;

event EmergencyUnwindGuardSet(
    address indexed token,
    uint256 oldMinUsdcOut,
    uint256 newMinUsdcOut,
    bool overrideAllowed
);

event EmergencyUnwindOverrideUsed(
    address indexed token,
    uint256 amountIn,
    uint256 minUsdcOut,
    address indexed caller
);
```

Default path: `emergencyUnwind()` uses `emergencyUnwindGuard[token].minUsdcOut`
as the `amountOutMinimum` for each active basket asset and reverts or records a
failed leg when router output is below the guard.

Explicit high-risk path: if retained, make it a separate function such as
`emergencyUnwindWithOverride(address[] tokens)` gated by `EMERGENCY_ROLE` and
`overrideAllowed == true` per token. It must emit `EmergencyUnwindOverrideUsed`
before the swap so operators and indexers can distinguish guarded emergency
unwinds from high-loss overrides.

## 6. Dapp policy risk hookpoints for #429

The gateway already exposes withdrawal-specific policy fields:
`assetRecipient`, `maxWithdrawPerPayment`, `maxWithdrawPerWindow`, and
`allowedSourceVaults`, plus `agentWithdrawWindowGross(agent, windowId)`.
`rmpc withdraw` already reads vault share allowance and balance before signing.

Dapp hookpoints:

- `clients/dapp/src/lib/preview.ts`: extend authorize/set-policy preview risk
  classification when `assetRecipient != address(0)` or withdrawal caps are
  non-zero.
- `clients/dapp/src/components/AuthorizeTab.tsx` and rotation/onboarding policy
  composers: surface withdrawal-enabled state before signing policy creation or
  update.
- `clients/dapp/src/components/AgentPoliciesPanel.tsx`: show
  `assetRecipient`, source-vault scope, active window usage, and a stale
  gateway share allowance warning.
- Vault/share-token approval UI: add a revoke path for gateway share allowance
  where the selected source vault receipt token reports a non-zero allowance.

`rmpc` hookpoints:

- `clients/rust-payment-client/src/commands/self_check.rs`: include withdrawal
  exposure when policy enables withdrawals.
- `clients/rust-payment-client/src/commands/withdraw.rs`: keep existing
  preflight as the signing gate and expose share allowance/cap headroom in the
  JSON result or refusal detail.
- `clients/rust-payment-client/src/commands/get_allowance.rs`: can be reused
  for share-token allowance by passing the vault receipt token as the token
  address if a generic token allowance option exists; otherwise #429 should add
  a narrow share-allowance read.

## 7. Signer backend configuration surface for #430

Production refusal belongs in `rmpc` before write-command signing. The decision
point should have these inputs:

- chain/environment classification from config and live `chain_id`;
- signer backend kind from `[signer]`;
- `unsafe_for_production` or `allow_software_fallback`;
- an explicit non-production override for local devnet and tests.

Software signing should remain available for fork/devnet/test flows. On Base
mainnet or production-like environments, write commands must refuse
`encrypted_keystore`/software signing unless an explicit unsafe override is
present. Read-only commands do not need a signer and should continue to work.

The dapp config export hookpoint is `clients/dapp/src/lib/configExport.ts` and
`clients/dapp/src/components/ConfigExportPanel.tsx`; encrypted-keystore exports
must carry the unsafe marker and must not imply production suitability.

## 8. #431 dapp faucet-key boundary

The faucet-key guard is independent of contract hardening. It should be handled
as a dapp build/env validation change with tests around chain classification
and production-like build modes. It shares no Solidity hot files with #425-#428.

## 9. Sequencing guidance

1. Land #425 independently; it only touches vault adapter custody.
2. Land #426 before #427; #427 must reuse the `RouterEligibility` storage and
   router checks from #426.
3. Land #428 independently after #427 if both modify basket vault files in
   parallel; if #427 only changes registry/deploy tests, #428 can proceed in
   parallel.
4. #429, #430, and #431 are client/runtime hardening and can proceed in
   parallel with contract changes after ABI impacts from #426/#427 are known.
