# ADR — Portfolio Router contract seams, deposit signature, preview return shape, cap enforcement, all-or-revert semantics, and gateway coupling

> Scope: dev-scout decision record for the Portfolio Router phase of
> `docs/implementation-plan.md` §"Phase: Portfolio Router contract". Resolves
> all open questions that gate any `PortfolioRouter.sol` code: deposit
> signature, preview return shape, cap enforcement order, all-or-revert
> semantics, unavailable-leg detection, and gateway extension model. No
> `PortfolioRouter.sol` bytecode, gateway changes, or rmpc commands are
> produced by this scout.
>
> Closes the open question gate listed under `docs/implementation-plan.md`
> §"Phase: Portfolio Router contract" item 1.

---

## 1. Status

Accepted. Authored 2026-05-14 against `docs/architecture.md` §4.2 and
`docs/implementation-plan.md` §"Phase: Portfolio Router contract" on branch
`chore/300-dev-scout-map-portfolio-router-contract-seams-pr`.

---

## 2. Context

`docs/architecture.md` §4.2 defines the Portfolio Router as the outer
allocation contract that accepts USDC and splits deposits across active
underlying Robot Money vaults by RM-governed weight bps. The architecture
lists five hard requirements:

1. Destinations are vaults, not adapters or raw DeFi venues.
2. Deposits expose a preview with destination vaults, weights, estimated
   receipts, fees, and unavailable legs.
3. A deposit with any unavailable leg reverts in full; the preview surfaces
   unavailable legs before signing so the user can decide whether to proceed.
4. Receipt tokens remain visible as underlying vault receipts (no outer share
   token).
5. Router caps and vault caps both apply.

The current codebase has no `PortfolioRouter.sol`. The gateway pins one
immutable vault (`vaultContract`) and has no concept of a multi-destination
dispatch. The `VaultRegistry.sol` provides `listVaults()` and per-vault status,
which the router must read. Five questions must be resolved before any
implementation issue starts:

1. **deposit() signature.** Exact parameter list and return types.
2. **previewDeposit() return shape.** What the preview returns per leg.
3. **Cap enforcement order.** Router cap first or per-vault cap first?
4. **All-or-revert semantics.** Which conditions propagate; which are caught
   and surfaced only in the preview.
5. **Gateway extension model.** How the gateway forwards agent deposits to the
   router vs. a direct vault.

---

## 3. Decisions

### 3.1 `deposit()` signature

```solidity
/// @notice Deposit `amount` USDC into the router. The router reads active
///         vault weights from its own storage (set by governance), splits
///         `amount` across each active vault by weight bps, calls each
///         vault's `deposit`, and routes all resulting shares to `receiver`.
///
/// @dev All-or-revert: if any leg reverts, or any post-leg share balance
///      is below the caller-supplied floor, the entire transaction reverts.
///      The idempotencyKey and orderId are echoed in the `RouterDeposit` event
///      for replay-protection and audit correlation.
///
/// @param orderId          Caller-supplied order identifier (echoed in event).
/// @param amount           Gross USDC amount in 6-decimal base units.
/// @param minSharesPerLeg  Per-vault minimum shares array, ordered identically
///                         to the active vault list returned by `activeVaults()`.
///                         Pass zero for a leg to skip the floor check on that leg.
/// @param deadline         Hard expiry; block.timestamp must be <= deadline.
/// @param idempotencyKey   Caller-side dedup salt; mixed into the paymentId hash.
///
/// @return paymentId       Replay-protection hash committing chain/contract/
///                         orderId/amount/receiver/key.
/// @return sharesPerLeg    Vault shares minted per leg in the same vault order.
function deposit(
    bytes32 orderId,
    uint256 amount,
    uint256[] calldata minSharesPerLeg,
    uint64  deadline,
    bytes32 idempotencyKey
) external returns (bytes32 paymentId, uint256[] memory sharesPerLeg);
```

**Rationale.**

- `minSharesPerLeg` is the per-leg slippage guard. A caller that does not need
  a floor passes zeros. This mirrors the single-vault gateway pattern
  (`AgentPolicy.maxPerPayment`) without hardcoding slippage inside the router.
- `orderId` + `idempotencyKey` follow the gateway's existing replay-protection
  pattern. The `paymentId` hash excludes `deadline` (matching gateway convention)
  so that deadline expiry does not prevent resubmission with the same business key.
- `receiver` is implicit: for direct human calls the router routes shares to
  `msg.sender`; for gateway-routed agent deposits the gateway's `shareReceiver`
  policy field is used (see §3.5).
- `amount` is the *gross* USDC the router pulls from the caller. Splitting is
  done internally using the stored weight bps. Fee-on-transfer tokens are not
  supported; the router asserts post-transfer balance matches `amount`.

**Rejected alternatives.**

- *Packed `(address vault, uint256 minShares)[]` instead of parallel array.*
  Requires the caller to know vault order; safe only if the vault list is
  stable. The parallel-array approach with `activeVaults()` is simpler and
  matches how the dapp and `rmpc previewDeposit` already must read the active
  list before signing.
- *No `minSharesPerLeg` at all; rely on router-level slippage only.* A
  per-router slippage cap cannot protect against a single low-liquidity leg
  returning far fewer shares than previewed.

### 3.2 `previewDeposit()` return shape

```solidity
/// @notice Preview how `amount` USDC would be split and deposited across
///         active vaults at current weights, without mutating state.
///
/// @dev Callers MUST call this before signing `deposit()` to discover
///      unavailable legs and construct safe `minSharesPerLeg` values.
///      Reverts if the router cap would be exceeded.
///
/// @param amount  Gross USDC to preview. Must be > 0.
///
/// @return legs   One entry per active vault in `activeVaults()` order.
function previewDeposit(uint256 amount)
    external
    view
    returns (DepositLeg[] memory legs);

/// @notice Per-vault decomposition returned by `previewDeposit`.
struct DepositLeg {
    address vault;          // ERC-4626 vault address
    uint16  weightBps;      // Current weight in bps (sum of active legs == 10_000)
    uint256 usdc;           // USDC allocated to this leg (amount * weightBps / 10_000)
    uint256 estimatedShares;// vault.previewDeposit(usdc); 0 if unavailable
    uint256 estimatedFee;   // vault.exitFeeBps() applied to usdc; 0 if unavailable
    bool    unavailable;    // true if leg is Paused, Retired, or cap-full
    string  unavailableReason; // "paused" | "retired" | "cap_full" | ""
}
```

**Rationale.**

- `estimatedShares` is the result of calling `vault.previewDeposit(usdc)` on
  each active-weight leg. It is informational only; the contract does not
  guarantee the live deposit produces exactly this many shares.
- `estimatedFee` is derived from `vault.exitFeeBps()` for display purposes.
  It does not affect the deposit path; fees are deducted by the vault on
  redemption, not on deposit. This matches the PRD §2 fee model.
- `unavailable: true` means the corresponding `minSharesPerLeg` entry should
  be 0 and the caller should expect `deposit()` to revert until the leg
  recovers (see §3.4 all-or-revert semantics).
- `unavailableReason` is a short machine-readable string, not an enum, to keep
  the ABI stable while allowing the dapp to render a human label without
  requiring contract upgrades.
- `estimatedShares` is 0 for unavailable legs because calling
  `vault.previewDeposit` on a paused vault may revert. The router catches that
  revert in the preview path only and sets `estimatedShares = 0`.

**Rejected alternatives.**

- *Return a single `bool unavailable` for the whole deposit.* Too coarse;
  the dapp needs per-leg detail to explain which vault is causing the revert.
- *Include `estimatedShares` only, no `estimatedFee`.* The PRD §2 explicitly
  requires fee disclosure at preview time.

### 3.3 Cap enforcement order

Cap checks run in this exact order on every `deposit()` call:

1. **Router cap check.** If `routerCap > 0` and
   `routerTotalDeposited + amount > routerCap`, revert with
   `RouterCapExceeded(routerCap, routerTotalDeposited, amount)`.
2. **Per-leg USDC allocation.** `legUsdc[i] = amount * weightBps[i] / 10_000`.
   Rounding dust (sum < amount) stays in the router and is used for the last
   leg or emitted as a `DustRefunded` event if the accumulated dust exceeds a
   threshold (TBD in implementation; start at 0 — route all dust to the last
   leg).
3. **Per-vault cap check (per leg).** For each leg, read
   `vault.totalAssets()` and `depositCap` from the registry. If
   `vault.totalAssets() + legUsdc[i] > depositCap` and `depositCap > 0`,
   mark leg as unavailable with reason `"cap_full"`. If the leg is unavailable,
   the deposit **reverts** (see §3.4).
4. **Vault deposit.** Call `IERC4626(vault).deposit(legUsdc[i], receiver)`.
5. **Minimum shares check.** If `sharesReceived[i] < minSharesPerLeg[i]`,
   revert with `SlippageExceeded(vault, minSharesPerLeg[i], sharesReceived[i])`.

**Rationale.**

- Router cap is checked first so that a fully-committed router cap is caught
  before any vault call is made. This avoids partial state (USDC moved to one
  vault) on a cap failure.
- Per-vault cap is checked before the vault call so the router can surface a
  clear `"cap_full"` reason rather than relying on the vault's own revert error.
- Minimum shares check is post-call so the actual receipt amount is known.

**Storage coupling with `VaultRegistry.sol`.**

The router reads `VaultRegistry.getVault(vault).depositCap` and
`VaultRegistry.getVault(vault).status` for each leg. This is the only storage
dependency between the router and the registry — the router does not store vault
metadata itself. The registry address is set at construction time and is
immutable. Any hot-file change to `VaultRegistry.sol`'s `VaultRecord` struct or
`getVault` ABI must be coordinated with the router implementation.

### 3.4 All-or-revert semantics

**Revert conditions that propagate (transaction reverts in full):**

| Condition | Error | Revert triggered by |
|---|---|---|
| Router cap exceeded | `RouterCapExceeded` | Router cap check (step 1) |
| Any leg is Paused | `UnavailableLeg(vault, "paused")` | Status check before vault call |
| Any leg is Retired | `UnavailableLeg(vault, "retired")` | Status check before vault call |
| Any leg cap-full | `UnavailableLeg(vault, "cap_full")` | Per-vault cap check (step 3) |
| `vault.deposit()` reverts | bubble up | Vault call (step 4) |
| Shares below `minSharesPerLeg` | `SlippageExceeded` | Post-call check (step 5) |
| `deadline` passed | `DeadlineExpired` | Pre-flight |
| `paymentId` already used | `PaymentIdAlreadyUsed` | Pre-flight |
| Fee-on-transfer detected | `FeeOnTransferDetected` | Pre-flight (post-pull balance check) |
| `amount == 0` | `InvalidAmount` | Pre-flight |
| `minSharesPerLeg.length != activeVaults().length` | `LegCountMismatch` | Pre-flight |

**Conditions caught in preview only (not reverts in `deposit()` itself —
these cause the deposit to revert because unavailable legs always revert):**

The `previewDeposit()` view function catches reverts from `vault.previewDeposit`
(e.g. the vault is paused and its preview function reverts) and returns
`estimatedShares = 0, unavailable = true` rather than bubbling up. The live
`deposit()` does not call `previewDeposit`; it makes the real deposit calls and
lets any revert propagate.

**Design principle.** The architecture (`docs/architecture.md` §4.2) is explicit:
"a deposit with any unavailable leg reverts in full." There is no partial
deposit, no skip-leg fallback, and no retry-from-router mechanism. The user must
call `previewDeposit` first, observe unavailable legs, and decide to wait or
adjust their action.

### 3.5 Gateway extension: router as a deposit destination

The gateway currently pins one immutable `vaultContract` address. Extending
agent deposits to reach the Portfolio Router requires a gateway extension issue
(already listed in `docs/implementation-plan.md` §"Phase: Portfolio Router
contract": "Gateway: extend allowed destinations to include the Portfolio
Router"). This scout maps the coupling without implementing it.

**Planned extension model:**

The gateway will maintain an allowlist of permitted deposit destinations (vaults
and the router). The existing `deposit(orderId, amount, deadline, idempotencyKey)`
function gains a new parameter `destination address` that identifies the target.
If `destination` is the router address, the gateway calls
`IPortfolioRouter(destination).deposit(orderId, amount, minSharesPerLeg, deadline, idempotencyKey)`
instead of `IERC4626(vaultContract).deposit(amount, shareReceiver)`.

The `shareReceiver` routing rule:

- For direct-vault agent deposits: shares go to `agents[agent].shareReceiver`
  (existing behavior).
- For router-routed agent deposits: the router calls each `vault.deposit` with
  `shareReceiver = agents[agent].shareReceiver`. The router passes this value
  through from the gateway call, not from its own storage.

**Hot-file coupling summary for the gateway extension:**

| File | Change required |
|---|---|
| `contracts/gateway/RobotMoneyGateway.sol` | Add `allowedDestinations` mapping; update `deposit` signature; add `addDestination` / `removeDestination` ADMIN functions |
| `contracts/gateway/interfaces/IGateway.sol` | Add new `deposit` overload or update existing signature |
| `contracts/interfaces/IPortfolioRouter.sol` | New interface file (stub in this scout is not required) |
| Deploy script | Register router as allowed destination after deploy |
| `rmpc deposit` | Accept `--destination router` flag; build new calldata |

**Existing gateway logic that remains unchanged:**

- `AgentPolicy` cap enforcement (`maxPerPayment`, `maxPerWindow`): the gateway
  still applies these before delegating to the router. The router's own cap is
  an additional layer, not a replacement.
- `paymentId` replay protection: computed at the gateway level; the router
  receives it as `orderId` and emits it in `RouterDeposit` for correlation but
  does not re-check it.
- Pause: the gateway's stop-the-world pause blocks all destinations including
  the router.

### 3.6 Unavailable-leg detection logic

A leg is considered **unavailable** if any of the following is true at the time
of the `deposit()` call:

| Condition | Source | Check order |
|---|---|---|
| `VaultRegistry.getVault(vault).status == VaultStatus.Paused` | Registry | First |
| `VaultRegistry.getVault(vault).status == VaultStatus.Retired` | Registry | First |
| `vault.totalAssets() + legUsdc > depositCap && depositCap > 0` | Vault + Registry | After status check |

A leg is **not** considered unavailable solely because:

- The vault's on-chain `paused()` flag differs from the registry status (this
  is a misconfiguration risk; the router trusts the registry status as the
  authoritative source for routing decisions).
- The router cap would be exceeded (that causes a `RouterCapExceeded` revert
  on the whole deposit, not a per-leg unavailability).

In `previewDeposit()`, unavailable-leg detection additionally catches:

- `vault.previewDeposit(legUsdc)` reverts for any reason. The router treats
  such a revert as `unavailable = true`, `unavailableReason = "preview_revert"`,
  `estimatedShares = 0`.

---

## 4. Downstream unblocked issues and sequencing

All items below are in `docs/implementation-plan.md` §"Phase: Portfolio Router
contract".

| Issue | Unblocked by this ADR? | Must serialize after |
|---|---|---|
| `PortfolioRouter.sol` — core deposit + all-or-revert | Yes — signature and semantics are fixed | This ADR |
| `PortfolioRouter.sol` preview surface | Yes — `previewDeposit` return shape is fixed | This ADR |
| Gateway: extend allowed destinations | Yes — coupling model is specified | `PortfolioRouter.sol` (needs router address) |
| Deploy script: router + gateway registration | Yes | `PortfolioRouter.sol` + Gateway extension |
| Fork e2e: router deposit, unavailable-leg revert, cap enforcement | Yes | Deploy script |

**Parallel work that is safe:**

- `PortfolioRouter.sol` core and `PortfolioRouter.sol` preview surface can be
  implemented in the same PR or sequentially — they touch the same file.
- The gateway extension can begin interface design (`IPortfolioRouter.sol`) in
  parallel with the router implementation; the final integration requires the
  router ABI to be stable.

**Strict serial dependency:**

- Fork e2e tests require a deployed router; they must run after the deploy
  script is ready and a devnet or Base fork is available.

---

## 5. Integration risks and open questions deferred to implementation

The following risks were discovered during scouting. They are not blockers for
implementation issues to begin, but the assigned implementer must address each.

1. **Weight rounding dust.** `amount * weightBps[i] / 10_000` accumulates
   integer rounding dust when the number of active legs is large or `amount`
   is small. The router must decide where rounding dust goes. Current decision:
   route all dust to the last active leg. Implementation must add a unit test
   verifying `sum(legUsdc) == amount` for a range of amounts and weight configs.

2. **`activeVaults()` ordering stability.** The router's parallel array API
   (`minSharesPerLeg`, `sharesPerLeg`) depends on a stable ordering of active
   vaults across the `previewDeposit` → `deposit` call pair. If the active
   vault list changes between preview and deposit (e.g. a vault is paused or
   a weight is updated), the leg order may shift and the caller's
   `minSharesPerLeg` array may refer to the wrong vault. Mitigation: the router
   should include the active-vault snapshot hash in the `paymentId` or require
   a `bytes32 vaultListHash` argument on `deposit` that the router checks
   against the current active list hash. This decision is deferred to
   implementation but must be resolved before the fork e2e.

3. **Registry read gas cost.** For each leg, `deposit()` calls
   `VaultRegistry.getVault(vault)` (one SLOAD per vault field per leg). At 10
   active vaults this is O(10) cross-contract reads. The router should cache
   the registry address as an immutable and consider storing a local weight bps
   mapping to avoid per-deposit registry reads for weight data (weights change
   only via governance, not per-deposit). Status reads must remain live because
   a vault can be paused between blocks.

4. **No outer share token.** `docs/architecture.md` §2.2 is explicit: the
   Portfolio Router does not issue an outer share token. The dapp and `rmpc`
   must compute portfolio positions from underlying vault receipt balances. Any
   implementation that introduces an outer ERC-4626 wrapper or LP token violates
   this constraint.

5. **Router cap storage.** `routerCap` and `routerTotalDeposited` must be
   persistent storage in the router, not derived from vault balances. The
   router cannot read back its own deposits from each vault without a per-vault
   scan. Implementation must track `routerTotalDeposited` as a monotonically
   increasing counter (deposits add, withdrawals subtract if/when router
   withdrawals are scoped).

6. **`previewDeposit` is a view; `deposit` is not.** The router must not read
   mutable state in `previewDeposit` that is set during `deposit`. Specifically,
   the `routerTotalDeposited` counter is read in `previewDeposit` to detect
   cap-full, but it is written only in `deposit`. This is the correct pattern;
   just document it clearly in the contract NatSpec.

7. **Gateway extension breaks existing `deposit` ABI.** Adding a `destination`
   parameter to the gateway's `deposit` function is an ABI-breaking change for
   all existing rmpc callers. The gateway extension issue must decide between:
   (a) a new `depositTo(destination, ...)` function leaving the old `deposit`
   intact, or (b) a coordinated ABI bump requiring a new `rmpc` release.
   Current recommendation: option (a) to avoid forcing a simultaneous rmpc
   upgrade.
