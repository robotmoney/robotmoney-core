# TestMachine Azimuth — Automated Security Scan — 2026-06-23

**Scope:** Full-stack automated scan of `robotmoney/robotmoney-monorepo` produced
by the TestMachine "Azimuth" scanner. Sweeps the Solidity contracts (gateway,
router, governance, registry, vault, adapters), the `rmpc` Rust payment client,
and the `dapp` (React/TypeScript).

**HEAD commit:** `35f28b3bd78de8e9ef9afd13f9f0d3b4af8c6d19` (branch `dev`).

**Status:** **UNVERIFIED automated output.** This is the raw scanner report,
captured as an institutional-memory snapshot. Findings, line numbers, and
severity labels are the scanner's own and have **not** yet been independently
re-checked against HEAD source. Severity labels from automated scans of this
repo have historically been miscalibrated in both directions — see
[`20260619-code-review-internal-claude-scan-verification.md`](./20260619-code-review-internal-claude-scan-verification.md)
for the verification methodology (read each cited symbol at HEAD, quote the
actual code, grade CONFIRMED / PARTIAL / MITIGATED / REFUTED, n-order pass,
severity re-grade). A verification pass over this scan is a follow-up task; until
then no disposition is recorded in [`../audits.md`](../audits.md).

**Companions:**
[`20260619-code-review-pekshield.md`](./20260619-code-review-pekshield.md),
[`20260619-code-review-internal-claude-scan-verification.md`](./20260619-code-review-internal-claude-scan-verification.md),
[`20260618-code-review-internal-claude.md`](./20260618-code-review-internal-claude.md),
[`20260609-code-review-internal-claude.md`](./20260609-code-review-internal-claude.md),
[`20260602-code-review-internal-claude.md`](./20260602-code-review-internal-claude.md).

---

# Scan findings — robotmoney/robotmoney-monorepo

Critical: 1 · High: 2 · Medium: 12 · Low: 11 · Info: 29 · Total: 55

Finished: 2026-06-23T11:23:23.212990Z


## Router withdrawals spend arbitrary shareReceiver allowances set by the agent policy owner

**Severity:** critical · access_control

**Claim:**

Permissionless agent authorization lets the caller choose any `policy.shareReceiver` and `policy.assetRecipient`, and the router withdrawal path later spends vault-share allowances from that `shareReceiver` while sending redeemed assets to `assetRecipient`. Because ERC-20 allowances are granted to the gateway globally, an attacker can authorize an attacker-controlled agent with `shareReceiver` set to a victim that has approved the gateway, set `assetRecipient` to the attacker, and call `withdrawFromRouter` to redeem the victim's approved vault shares without the victim owning or approving that agent policy.

**Evidence:**

- `contracts/gateway/RobotMoneyGateway.sol:562`

```
function commitAuthorization(bytes32 commitHash) external {
The commit phase of agent authorization is permissionless, so an attacker can start authorization for an attacker-controlled agent.
```

- `contracts/gateway/RobotMoneyGateway.sol:570`

```
function revealAuthorization(address agent, bytes32 salt, AgentPolicy calldata p) external {
The reveal phase accepts the full attacker-supplied policy and calls the shared authorization logic.
```

- `contracts/gateway/RobotMoneyGateway.sol:615`

```
function _authorizeAgentInternal(address agent, AgentPolicy calldata p) internal {
        if (agent == address(0)) revert ZeroAddress();
        if (agentOwner[agent] != address(0)) revert AgentAlreadyOwned();
        _validatePolicy(p);

        agentOwner[agent] = msg.sender;
        agents[agent] = p;
Authorization stores the caller-supplied `shareReceiver` and `assetRecipient` without checking that `msg.sender` owns or is approved by the chosen share receiver.
```

- `contracts/gateway/RobotMoneyGateway.sol:664`

```
function _validatePolicy(AgentPolicy calldata p) internal view {
        if (p.shareReceiver == address(0)) revert InvalidShareReceiver();
        if (!p.active) revert InvalidValidUntil();
        if (p.validUntil < block.timestamp) revert InvalidValidUntil();
        if (p.maxPerPayment == 0 || p.maxPerWindow == 0) revert InvalidAmount();
        if (p.maxPerPayment > p.maxPerWindow) revert InvalidAmount();
        // Withdrawal fields: if withdrawal is enabled (maxWithdrawPerPayment > 0),
        // validate the recipient and window cap relationship.
        if (p.maxWithdrawPerPayment > 0) {
            if (p.assetRecipient == address(0)) revert InvalidAssetRecipient();
Policy validation requires only non-zero addresses and cap relationships; it does not bind `shareReceiver` or `assetRecipient` to the policy owner.
```

- `contracts/gateway/RobotMoneyGateway.sol:1274`

```
args.shareHolder = p.shareReceiver;
            args.assetRecipient = p.assetRecipient;
Router withdrawal uses the policy's arbitrary `shareReceiver` as the source of shares and arbitrary `assetRecipient` as the destination of assets.
```

- `contracts/gateway/RobotMoneyGateway.sol:1368`

```
IERC20(args.vaultList[i])
                .safeTransferFrom(args.shareHolder, address(this), sharesPerLeg[i]);
The gateway spends the victim shareReceiver's ERC-20 allowance to the gateway; the allowance is not scoped to the attacker's agent policy.
```

- `contracts/gateway/RobotMoneyGateway.sol:1384`

```
assetsPerLeg = routerContract.redeemFor(
            address(this),
            args.assetRecipient,
            args.vaultList,
            sharesPerLeg,
            minAssetsPerLeg,
            uint256(args.deadline)
        );
After pulling the victim's shares into the gateway, redeemed USDC is directed to the attacker-chosen asset recipient.
```

## Deposits mint shares against slippage floor instead of realized NAV

**Severity:** high · accounting_error

**Claim:**

BasketVault._deposit computes the depositor's share credit as usdcAmount * (1 - maxSlippageBps) and only lowers it when realizedDelta is worse; when swaps realize normal/better NAV, the depositor is still minted shares for the discounted floor while the full post-swap assets remain in totalAssets. Existing shareholders can hold shares before other users deposit and later redeem pro-rata against the uncredited realizedDelta - credit surplus, extracting up to maxSlippageBps of each subsequent deposit without providing value.

**Evidence:**

- `contracts/vaults/BasketVault.sol:528`

```
// Shares on REALIZED NAV the vault captured (TWAP-valued post-swap),
        // capped at the slippage-discounted floor so the depositor is never
        // credited beyond the worst-case `previewDeposit` floor (SUP-3).
        uint256 credit = usdcAmount.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        uint256 realizedDelta = totalAssets() - taBefore;
        if (realizedDelta < credit) credit = realizedDelta;
        uint256 mintShares = credit.mulDiv(
            supplyBefore + 10 ** _decimalsOffset(), taBefore + 1, Math.Rounding.Floor
        );

        _mint(receiver, mintShares);
The branch only reduces credit below the slippage floor. If realizedDelta is higher than the floor, the depositor is still credited only for the floor rather than the actual NAV captured.
```

- `contracts/vaults/BasketVault.sol:567`

```
uint256 minOut = _applySlippage(
                _twapTokenValue(assets[i].pool, assets[i].token, assets[i].adapter, swapIn)
            );

            uint256 amountOut = _executeSwap(
                assets[i].adapter,
                address(_USDC),
                assets[i].token,
                assets[i].swapFee,
                swapIn,
                minOut,
                address(this)
            );
The vault receives the actual swap output tokens; amountOut/minOut only bound execution and do not reduce the assets retained by the vault to the discounted credit.
```

- `contracts/vaults/BasketVault.sol:448`

```
function totalAssets() public view virtual override returns (uint256) {
        uint256 sum = _USDC.balanceOf(address(this));
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 bal = IERC20(assets[i].token).balanceOf(address(this));
            if (bal > 0) {
                sum += _twapUsdcValue(assets[i].pool, assets[i].token, assets[i].adapter, bal);
All actual post-swap tokens, including the portion not credited to the depositor, remain counted in NAV.
```

- `contracts/vaults/BasketVault.sol:639`

```
function previewDeposit(uint256 assets_) public view override returns (uint256) {
        // Discount the effective deposit by the worst-case slippage so the
        // share conversion reflects the actual token value the vault captures.
        uint256 effectiveAssets = assets_.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        return _convertToShares(effectiveAssets, Math.Rounding.Floor);
    }
The preview path also hard-discounts by maxSlippageBps, making the slippage tolerance behave as a permanent deposit haircut rather than a worst-case bound.
```

- `contracts/vaults/BasketVault.sol:717`

```
uint256 supplyBefore = totalSupply();
        _burn(owner, shares);

        uint256 usdcReceived = _sellProportional(shares, supplyBefore);

        uint256 fee = usdcReceived.mulDiv(exitFeeBps, MAX_BPS);
        uint256 net = usdcReceived - fee;
...
        _USDC.safeTransfer(receiver, net);
Preexisting shareholders can later redeem their shares against total vault assets, including surplus NAV left behind by under-crediting later deposits.
```

- `contracts/vaults/BasketVault.sol:741`

```
uint256 idleBefore = _USDC.balanceOf(address(this));
        if (idleBefore > 0) {
            usdcOut += idleBefore.mulDiv(shares, supplyBefore);
        }

        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 bal = IERC20(assets[i].token).balanceOf(address(this));
...
            uint256 sellAmount = bal.mulDiv(shares, supplyBefore);
Redemptions pay a proportional slice of all vault balances, so the uncredited deposit surplus is distributed to holders existing before the deposit.
```

## Donated USDC permanently blocks router deposits

**Severity:** high · denial_of_service

**Claim:**

PortfolioRouter assumes its USDC balance is exactly zero after each deposit, but it checks the absolute balance rather than a per-call balance delta and it forbids sweeping USDC. Any external account can transfer a small amount of USDC directly to the router before a deposit; subsequent depositFor/deposit calls route only the caller's `amount` and then revert because the pre-existing donated USDC remains, leaving no protocol function to clear the protected USDC balance.

**Evidence:**

- `contracts/PortfolioRouter.sol:747`

```
// Collect USDC from caller into this contract.
        usdc.safeTransferFrom(msg.sender, address(this), amount);
The deposit path pulls only the caller-specified amount and does not snapshot or account for any USDC already sitting on the router.
```

- `contracts/PortfolioRouter.sol:818`

```
// Post-loop custody invariant: the router must hold zero USDC after all
        // legs have been executed.
        if (usdc.balanceOf(address(this)) != 0) {
            revert UsdcCustodyInvariantViolated();
        }
The invariant is absolute zero, so any pre-existing USDC dust causes every otherwise successful routed deposit to revert.
```

- `contracts/PortfolioRouter.sol:412`

```
function sweepForeignToken(address token) external nonReentrant {
        if (token == address(usdc)) revert ForeignTokenQuarantine.TokenIsProtected(token);
        ForeignTokenQuarantine.sweep(token, quarantineAddress, msg.sender);
    }
The only public sweep function explicitly rejects USDC, so the donated balance cannot be removed through the quarantine mechanism.
```

- `contracts/gateway/RobotMoneyGateway.sol:956`

```
usdcToken.forceApprove(address(routerContract), args.amount);
        uint256[] memory sharesPerLeg =
            routerContract.depositFor(args.shareReceiver, args.amount, minSharesPerLeg);
Gateway routed deposits depend on PortfolioRouter.depositFor, so the donated-balance condition also blocks gateway depositTo calls routed through the router.
```

## Allowance visibility uses agent address while router withdrawals spend shareReceiver allowances

**Severity:** medium · accounting_error

**Claim:**

The gateway's router withdrawal path transfers vault shares from `policy.shareReceiver`, but the Rust `get-agent` command reports `vault.allowance(agent, gateway)` as the outstanding withdrawal allowance. For policies that use router withdrawals, this omits the actual `shareReceiver -> gateway` allowances that enable a compromised agent to redeem shares, so operators and the dapp can show no/stale-risk information for the wrong owner while spendable shareReceiver allowances remain active.

**Evidence:**

- `contracts/gateway/RobotMoneyGateway.sol:1274`

```
args.shareHolder = p.shareReceiver;
            args.assetRecipient = p.assetRecipient;
The router withdrawal path identifies the share holder as the policy's `shareReceiver`, not the agent address.
```

- `contracts/gateway/RobotMoneyGateway.sol:1369`

```
IERC20(args.vaultList[i])
                .safeTransferFrom(args.shareHolder, address(this), sharesPerLeg[i]);
The gateway spends allowances granted by `shareReceiver` for each router vault leg.
```

- `clients/rust-payment-client/src/commands/get_agent.rs:212`

```
// share allowance(agent, gateway) on the pinned vault. Read even
    // when withdrawals are disabled — a leftover non-zero allowance
    // with a future re-enable is still part of the blast radius
    // operators need to see (issue #429: "revoke stale gateway share
    // allowances").
    match call_share_allowance(rpc, vault, &block_tag, agent, gateway).await {
The operator-facing command reads the allowance owner as `agent`, which matches single-vault `withdraw` but not router withdrawals that spend from `shareReceiver`.
```

- `clients/rust-payment-client/src/commands/get_agent.rs:298`

```
let data = Erc20::allowanceCall { owner, spender }.abi_encode();
The helper is capable of reading any owner/spender pair, but `read_agent` passes the wrong owner for router-withdrawal blast-radius reporting.
```

- `clients/dapp/src/components/AgentPoliciesPanel.tsx:91`

```
/// `vault.allowance(agent, gateway)` — outstanding share allowance
    /// the agent has granted the gateway. Combined with
    /// `max_withdraw_per_payment`/`max_withdraw_per_window` this is
    /// the bound on what a compromised agent can withdraw without
    /// further on-chain action by the depositor (issue #429).
The UI-facing policy data model inherits the same agent-allowance assumption, so users can be warned about the wrong allowance owner.
```

## BasketVault ERC4626 return values can bypass router slippage floors

**Severity:** medium · logic_error

**Claim:**

BasketVault inherits OpenZeppelin ERC4626 deposit/redeem return values, but its overridden _deposit and _withdraw ignore the precomputed share/assets arguments and instead mint or transfer amounts determined after swaps. When realized basket execution is below preview, the inherited deposit/redeem still return the previewed amount, so PortfolioRouter.depositFor and redeemFor compare minSharesPerLeg/minAssetsPerLeg against overstated return values while the receiver actually gets fewer vault shares or less USDC.

**Evidence:**

- `contracts/vaults/BasketVault.sol:488`

```
function _deposit(
        address caller,
        address receiver,
        uint256 usdcAmount,
        uint256 /*shares*/
    ) ... {
        ...
        uint256 credit = usdcAmount.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        uint256 realizedDelta = totalAssets() - taBefore;
        if (realizedDelta < credit) credit = realizedDelta;
        uint256 mintShares = credit.mulDiv(
            supplyBefore + 10 ** _decimalsOffset(), taBefore + 1, Math.Rounding.Floor
        );

        _mint(receiver, mintShares);
        emit Deposit(caller, receiver, usdcAmount, mintShares);
    }
The override discards the ERC4626 `shares` argument and mints a post-swap `mintShares`, which can be lower than preview when `realizedDelta < credit`.
```

- `contracts/vaults/BasketVault.sol:709`

```
function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256, /* assets — unused; actual determined by swaps */
        uint256 shares
    ) ... {
        ...
        uint256 usdcReceived = _sellProportional(shares, supplyBefore);
        uint256 fee = usdcReceived.mulDiv(exitFeeBps, MAX_BPS);
        uint256 net = usdcReceived - fee;
        ...
        _USDC.safeTransfer(receiver, net);
        emit Withdraw(caller, receiver, owner, net, shares);
    }
The override discards the ERC4626 `assets` argument and transfers post-swap `net`, which can differ from the previewed amount returned by inherited `redeem`.
```

- `contracts/PortfolioRouter.sol:855`

```
sharesReceived = IERC4626(vault).deposit(legAmount, receiver);
The router trusts the ERC4626 deposit return value as the per-leg shares received.
```

- `contracts/PortfolioRouter.sol:810`

```
if (minSharesPerLeg.length != 0 && sharesReceived < minSharesPerLeg[i]) {
                revert SlippageExceeded();
            }
Deposit slippage is enforced against the possibly overstated return value, not the receiver's actual share-balance delta.
```

- `contracts/PortfolioRouter.sol:724`

```
assetsOut = IERC4626(vault).redeem(shares, assetRecipient, shareHolder);

        ...
        if (assetsOut < minAssets) revert SlippageExceeded();
Redeem slippage is enforced against the possibly overstated return value, not the recipient's actual USDC balance delta.
```

- `OpenZeppelin/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol:175`

```
uint256 shares = previewDeposit(assets);
        _deposit(_msgSender(), receiver, assets, shares);

        return shares;
OpenZeppelin deposit returns the previewed `shares` variable rather than any amount minted by the override.
```

- `OpenZeppelin/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol:214`

```
uint256 assets = previewRedeem(shares);
        _withdraw(_msgSender(), receiver, owner, assets, shares);

        return assets;
OpenZeppelin redeem returns the previewed `assets` variable rather than the amount transferred by the override.
```

## Dapp onboarding uses admin-only authorization entrypoint

**Severity:** medium · access_control

**Claim:**

The depositor onboarding UI constructs and simulates a direct `authorizeAgent` transaction, but the deployed gateway gates `authorizeAgent` with `onlyRole(ADMIN_ROLE)` and exposes permissionless depositor onboarding through `commitAuthorization`/`revealAuthorization` instead. A normal connected depositor cannot complete the wizard because simulation/transaction submission is disabled or reverts, leaving permissionless agent authorization inaccessible through the dapp.

**Evidence:**

- `contracts/gateway/RobotMoneyGateway.sol:608`

```
function authorizeAgent(address agent, AgentPolicy calldata p) external onlyRole(ADMIN_ROLE) {
        _authorizeAgentInternal(agent, p);
    }
The direct authorization entrypoint used by the UI is admin-only on-chain.
```

- `contracts/gateway/RobotMoneyGateway.sol:562`

```
function commitAuthorization(bytes32 commitHash) external {
The gateway's permissionless onboarding surface is the commit/reveal flow, not the admin-gated direct authorize call.
```

- `contracts/gateway/RobotMoneyGateway.sol:570`

```
function revealAuthorization(address agent, bytes32 salt, AgentPolicy calldata p) external {
A complete permissionless dapp flow would need to submit and later reveal a commitment; the UI does not wire this path.
```

- `clients/dapp/src/components/OnboardingWizard.tsx:270`

```
const { data: sim } = useSimulateContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "authorizeAgent",
    args: action ? [action.agent, action.policy] : undefined,
    query: { enabled: step === 3 && isConnected && preview?.ok === true },
  });
The first-run depositor wizard simulates the admin-only function rather than the permissionless commit/reveal path.
```

- `clients/dapp/src/components/AuthorizeTab.tsx:59`

```
const { data: sim } = useSimulateContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "authorizeAgent",
    args: action ? [action.agent, action.policy] : undefined,
The main authorize tab uses the same admin-only entrypoint, so the issue is not limited to first-run onboarding.
```

## Deposit receipt timeout clears replay protection for an already-broadcast transaction

**Severity:** medium · logic_error

**Claim:**

The deposit command inserts the paymentId replay-cache entry only after eth_sendRawTransaction succeeds, but removes that entry on any receipt-wait error, including a timeout. A timeout is not proof that the transaction was dropped or reverted; the original transaction may still be pending and later succeed. After the removal, rerunning the same deposit order passes the local replay lookup and signs a second transaction with the same paymentId, causing duplicate broadcasts and at minimum avoidable gas loss/reverts for an operation the replay cache is intended to make idempotent.

**Evidence:**

- `clients/rust-payment-client/src/commands/deposit.rs:333`

```
// Look up the gateway-equivalent paymentId in our own client-side
// cache.  The paymentId is keccak256(abi.encode(chain_id, gateway,
// agent, order_id, amount, idempotency_key)) — deadline is
// intentionally excluded, mirroring the on-chain formula.  On a
// hit, surface the prior tx_hash and exit non-zero with
// `ErrOrderIdAlreadySubmitted` instead of paying gas to discover
// the same dedupe on chain.
The replay cache is explicitly intended to prevent duplicate broadcasts for the same gateway paymentId before paying gas.
```

- `clients/rust-payment-client/src/commands/deposit.rs:592`

```
let tx_hash_hex = format!("{tx_hash:#x}");
audit.tx_hash = Some(tx_hash_hex.clone());
// Record the paymentId → tx_hash entry in the replay cache so a
// future retry hits the local check before paying gas.  deadline is
// stored as audit metadata only.
if let Err(e) = replay.insert(
        cfg.chain_id,
        gateway_addr,
        agent_address,
        order_id,
        amount,
        idempotency_key,
        deadline,
        &tx_hash_hex,
    ) {
The cache is populated after broadcast, while the transaction may still be pending.
```

- `clients/rust-payment-client/src/commands/deposit.rs:620`

```
let receipt_res = rt.block_on(async {
        wait_for_receipt_with(&rpc, tx_hash, Duration::from_secs(1), max_attempts.max(1)).await
    });
let receipt = match receipt_res {
        Ok(r) => r,
        Err(e) => {
            // RPC-2 (finalize-on-failure): the receipt never confirmed within
            // the budget, so the deposit did not durably succeed. Clear the
            // optimistic replay-cache entry so a legitimate retry is allowed
            // instead of being permanently refused by a poisoned entry.
            finalize_replay_on_failure(
                &replay,
                cfg.chain_id,
                gateway_addr,
                agent_address,
                order_id,
                amount,
                idempotency_key,
            );
Any receipt wait error, including the timeout returned by wait_for_receipt_with, deletes the replay entry even though timeout does not imply the transaction failed.
```

- `clients/rust-payment-client/src/tx/mod.rs:183`

```
for _ in 0..max_attempts {
        if let Some(r) = rpc.get_transaction_receipt(tx_hash).await? {
            return Ok(r);
        }
        tokio::time::sleep(interval).await;
    }
    Err(RmpcError::ErrRpcTransport(format!(
        "timeout waiting for receipt of {tx_hash:#x}"
    )))
The receipt waiter returns an error solely because the polling budget was exhausted, not because the transaction was known reverted or dropped.
```

- `clients/rust-payment-client/src/commands/deposit.rs:768`

```
fn finalize_replay_on_failure(
    replay: &crate::replay_cache::ReplayCache,
    chain_id: u64,
    gateway: Address,
    agent: Address,
    order_id: B256,
    amount: U256,
    idempotency_key: B256,
) {
    if let Err(e) = replay.remove(chain_id, gateway, agent, order_id, amount, idempotency_key) {
        log::warn!("rmpc deposit: replay cache finalize-on-failure remove failed (non-fatal): {e}");
    }
}
The removal is unconditional with respect to the failure kind, so pending/unknown and reverted states are collapsed.
```

## Deposits during adapter exclusion can capture later recovered assets

**Severity:** medium · accounting_error

**Claim:**

RobotMoneyVault excludes active adapters from totalAssets as soon as their allowlist or codehash eligibility is revoked, but it does not pause deposits and still treats those adapters as active for deposit availability. An external depositor can mint shares against the reduced NAV while excluded adapter funds are still recoverable; when the adapter is re-allowed or emergency-withdrawn back to idle USDC, the recovered value is added to NAV and the new depositor receives a pro-rata claim on assets that belonged to pre-existing holders.

**Evidence:**

- `contracts/RobotMoneyVault.sol:414`

```
function totalAssets() public view override returns (uint256) {
        uint256 sum = IERC20(asset()).balanceOf(address(this)); // include idle vault balance
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (_isAdapterCounted(i)) sum += adapters[i].adapter.totalAssets();
        }
        return sum;
    }
NAV excludes any adapter that is not currently counted, even if it remains active and still holds recoverable vault funds.
```

- `contracts/RobotMoneyVault.sol:427`

```
function _isAdapterCounted(uint256 i) internal view returns (bool) {
        return adapters[i].active && _isAdapterEligible(address(adapters[i].adapter));
    }
Eligibility revocation removes an active adapter from NAV without marking it inactive or burning/segregating the corresponding shares.
```

- `contracts/RobotMoneyVault.sol:748`

```
function setAdapterAllowed(address adapter_, bool allowed_) external onlyRole(ADMIN_ROLE) {
        if (adapter_ == address(0)) revert ZeroAddress();
        adapterAllowed[adapter_] = allowed_;
        emit AdapterAllowedSet(adapter_, allowed_);
    }
The allowlist can be revoked without pausing deposits or otherwise preventing minting against the reduced NAV.
```

- `contracts/RobotMoneyVault.sol:560`

```
function maxDeposit(address) public view override returns (uint256) {
        if (depositsPaused || shutdown || retired) return 0;
        if (_activeAdapterCount() == 0) return 0;
        ...
        uint256 current = totalAssets();
Deposit availability is based on `_activeAdapterCount`, not counted/eligible adapters, so an active-but-ineligible adapter does not by itself close deposits.
```

- `contracts/RobotMoneyVault.sol:1202`

```
function _activeAdapterCount() internal view returns (uint256) {
        uint256 count;
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (adapters[i].active) count++;
        }
        return count;
    }
Adapters whose funds are excluded from NAV still satisfy the active-adapter deposit gate.
```

- `contracts/RobotMoneyVault.sol:433`

```
if (totalAssets() + assets > tvlCap) revert TVLCapExceeded();
        if (_activeAdapterCount() == 0) revert NoActiveAdapters();

        super._deposit(caller, receiver, assets, shares);
        _routeDeposit(assets);
New shares are minted using ERC4626 conversion over the reduced `totalAssets` value while omitted adapter funds remain economically recoverable.
```

- `contracts/RobotMoneyVault.sol:946`

```
try adapters[index].adapter.withdraw(balance) returns (uint256 actual) {
            emit EmergencyWithdrawAdapterCalled(
                index, address(adapters[index].adapter), actual, true
            );
Excluded adapter funds can later return as idle USDC, immediately increasing NAV for all current shareholders including those who deposited during the exclusion.
```

- `contracts/RobotMoneyVault.sol:464`

```
// Skip adapters whose allowlist / codehash eligibility was revoked while
            // still active in the registry — depositing must not brick when governance
            // quarantines one adapter...
            if (!_isAdapterEligible(address(adapters[i].adapter))) continue;
The deposit path intentionally remains live and simply skips revoked adapters, enabling the underpriced-share minting window.
```

## Direct vault deposit/redeem paths lack enforceable minimum output

**Severity:** medium · price_manipulation

**Claim:**

The direct ERC-4626 vault flows display previewDeposit/previewRedeem values and gate on simulation, but the submitted transactions are plain vault.deposit(assets, receiver) and vault.redeem(shares, receiver, owner) calls with no minimum-shares or minimum-assets argument. Unlike the router path, which derives and submits per-leg share floors, a user signing a direct deposit or redemption has no on-chain slippage bound; if an unprivileged actor or normal vault activity changes the vault conversion rate between preview/simulation and inclusion, the transaction can still succeed with materially fewer shares/assets than the UI preview indicated.

**Evidence:**

- `clients/dapp/src/components/DepositWithdrawTab.tsx:210`

```
const { data: depositSim, error: depositSimError } = useSimulateContract({
    account: address,
    address: depositVault,
    abi: vaultAbi,
    functionName: "deposit",
    args: depositAction ? [depositAction.assets, depositAction.receiver] : undefined,
The single-vault deposit transaction only carries assets and receiver; no minimum share output from the preview is enforced on-chain.
```

- `clients/dapp/src/components/DepositWithdrawTab.tsx:254`

```
const { data: redeemSim, error: redeemSimError } = useSimulateContract({
    account: address,
    address: selectedVault,
    abi: vaultAbi,
    functionName: "redeem",
    args: redeemAction
      ? [redeemAction.shares, redeemAction.receiver, redeemAction.owner]
      : undefined,
The withdrawal transaction burns a fixed share amount but does not include a minimum USDC/assets-out bound corresponding to previewRedeem.
```

- `clients/dapp/src/components/DepositWithdrawTab.tsx:446`

```
{typeof previewRedeemAssets === "bigint" && withdrawShares !== null && (
          <p className="hint" data-testid="withdraw-preview-redeem">
            Estimated USDC out: {formatUsdcPreview(previewRedeemAssets)} (net of exit fee)
          </p>
        )}
The UI presents the redeem result as an estimate only; it is not bound to the signed calldata.
```

- `clients/dapp/src/components/RouterDepositTab.tsx:165`

```
// DAPP-2 (issue #1025): submit non-zero per-leg share floors derived from the
  // preview's per-leg estimated shares (minus a slippage tolerance) so each leg
  // keeps slippage protection. Replaces the previous empty `[]` floors array.
  const minSharesPerLeg = deriveMinSharesPerLeg(legs);

  const { data: depositSim, error: depositSimError } = useSimulateContract({
    account: address,
    address: routerAddress,
    abi: routerAbi,
    functionName: "deposit",
    args: depositAssets !== null ? [depositAssets, minSharesPerLeg] : undefined,
The router flow has an explicit slippage-protection mechanism, highlighting the missing equivalent in direct vault calls.
```

- `clients/dapp/src/components/VaultSelectorDepositTab.tsx:146`

```
const { data: depositSim, error: depositSimError } = useSimulateContract({
    account: address,
    address: selectedVaultAddr ? (selectedVaultAddr as Address) : undefined,
    abi: vaultAbi,
    functionName: "deposit",
    args: depositAction ? [depositAction.assets, depositAction.receiver] : undefined,
The newer vault-selector direct deposit path has the same missing min-shares enforcement.
```

## Inactive asset balances can be bought into before public reabsorption

**Severity:** medium · accounting_error

**Claim:**

BasketVault excludes inactive AssetInfo balances from totalAssets, but reabsorbRemovedAsset is permissionless and can later swap an inactive token balance into counted USDC NAV. If a removed token balance appears in the vault, an unprivileged user can deposit while that value is still uncounted, then call reabsorbRemovedAsset and redeem a pro-rata share of the newly counted proceeds, diluting the holders who owned the vault before the removed asset reappeared.

**Evidence:**

- `contracts/vaults/BasketVault.sol:448`

```
function totalAssets() public view virtual override returns (uint256) {
        uint256 sum = _USDC.balanceOf(address(this));
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 bal = IERC20(assets[i].token).balanceOf(address(this));
            if (bal > 0) {
                sum += _twapUsdcValue(assets[i].pool, assets[i].token, assets[i].adapter, bal);
            }
        }
        return sum;
    }
Any token balance for an inactive/removed asset is excluded from NAV and share pricing.
```

- `contracts/vaults/BasketVault.sol:517`

```
uint256 supplyBefore = totalSupply();
        uint256 taBefore = totalAssets();
        if (taBefore + usdcAmount > tvlCap) revert TVLCapExceeded();

        // Pull USDC from the caller into the vault (no shares minted yet).
        SafeERC20.safeTransferFrom(IERC20(asset()), caller, address(this), usdcAmount);
...
        uint256 mintShares = credit.mulDiv(
            supplyBefore + 10 ** _decimalsOffset(), taBefore + 1, Math.Rounding.Floor
        );
A deposit made before reabsorption mints shares using taBefore that excludes the inactive token balance.
```

- `contracts/vaults/BasketVault.sol:1023`

```
function reabsorbRemovedAsset(uint256 index) external nonReentrant {
        AssetInfo memory assetInfo = assets[index]; // reverts on OOB index
        // Only inactive (removed) entries qualify: active assets are already
        // counted in NAV and are sold proportionally on withdrawal.
        if (assetInfo.active) revert AssetInBasket();

        uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
...
        try this.emergencyTwapUsdcValue(assetInfo, bal) returns (uint256 twapValue) {
            // Pool healthy: swap to USDC into NAV under the slippage-bounded floor.
            _emergencyUnwindAsset(assetInfo, _applySlippage(twapValue));
        } catch {
            // Pool degraded: TWAP unavailable. Sweep rather than strand (INV-1);
            // `sweep` emits ForeignTokenQuarantined(token, amount, caller).
            _sweepToQuarantine(assetInfo.token);
        }
    }
Any user can trigger the transition that converts the previously uncounted inactive balance into counted USDC NAV.
```

- `contracts/vaults/BasketVault.sol:1201`

```
// Protected = USDC, the share token, or ANY registered basket asset
        // (active OR configured-but-inactive). Inactive entries are re-absorbed
        // into NAV via `reabsorbRemovedAsset`, never quarantined.
        bool protected_ = token == address(_USDC) || token == address(this);
        uint256 len = assets.length;
        for (uint256 i = 0; i < len && !protected_; i++) {
            if (token == assets[i].token) protected_ = true;
        }
        if (protected_) revert ForeignTokenQuarantine.TokenIsProtected(token);
Inactive registered assets are intentionally protected from normal sweeping, so a reappeared balance remains available for the reabsorption arbitrage.
```

- `contracts/vaults/BasketVault.sol:717`

```
uint256 supplyBefore = totalSupply();
        _burn(owner, shares);

        uint256 usdcReceived = _sellProportional(shares, supplyBefore);
...
        _USDC.safeTransfer(receiver, net);
After reabsorption increases NAV, the attacker can redeem their newly minted shares for a pro-rata portion of the formerly uncounted balance.
```

## Redemptions rely on a vault-wide slippage floor without caller minimum output

**Severity:** medium · price_manipulation

**Claim:**

BasketVault redemptions expose the redeemer to the vault-wide `maxSlippageBps` because the standard ERC-4626 redeem path has no caller-supplied minimum USDC output: `_withdraw` burns the shares and `_sellProportional` swaps each asset using only `_slippageFloor(asset, sellAmount)` = TWAP value times `(1 - maxSlippageBps)`, while `_executeSwap` submits the swaps immediately with `block.timestamp` as deadline. An unprivileged MEV actor can move an execution pool against a victim redeem to just above this global floor and back-run the pool, causing the victim to settle up to the configured slippage bound below the contemporaneous market value even if the victim would have required a tighter per-transaction minimum.

**Evidence:**

- `contracts/vaults/BasketVault.sol:709`

```
function _withdraw(..., uint256 shares) internal override nonReentrant {
    if (caller != owner) _spendAllowance(owner, caller, shares);

    uint256 supplyBefore = totalSupply();
    _burn(owner, shares);

    uint256 usdcReceived = _sellProportional(shares, supplyBefore);
    ...
    _USDC.safeTransfer(receiver, net);
}
The redeem path accepts only the ERC-4626 share amount and burns shares before selling; there is no user-provided `minAssetsOut` checked against the final USDC proceeds.
```

- `contracts/vaults/BasketVault.sol:759`

```
uint256 minUsdcOut = _slippageFloor(assets[i], sellAmount);

uint256 received = _executeSwap(
    assets[i].adapter,
    assets[i].token,
    address(_USDC),
    assets[i].swapFee,
    sellAmount,
    minUsdcOut,
    address(this)
);
Each redemption leg uses only the vault-computed floor; the redeemer cannot tighten it for their transaction.
```

- `contracts/vaults/BasketVault.sol:1059`

```
function _slippageFloor(AssetInfo memory assetInfo, uint256 amount) internal view returns (uint256) {
    return _applySlippage(
        _twapUsdcValue(assetInfo.pool, assetInfo.token, assetInfo.adapter, amount)
    );
}

function _applySlippage(uint256 usdcValue) internal view returns (uint256) {
    return usdcValue * (MAX_BPS - maxSlippageBps) / MAX_BPS;
}
The only minimum is a protocol-wide TWAP haircut, allowing execution anywhere inside the configured slippage band.
```

- `contracts/vaults/BasketVault.sol:1511`

```
amountOut = IBasketSwapAdapter(adapter)
    .swap(tokenIn, tokenOut, fee, amountIn, minAmountOut, recipient, block.timestamp);
Adapter swaps are executed with the current block timestamp and no caller deadline/min-return parameter, so the victim cannot constrain execution beyond the vault-wide floor.
```

## Registry status changes do not halt direct BasketVault deposits

**Severity:** medium · state_lifecycle

**Claim:**

VaultRegistry records Paused/Retired status and attempts to call retire/unretire hooks, but BasketVault has no retire/unretire hook and its deposit path does not read registry status. After governance marks a BasketVault non-Active in the registry, router deposits stop, but any external user or gateway agent can still call the vault's ERC4626 deposit path directly as long as the vault itself was not separately paused, bypassing the registry lifecycle halt.

**Evidence:**

- `contracts/VaultRegistry.sol:275`

```
function setVaultStatus(address vault, VaultStatus newStatus) external onlyRole(ADMIN_ROLE) {
        if (!_registered[vault]) revert NotRegistered();
        _status[vault] = newStatus;
        ...
        if (vault.code.length > 0) {
            if (newStatus == VaultStatus.Active) {
                try IRetirableVault(vault).unretire() {} catch {}
            } else {
                try IRetirableVault(vault).retire() {} catch {}
            }
        }

        emit VaultStatusChanged(vault, newStatus, block.timestamp);
    }
Registry status is updated even if the target vault does not implement the retire/unretire hook; the failed hook is silently ignored.
```

- `contracts/vaults/BasketVault.sol:488`

```
function _deposit(
        address caller,
        address receiver,
        uint256 usdcAmount,
        uint256 /*shares*/
    )
        internal
        override
        whenNotPaused
        nonReentrant
    {
        if (shutdown) revert VaultShutdown();
        if (depositsPaused) revert EnforcedPause();
        if (usdcAmount > perDepositCap) revert PerDepositCapExceeded();
BasketVault deposits check only the vault-local pause/shutdown flags and do not consult VaultRegistry status or a retired flag.
```

- `contracts/vaults/BasketVault.sol:1`

```
Search for `retir|registry|VaultStatus|IRetirableVault` in contracts/vaults/BasketVault.sol found only registry comments and deposit pause fields; no retire(), unretire(), registry address, or VaultStatus check is defined.
The basket vault lacks the lifecycle hook that VaultRegistry expects to drive when status becomes Paused or Retired.
```

- `contracts/gateway/RobotMoneyGateway.sol:923`

```
bool isVault = (destination == address(vaultContract));
        isRouter = (address(routerContract) != address(0) && destination == address(routerContract));
        if (!isVault && !isRouter) revert InvalidDestination();
Gateway direct-vault routing accepts the pinned vault address without any registry status lookup.
```

- `contracts/gateway/RobotMoneyGateway.sol:986`

```
usdcToken.forceApprove(args.destination, args.amount);
        uint256 sharesMinted = IERC4626(args.destination).deposit(args.amount, args.shareReceiver);
Once the destination is the pinned BasketVault, the gateway calls ERC4626 deposit directly; registry Paused/Retired status cannot block this call.
```

- `contracts/PortfolioRouter.sol:534`

```
try registry.getVault(vault) returns (
            VaultRegistry.VaultMetadata memory, VaultRegistry.VaultStatus status
        ) {
            if (status != VaultRegistry.VaultStatus.Active) return false;
        } catch {
            return false;
        }
Only the router path honors registry Active status, creating a bypass through direct vault deposits.
```

## Router withdrawals ignore the pinned-vault restriction when allowedSourceVaults is empty

**Severity:** medium · validation_bypass

**Claim:**

`AgentPolicy.allowedSourceVaults` is documented to permit only the pinned vault when the array is empty, and the single-vault `withdraw` path enforces that. `withdrawFromRouter` only checks membership when the array is non-empty; with an empty allowlist it forwards any caller-supplied `vaults[]` to the router. A withdrawal-enabled agent can therefore redeem approved shares from non-pinned router vaults despite a policy that left `allowedSourceVaults` empty to restrict withdrawals to the pinned vault.

**Evidence:**

- `contracts/gateway/interfaces/IGateway.sol:48`

```
/// @param allowedSourceVaults     Whitelist of vaults the agent may redeem from via `withdraw`.
    ///                                When non-empty, the supplied `sourceVault` must appear in
    ///                                this list. An empty array permits only the pinned vault
    ///                                (no registry lookup; arbitrary vault addresses are never
    ///                                accepted).
The policy semantics define empty `allowedSourceVaults` as restrictive, not as a wildcard.
```

- `contracts/gateway/RobotMoneyGateway.sol:1065`

```
// 5. sourceVault validation: must be the pinned vault, and must pass
        //    the allowedSourceVaults whitelist when non-empty.
        if (sourceVault != address(vaultContract)) revert InvalidSourceVault();
        {
            uint256 len = p.allowedSourceVaults.length;
            if (len > 0) {
The single-vault withdrawal path enforces the documented empty-array behavior by always requiring `sourceVault == vaultContract` before any allowlist logic.
```

- `contracts/gateway/RobotMoneyGateway.sol:1245`

```
// 5a. allowedSourceVaults check: every vault with non-zero shares
            //     must be in the policy allowlist (when non-empty).
            uint256 slen = p.allowedSourceVaults.length;
            if (slen > 0) {
                for (uint256 i = 0; i < args.vaultList.length; i++) {
                    if (sharesPerLeg[i] == 0) continue;
The router withdrawal path has no fallback check for `slen == 0`, so an empty allowlist becomes a wildcard for non-zero router withdrawal legs.
```

- `contracts/gateway/RobotMoneyGateway.sol:1384`

```
assetsPerLeg = routerContract.redeemFor(
            address(this),
            args.assetRecipient,
            args.vaultList,
            sharesPerLeg,
            minAssetsPerLeg,
            uint256(args.deadline)
        );
The unchecked caller-supplied vault list is ultimately forwarded for redemption, making the missing empty-allowlist restriction execution-relevant.
```

## Snapshot voting UI becomes unusable after 256 blocks

**Severity:** medium · denial_of_service

**Claim:**

RouterGovernance exposes `getPastVotes` with a hard `block.number > blockNumber + 256` revert even though proposal voting periods are at least one hour, and the official GovernancePanel requires that view to populate `snapshotVotingPower` before enabling or simulating `vote`. On chains with sub-14-second blocks, an otherwise eligible voter opening the dapp more than 256 blocks after `propose()` cannot cast through the dapp for the remaining voting period, which can suppress quorum via the official voting surface despite `vote()` itself still accepting the checkpoint internally.

**Evidence:**

- `contracts/RouterGovernance.sol:578`

```
function getPastVotes(address voter, uint256 blockNumber) external view returns (uint256) {
        if (block.number > blockNumber + 256) revert CheckpointTooOld();
        return _getPastVotes(voter, blockNumber);
    }
The external snapshot-power accessor used by clients reverts once the proposal snapshot block is more than 256 blocks old, although the storage checkpoint search does not require this limit.
```

- `contracts/RouterGovernance.sol:58`

```
uint64 public constant MIN_VOTING_PERIOD = 1 hours;
...
function setVotingPeriod(uint64 period) external onlyRole(ADMIN_ROLE) {
        if (period < MIN_VOTING_PERIOD) revert VotingPeriodBelowMinimum();
Voting is designed to remain open for at least one hour, which is commonly much longer than 256 blocks on the intended L2 environment.
```

- `clients/dapp/src/components/GovernancePanel.tsx:231`

```
const { data: snapshotVotingPower } = useReadContract({
    address: props.governanceAddress,
    abi: routerGovernanceVoteAbi,
    functionName: "getPastVotes",
    args: address && typeof snapshotBlock === "bigint" ? [address, snapshotBlock] : undefined,
...
  const canVote =
    isConnected &&
    Boolean(address) &&
    selectedProposal !== null &&
    selectedProposal.status === "open" &&
    typeof snapshotVotingPower === "bigint" &&
    snapshotVotingPower > 0n;
The official dapp gates the vote simulation and write on a successful `getPastVotes` result; when the read reverts after 256 blocks, `canVote` stays false and no vote transaction is offered.
```

- `contracts/RouterGovernance.sol:450`

```
uint256 power = _getPastVotes(msg.sender, p.voteSnapshot);
        if (power == 0) revert NoVotingPower();
The on-chain vote path uses the same checkpoint data internally without the 256-block age check, so the denial is introduced at the exported accessor/client boundary rather than by an expired proposal.
```

## Withdraw commands do not apply local paymentId replay protection

**Severity:** medium · logic_error

**Claim:**

Unlike deposit, the withdraw and withdraw-router mutation paths accept an idempotency key and forward it to the gateway but never open, look up, or insert the local ReplayCache before broadcasting. Repeating the same withdraw order therefore signs and broadcasts another transaction instead of returning the prior tx_hash locally. If the first transaction is still pending or already mined, the duplicate can consume an additional nonce and gas (or, if on-chain idempotency is incomplete, duplicate the withdrawal) even though the client-side replay mechanism is intended to prevent duplicate mutation broadcasts.

**Evidence:**

- `clients/rust-payment-client/src/commands/deposit.rs:340`

```
let replay = match crate::replay_cache::ReplayCache::open(&state_dir) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc deposit: replay cache open failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
...
match replay.lookup(
        cfg.chain_id,
        gateway_addr,
        agent_address,
        order_id,
        amount,
        idempotency_key,
    ) {
The deposit path has the expected local replay lookup before building and broadcasting a transaction.
```

- `clients/rust-payment-client/src/commands/deposit.rs:592`

```
// Record the paymentId → tx_hash entry in the replay cache so a
// future retry hits the local check before paying gas.  deadline is
// stored as audit metadata only.
if let Err(e) = replay.insert(
        cfg.chain_id,
        gateway_addr,
        agent_address,
        order_id,
        amount,
        idempotency_key,
        deadline,
        &tx_hash_hex,
    ) {
The deposit path stores the tx hash after broadcast so later retries can be refused locally.
```

- `clients/rust-payment-client/src/commands/withdraw.rs:442`

```
let calldata = RobotMoneyGateway::withdrawCall {
        orderId: order_id,
        shares,
        sourceVault: source_vault,
        deadline,
        idempotencyKey: idempotency_key,
    }
    .abi_encode();
...
let tx_hash = match rt.block_on(async { broadcast(&rpc, &raw).await }) {
The single-vault withdraw path includes idempotencyKey in calldata and then broadcasts, but the surrounding run body contains no ReplayCache open/lookup/insert before this point.
```

- `clients/rust-payment-client/src/commands/withdraw_router.rs:546`

```
let calldata = RobotMoneyGateway::withdrawFromRouterCall {
        orderId: order_id,
        vaults: vaults.clone(),
        sharesPerLeg: shares_per_leg.clone(),
        minAssetsPerLeg: min_assets_per_leg.clone(),
        deadline,
        idempotencyKey: idempotency_key,
    }
    .abi_encode();
...
let tx_hash = match rt.block_on(async { broadcast(&rpc, &raw).await }) {
The router withdraw path also forwards idempotencyKey but broadcasts without local replay-cache protection.
```

- `clients/rust-payment-client/src/commands/`

```
clients/rust-payment-client/src/commands/deposit.rs:340:run: let replay = match crate::replay_cache::ReplayCache::open(&state_dir) {
clients/rust-payment-client/src/commands/deposit.rs:348:run: match replay.lookup(
clients/rust-payment-client/src/commands/deposit.rs:602:run: if let Err(e) = replay.insert(
clients/rust-payment-client/src/commands/withdraw.rs:447:run: idempotencyKey: idempotency_key,
clients/rust-payment-client/src/commands/withdraw_router.rs:552:run: idempotencyKey: idempotency_key,
A scoped search shows ReplayCache usage in deposit but only idempotencyKey forwarding in the two withdraw commands.
```

## Deposit lookup only indexes single-vault deposit events

**Severity:** low · logic_error

**Claim:**

The Rust `get-deposit` command identifies deposits by filtering only for the `AgentDeposit` event topic. Router-path `depositTo` calls emit `AgentDepositRouted` with the same returned `paymentId` semantics and never emit `AgentDeposit`, so a valid routed deposit id is reported as not found by the operator lookup flow.

**Evidence:**

- `contracts/gateway/RobotMoneyGateway.sol:970`

```
emit AgentDepositRouted(
            args.paymentId,
            args.orderId,
            msg.sender,
            args.shareReceiver,
            address(routerContract),
            args.amount,
            sharesPerLeg,
            args.windowId
        );
Successful router deposits emit `AgentDepositRouted`, not `AgentDeposit`.
```

- `contracts/gateway/RobotMoneyGateway.sol:885`

```
usedPaymentIds[paymentId] = true;
        args.paymentId = paymentId;

        // slither-disable-start reentrancy-balance
The routed deposit's returned `paymentId` is still recorded as a consumed gateway payment id, so it is a valid deposit identifier for status purposes.
```

- `clients/rust-payment-client/src/commands/get_deposit.rs:103`

```
let topic0 = RobotMoneyGateway::AgentDeposit::SIGNATURE_HASH;
The lookup command hard-codes the single-vault deposit event signature as its only log topic.
```

- `clients/rust-payment-client/src/commands/get_deposit.rs:122`

```
"topics": [topic0, deposit_id],
The log filter can never match `AgentDepositRouted` events for router-path deposits.
```

- `clients/rust-payment-client/src/commands/get_deposit.rs:140`

```
let decoded = RobotMoneyGateway::AgentDeposit::decode_log_data(&log_data, true)
            .map_err(|e| format!("AgentDeposit decode: {e}"))?;
Even if a routed event were returned by a broader filter, the command only decodes the single-vault event layout.
```

## Destination selector does not filter or gate inactive vaults before direct deposits

**Severity:** low · validation_bypass

**Claim:**

When registry and router addresses are configured, DepositWithdrawTab lets the user choose any address returned by registry.listVaults() and then approves and calls that vault's ERC-4626 deposit directly. This path never reads getVault() or VaultStatus and therefore does not disable Paused/Retired registry entries, even though the vault-selector flow and landing cards treat non-Active vaults as non-depositable. If registry status is the intended pause/retirement control and the vault contract itself remains callable, an unprivileged user can bypass the inactive-vault deposit guard through this destination selector and send USDC into a vault the UI/governance marked closed.

**Evidence:**

- `clients/dapp/src/components/DestinationSelector.tsx:34`

```
const { data: vaultListRaw } = useReadContract({
    address: props.registryAddress,
    abi: registryAbi,
    functionName: "listVaults",
  });
...
{vaults.map((vault) => (
        <label key={vault} data-testid={`destination-vault-${vault.toLowerCase()}`}>
          <input
            type="radio"
            name="deposit-destination"
            value={vault}
            checked={props.selected === vault}
            onChange={() => props.onSelect(vault)}
The destination picker lists raw vault addresses from listVaults() and exposes each as selectable without loading or checking its registry status.
```

- `clients/dapp/src/components/DepositWithdrawTab.tsx:112`

```
const depositVault: Address =
    destination !== ROUTER_DESTINATION ? destination : props.vaultAddress;
The selected destination address directly becomes the vault used for allowance, preview, simulation, and deposit.
```

- `clients/dapp/src/components/DepositWithdrawTab.tsx:210`

```
const { data: depositSim, error: depositSimError } = useSimulateContract({
    account: address,
    address: depositVault,
    abi: vaultAbi,
    functionName: "deposit",
    args: depositAction ? [depositAction.assets, depositAction.receiver] : undefined,
The direct deposit is sent to the selected vault with no registry getVault/status gate in this component.
```

- `clients/dapp/src/components/VaultSelectorDepositTab.tsx:60`

```
const { data: liveVaultRecord } = useReadContract({
    address: registryAddress,
    abi: registryAbi,
    functionName: "getVault",
    args: selectedVaultAddr ? [selectedVaultAddr as Address] : undefined,
...
const vaultIsPaused =
    liveVaultRecord !== undefined &&
    (liveVaultRecord as { status: number }).status !== VaultStatus.Active;
A sibling deposit flow implements the missing live registry-status check, showing that status is a safety-critical deposit gate.
```

- `clients/dapp/src/components/VaultSelectorDepositTab.tsx:235`

```
{vaults.map((v) => (
            <option key={v.vault} value={v.vault} disabled={v.status !== VaultStatus.Active}>
              {v.name || v.vault} ({v.riskLabel})
              {v.status !== VaultStatus.Active ? " [PAUSED/RETIRED]" : ""}
            </option>
          ))}
The newer selector disables non-Active vaults, but DestinationSelector does not.
```

## Off-chain feature flag does not prevent direct governance execution

**Severity:** low · configuration_bypass

**Claim:**

The PORTFOLIO_ROUTER_ENABLED feature flag is only defined as an internal pure bitmap helper and is not checked by RouterGovernance. If operators clear the flag expecting the router/governance path to be disabled, any unprivileged address can still call RouterGovernance.execute on an already queued proposal after the delay, causing router.setWeights to run and mutate router weights despite the disabled flag.

**Evidence:**

- `contracts/FeatureFlags.sol:7`

```
/// @notice Pure bitmap library for reading feature flags encoded in a uint256.
///         ... The bitmap is stored off-chain ...
library FeatureFlags {
...
function isEnabled(uint8 flagId, uint256 bitmap) internal pure returns (bool) {
    return (bitmap >> flagId) & 1 == 1;
}
The flag has no on-chain storage or global enforcement point; it can only protect paths that explicitly call the helper.
```

- `tool:find_callers`

```
find_callers("FeatureFlags") -> No references found for: FeatureFlags
find_callers("isEnabled") -> No references found for: isEnabled
Within the indexed source, no scoped contract or client path invokes the feature-flag library, so clearing PORTFOLIO_ROUTER_ENABLED cannot affect RouterGovernance behavior.
```

- `contracts/RouterGovernance.sol:467`

```
function execute(uint256 proposalId) external nonReentrant {
    ...
    p.executed = true;

    // Apply weights to the Portfolio Router.
    router.setWeights(p.vaults, p.bps);

    emit ProposalExecuted(proposalId, msg.sender);
    emit WeightsApplied(proposalId, p.vaults, p.bps);
}
execute is externally callable, has no onlyRole or feature-flag/paused check, and directly applies queued weights to the router.
```

## Permissionless agent authorization can reserve arbitrary agent addresses

**Severity:** low · access_control

**Claim:**

RobotMoneyGateway.revealAuthorization lets any committer authorize any currently unowned `agent` address without proving control or consent of that agent. Because `_authorizeAgentInternal` records `agentOwner[agent] = msg.sender`, later admin/self authorization of the same agent reverts with `AgentAlreadyOwned`, and `revokeAgent` can only be called by the recorded owner. An unprivileged account can therefore reserve a planned user or service agent address and block legitimate onboarding for that address until the attacker voluntarily revokes it.

**Evidence:**

- `contracts/gateway/RobotMoneyGateway.sol:570`

```
function revealAuthorization(address agent, bytes32 salt, AgentPolicy calldata p) external {
        bytes32 commitHash = keccak256(abi.encode(agent, msg.sender, salt));
        bytes32 storageKey = _commitmentKey(commitHash, msg.sender);
        Commitment memory c = commitments[storageKey];
...
        // 6. Perform the authorization (same logic as authorizeAgent).
        _authorizeAgentInternal(agent, p);
    }
The permissionless reveal path binds the commitment to the caller and the chosen agent address, but does not require a signature or transaction from the agent address itself.
```

- `contracts/gateway/RobotMoneyGateway.sol:615`

```
function _authorizeAgentInternal(address agent, AgentPolicy calldata p) internal {
        if (agent == address(0)) revert ZeroAddress();
        if (agentOwner[agent] != address(0)) revert AgentAlreadyOwned();
        _validatePolicy(p);

        agentOwner[agent] = msg.sender;
        agents[agent] = p;

        // First-time grant.
        _grantRole(AGENT_ROLE, agent);
The first successful revealer becomes the recorded owner for the arbitrary agent address, and any later authorization attempt for that agent is blocked by `AgentAlreadyOwned`.
```

- `contracts/gateway/RobotMoneyGateway.sol:647`

```
function revokeAgent(address agent) external {
        if (agent == address(0)) revert ZeroAddress();
        address owner = agentOwner[agent];
        if (owner != msg.sender) revert NotAgentOwner();

        delete agents[agent];
        delete agentOwner[agent];
Only the recorded owner can release the reserved agent address; admins or the actual agent address have no override in this function.
```

## Policy expiry check permits actions at the exact validUntil timestamp

**Severity:** low · validation_bypass

**Claim:**

RobotMoneyGateway treats a policy as valid when `block.timestamp == policy.validUntil` because authorization and execution paths reject only `validUntil < block.timestamp`. This conflicts with the documented “revert at/after” expiry boundary and allows an authorized agent to execute a deposit or withdrawal in the expiry second after the configured cutoff should have taken effect, up to the policy's per-payment/window caps.

**Evidence:**

- `contracts/gateway/interfaces/IGateway.sol:29`

```
/// @param validUntil              Unix-seconds expiry; deposits revert at/after.
The public policy semantics define the cutoff as inclusive: actions should revert at or after `validUntil`.
```

- `contracts/gateway/RobotMoneyGateway.sol:669`

```
if (p.validUntil < block.timestamp) revert InvalidValidUntil();
Policy creation/update accepts `validUntil == block.timestamp`, rather than requiring it to be strictly in the future for an at/after expiry model.
```

- `contracts/gateway/RobotMoneyGateway.sol:728`

```
if (p.validUntil < block.timestamp) revert AgentPolicyExpired();
The deposit execution path allows a policy at the exact expiry timestamp to proceed.
```

- `contracts/gateway/RobotMoneyGateway.sol:1060`

```
if (p.validUntil < block.timestamp) revert AgentPolicyExpired();
The withdrawal execution path uses the same strict-less-than check, so withdrawals are also permitted at the expiry second.
```

## Receipt success is accepted without binding the receipt to the broadcast transaction

**Severity:** low · validation_bypass

**Claim:**

After broadcasting a signed deposit or withdrawal, the CLI accepts the first JSON-RPC receipt object returned for the requested hash if `status == 1` and it contains a gateway event topic, but it never verifies that the receipt's `transactionHash`, `from`, `to`, or decoded event fields match the tx hash, signer, gateway, order id, and amount/shares that were just signed. A Byzantine or compromised configured RPC endpoint can therefore return a successful receipt/log from another gateway transaction, causing the command to emit success and, for deposits, leave the local replay-cache entry in place even though the signed payment may not have been included.

**Evidence:**

- `clients/rust-payment-client/src/tx/mod.rs:178`

```
pub async fn wait_for_receipt_with(
    rpc: &FailoverRpcClient,
    tx_hash: B256,
    interval: std::time::Duration,
    max_attempts: u32,
) -> Result<TransactionReceipt> {
    for _ in 0..max_attempts {
        if let Some(r) = rpc.get_transaction_receipt(tx_hash).await? {
            return Ok(r);
        }
        tokio::time::sleep(interval).await;
    }
The polling helper returns the decoded receipt from the RPC response without checking that `r.transaction_hash` equals the requested `tx_hash`.
```

- `clients/rust-payment-client/src/commands/deposit.rs:599`

```
if let Err(e) = replay.insert(
        cfg.chain_id,
        gateway_addr,
        agent_address,
        order_id,
        amount,
        idempotency_key,
        deadline,
        &tx_hash_hex,
    ) {
        log::warn!("rmpc deposit: replay cache insert failed (non-fatal): {e}");
    }
...
if !receipt.inner.status() { ... }
...
let log = receipt
        .inner
        .logs()
        .iter()
        .find(|l| l.address() == gateway_addr && l.topics().first() == Some(&topic0));
The deposit command inserts a replay-cache entry after broadcast and then treats any successful receipt containing a gateway AgentDeposit topic as final; it does not bind the receipt to the broadcast tx hash or request fields before keeping the cache entry and emitting success.
```

- `clients/rust-payment-client/src/commands/withdraw.rs:500`

```
let receipt = match receipt_res {
        Ok(r) => r,
...
if !receipt.inner.status() { ... }

// -- Decode AgentWithdrawal log ----------------------------------------
let topic0 = RobotMoneyGateway::AgentWithdrawal::SIGNATURE_HASH;
let log = receipt
        .inner
        .logs()
        .iter()
        .find(|l| l.address() == gateway_addr && l.topics().first() == Some(&topic0));
The single-vault withdrawal path likewise accepts a successful receipt by status and event topic only, without checking receipt transaction hash/from/to or decoded order/share fields.
```

- `clients/rust-payment-client/src/commands/withdraw_router.rs:606`

```
let receipt = match receipt_res {
        Ok(r) => r,
...
if !receipt.inner.status() { ... }

// -- Decode AgentWithdrawalRouted log ---------------------------------
let topic0 = RobotMoneyGateway::AgentWithdrawalRouted::SIGNATURE_HASH;
let log = receipt
        .inner
        .logs()
        .iter()
        .find(|l| l.address() == gateway_addr && l.topics().first() == Some(&topic0));
The router withdrawal path has the same status/topic-only acceptance of a receipt returned by the RPC endpoint.
```

## Router withdrawal deadline is based on local wall clock instead of chain time

**Severity:** low · logic_error

**Claim:**

withdraw-router computes the gateway deadline from SystemTime::now() before any RPC block timestamp read, while deposit and single-vault withdraw derive deadlines from the latest block timestamp. Because the gateway-side MAX_DEADLINE_SKEW and expiry checks are evaluated against block.timestamp, a local clock skew can make router withdrawals sign transactions that are already expired or exceed the gateway's maximum future skew, causing avoidable on-chain reverts/gas loss after otherwise passing preflight.

**Evidence:**

- `clients/rust-payment-client/src/commands/withdraw_router.rs:248`

```
let deadline_secs = args.deadline_secs.min(MAX_DEADLINE_SKEW_SECS);
let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
let deadline = now.saturating_add(deadline_secs);
The router path derives the transaction deadline from the local host clock, not from the chain timestamp used by the gateway.
```

- `clients/rust-payment-client/src/commands/withdraw_router.rs:546`

```
let calldata = RobotMoneyGateway::withdrawFromRouterCall {
        orderId: order_id,
        vaults: vaults.clone(),
        sharesPerLeg: shares_per_leg.clone(),
        minAssetsPerLeg: min_assets_per_leg.clone(),
        deadline,
        idempotencyKey: idempotency_key,
    }
    .abi_encode();
The wall-clock-derived deadline is forwarded directly into the signed gateway transaction.
```

- `clients/rust-payment-client/src/commands/deposit.rs:407`

```
let deadline = match rt.block_on(async {
        let block_number = rpc.block_number().await?;
        rpc.block_timestamp(block_number).await
    }) {
        Ok(ts) => {
            let d = ts.saturating_add(deadline_secs);
            audit.deadline = d;
            d
        }
The deposit path avoids host-clock skew by using the latest block timestamp.
```

- `clients/rust-payment-client/src/commands/withdraw.rs:320`

```
let deadline = match rt.block_on(async {
        let block_number = rpc.block_number().await?;
        rpc.block_timestamp(block_number).await
    }) {
        Ok(ts) => {
            let d = ts.saturating_add(deadline_secs);
            audit.deadline = d;
            d
        }
The single-vault withdraw path uses chain time as well, making withdraw-router the inconsistent branch.
```

- `clients/rust-payment-client/src/commands/deposit.rs:56`

```
/// Gateway-side maximum deadline skew, mirrored client-side so the daemon
/// never builds a transaction the contract is guaranteed to reject. Keep
/// in sync with `RobotMoneyGateway.MAX_DEADLINE_SKEW`.
pub const MAX_DEADLINE_SKEW_SECS: u64 = 600;
The local cap is meant to mirror a gateway check; applying it to local time instead of block time can still build a transaction the contract rejects.
```

## Router withdrawal defaults every slippage floor to zero

**Severity:** low · price_manipulation

**Claim:**

withdraw-router treats an omitted --min-assets-per-leg list as an all-zero minAssetsPerLeg array and then forwards those zero floors to gateway.withdrawFromRouter after only allowance/balance/paused preflight. In the default path, any adverse change in per-leg redeem output between preflight and inclusion is accepted down to zero assets for each leg, so a MEV actor or manipulated vault state can make the agent execute a confirmed multi-vault withdrawal with materially less output than expected instead of reverting on slippage.

**Evidence:**

- `clients/rust-payment-client/src/commands/withdraw_router.rs:74`

```
/// Per-leg minimum USDC out (slippage floor), decimal strings, parallel to
/// `shares_per_leg` (GW-5 / F-11). Empty ⇒ an all-zero floor of the same
/// length (back-compat). Otherwise the length must equal `shares_per_leg`.
pub min_assets_per_leg: Vec<String>,
The CLI documents that omitting the slippage-floor argument disables all per-leg minimums by default.
```

- `clients/rust-payment-client/src/commands/withdraw_router.rs:190`

```
let min_assets_per_leg: Vec<U256> = if args.min_assets_per_leg.is_empty() {
        vec![U256::ZERO; shares_per_leg.len()]
    } else {
        if args.min_assets_per_leg.len() != shares_per_leg.len() {
            log::error!(
                "rmpc withdraw-router: --min-assets-per-leg length ({}) must equal --shares-per-leg length ({})",
                args.min_assets_per_leg.len(),
                shares_per_leg.len()
            );
            return EXIT_STARTUP_FAIL;
        }
The default branch constructs zeros for every leg rather than requiring a caller-specified floor or computing one from a preview.
```

- `clients/rust-payment-client/src/commands/withdraw_router.rs:405`

```
// -- Preflight --------------------------------------------------------
// Run the withdrawal-specific gateway preflight (chain id, code hash,
// gateway paused, agent active+expiry, withdrawal window cap) with
// totalShares as the amount.
let preflight_result = rt.block_on(async {
        let pf = Preflight::new(&rpc, &cfg);
        pf.run_withdraw_gateway(PreflightInputs {
            signer_address: agent_address,
            amount: total_shares,
        })
        .await
    });
...
for (vault, leg_shares) in vaults.iter().zip(shares_per_leg.iter()) {
        let leg_result = rt.block_on(async {
            withdraw_vault_preflight(&rpc, *vault, gateway_addr, agent_address, *leg_shares).await
        });
The preflight checks policy and share allowance/balance/paused state; it does not compute or enforce expected asset output for the legs.
```

- `clients/rust-payment-client/src/commands/withdraw_router.rs:546`

```
let calldata = RobotMoneyGateway::withdrawFromRouterCall {
        orderId: order_id,
        vaults: vaults.clone(),
        sharesPerLeg: shares_per_leg.clone(),
        minAssetsPerLeg: min_assets_per_leg.clone(),
        deadline,
        idempotencyKey: idempotency_key,
    }
    .abi_encode();
The zero defaults are forwarded directly to the on-chain gateway call, so the transaction's own slippage protection is disabled.
```

## Software keystore creation does not restrict file permissions

**Severity:** low · secret_exposure

**Claim:**

`SoftwareSigner::create_keystore` writes the encrypted private-key keystore with `std::fs::write` and never sets owner-only permissions or uses a secure create mode. On Unix-like systems this creates the file using the process umask (commonly resulting in `0644`), so any local unprivileged user who can read the operator's state/config path can copy the encrypted signing key and perform offline passphrase guessing against the Argon2/AES-GCM keystore. The import helper exposes this path directly for keystore generation.

**Evidence:**

- `clients/rust-payment-client/src/signer/software.rs:208`

```
let json = serde_json::to_string_pretty(&keystore)
    .map_err(|e| SignerError::ErrKeystoreFormat(e.to_string()))?;
std::fs::write(path.as_ref(), json)
    .map_err(|e| SignerError::ErrKeystoreIo(e.to_string()))?;
The keystore containing the encrypted private key is created/truncated via the default filesystem API with no explicit `0600`/owner-only mode or post-write permission hardening.
```

- `clients/rust-payment-client/src/bin/rmpc_keystore_import.rs:78`

```
match SoftwareSigner::create_keystore(&out_path, &privkey, passphrase.as_bytes()) {
The import binary lets an operator create a keystore at an arbitrary output path through the insecure creation routine, making the file-permission behavior part of the normal keystore flow.
```

- `clients/rust-payment-client/src/signer/software.rs:4`

```
//! keystore at the supplied path under the passphrase carried by
//! `RMPC_KEYSTORE_PASSPHRASE`.
The file stores the signing material encrypted under a passphrase; world-readable permissions convert any local read into an offline password-guessing opportunity.
```

## Vault share-price overflow is silently saturated instead of reported invalid

**Severity:** low · accounting_error

**Claim:**

get-vault computes share_price as totalAssets * 10^decimals / totalSupply using saturating_mul. If a vault reports large but valid uint256 totalAssets and nonzero decimals such that the multiplication overflows, the numerator is clamped to U256::MAX and the command emits a normal non-partial share_price that can be orders of magnitude below the mathematically correct value. A vault or RPC response can therefore corrupt downstream pricing/TVL automation without triggering an error flag.

**Evidence:**

- `clients/rust-payment-client/src/commands/get_vault.rs:417`

```
/// Compute `totalAssets * 10^decimals / totalSupply` as a decimal
/// string. Returns `None` when `totalSupply == 0` — the price is
/// undefined there and surfacing `null` is the §9-correct way to
/// signal "no answer" for a single-cell field. Saturates on overflow
/// of the multiplication (vanishingly unlikely at sane decimals, but
/// the saturating boundary is defined behavior, not a panic).
fn compute_share_price(total_assets: U256, total_supply: U256, decimals: u8) -> Option<String> {
    if total_supply.is_zero() {
        return None;
    }
    let scale = U256::from(10u64).pow(U256::from(decimals as u64));
    let numerator = total_assets.saturating_mul(scale);
    let price = numerator / total_supply;
    Some(price.to_string())
}
The overflow path is deliberately converted into a plausible numeric price instead of None or a partial/error state.
```

- `clients/rust-payment-client/src/commands/get_vault.rs:312`

```
if let (Some(ta), Some(ts)) = (total_assets, total_supply) {
        let decimals = b.data_mut().decimals;
        let price = compute_share_price(ta, ts, decimals);
        b.data_mut().share_price = price;
    }

    Ok(b.finish())
The computed saturated price is stored in the output data with no check for arithmetic overflow.
```

- `clients/rust-payment-client/src/read_output.rs:184`

```
pub fn finish(self) -> Envelope<T> {
        Envelope {
            chain_id: self.chain_id,
            block_number: self.block_number,
            source: Source::JsonRpc,
            network_env: NetworkEnv::from_chain_id(self.chain_id),
            partial: !self.errors.is_empty(),
            errors: self.errors,
            data: self.data,
        }
    }
Because no record_err is made on arithmetic saturation, the final envelope can be partial:false while the derived share_price is overflow-corrupted.
```

## Vault-selector deposit gate treats missing live status as active

**Severity:** low · validation_bypass

**Claim:**

In the vault-selector deposit flow, `vaultIsPaused` is computed as false until `registry.getVault(selectedVault)` returns a record, and the deposit simulation/submit gate does not require that live status read to have succeeded. If the cached vault list is stale or the live status read is still loading/failing while a selected vault has become paused or retired, an unprivileged connected user can get a direct `vault.deposit` simulation/write request before the UI learns the non-active status, bypassing the intended live status safety gate and potentially depositing into a vault the registry marks unavailable.

**Evidence:**

- `clients/dapp/src/components/VaultSelectorDepositTab.tsx:60`

```
const { data: liveVaultRecord } = useReadContract({
  address: registryAddress,
  abi: registryAbi,
  functionName: "getVault",
  args: selectedVaultAddr ? [selectedVaultAddr as Address] : undefined,
  query: {
    enabled: Boolean(selectedVaultAddr) && isConnected,
    // refetch on every block to catch vault pauses in real-time
    refetchInterval: 12_000,
  },
});

const vaultIsPaused =
  liveVaultRecord !== undefined &&
  (liveVaultRecord as { status: number }).status !== VaultStatus.Active;
The status gate is optimistic: `liveVaultRecord === undefined` (initial load, stale query, or read failure) makes `vaultIsPaused` false rather than blocking until a live Active status is known.
```

- `clients/dapp/src/components/VaultSelectorDepositTab.tsx:139`

```
const canSimDeposit =
  isConnected &&
  depositPreview?.ok === true &&
  allowanceOk &&
  !vaultIsPaused &&
  !hasInsufficientBalance;

const { data: depositSim, error: depositSimError } = useSimulateContract({
  account: address,
  address: selectedVaultAddr ? (selectedVaultAddr as Address) : undefined,
  abi: vaultAbi,
  functionName: "deposit",
  args: depositAction ? [depositAction.assets, depositAction.receiver] : undefined,
  query: { enabled: canSimDeposit, retry: 5 },
});
The simulation is enabled by `!vaultIsPaused` without checking `liveVaultRecord` readiness or equality to Active, so a missing live status permits construction of a direct deposit request.
```

- `clients/dapp/src/components/VaultSelectorDepositTab.tsx:201`

```
const submitDisabledReason = !isConnected
  ? "wallet-not-connected"
  : !selectedVaultAddr
    ? "no-vault-selected"
    : vaultIsPaused
      ? "vault-paused"
      : hasInsufficientBalance
        ? "insufficient-balance"
        : !allowanceOk
          ? "needs-approve"
          : !depositSim
            ? "sim-pending"
            : undefined;
...
<button
  type="button"
  data-testid="vault-selector-deposit-submit"
  onClick={onDeposit}
  disabled={Boolean(submitDisabledReason) || isPending}
>
The final button gate only blocks the paused branch when `vaultIsPaused` is true; it has no `status-loading`/`status-unknown` disabled state.
```

- `clients/dapp/src/components/VaultSelectorDepositTab.tsx:234`

```
{vaults.map((v) => (
  <option key={v.vault} value={v.vault} disabled={v.status !== VaultStatus.Active}>
    {v.name || v.vault} ({v.riskLabel})
    {v.status !== VaultStatus.Active ? " [PAUSED/RETIRED]" : ""}
  </option>
))}
The selectable options come from cached `useVaultRegistry()` state; if this cache is stale while the live `getVault` read is not yet available, the user can still select a vault whose actual registry status is no longer Active.
```

## Audit log rotation is not synchronized across concurrent client processes

**Severity:** info · audit_integrity

**Claim:**

Each process creates its own `AuditSink` with only an in-process `Mutex<File>` and rotates `audit.log` by renaming files without any interprocess file lock. Concurrent rmpc invocations, which are allowed for different agent addresses, can therefore write or rotate the same audit files concurrently; one process can continue appending signed/refused records to a file another process has already renamed or deleted, causing audit records to be missed by consumers of the active audit log or lost during rotation.

**Evidence:**

- `clients/rust-payment-client/src/logging.rs:144`

```
let file = OpenOptions::new().create(true).append(true).open(&path)?;
Ok(Self {
    path,
    file: Mutex::new(file),
    rotate_size_bytes: u64::from(rotate_size_mb) * 1024 * 1024,
    keep_files,
})
The only synchronization primitive is a process-local `Mutex<File>`; no `fs2`/flock or lock file coordinates multiple rmpc processes using the same log directory.
```

- `clients/rust-payment-client/src/logging.rs:153`

```
let mut guard = match self.file.lock() {
    Ok(g) => g,
    Err(_) => return,
};
let _ = writeln!(*guard, "{line}");
let _ = guard.flush();

// Size-based rotation: if file size > limit, roll. We hold the
// mutex so the rotation is observably atomic w.r.t. writers.
The code treats the mutex as making rotation atomic, but that guarantee only applies to threads in the same process, not separate CLI invocations.
```

- `clients/rust-payment-client/src/logging.rs:190`

```
std::fs::rename(&self.path, &first)?;
...
let new_file = OpenOptions::new()
    .create(true)
    .append(true)
    .open(&self.path)?;
Rotation renames and reopens the shared path without coordinating with other processes that may still hold append handles to the old inode.
```

- `clients/rust-payment-client/src/nonce/mod.rs:43`

```
pub fn lock_path(state_dir: &Path, address: &Address) -> PathBuf {
    state_dir.join(format!("agent-{}.lock", hex::encode(address.as_slice())))
}
The nonce lock is per agent address, so separate agent invocations can legitimately run concurrently while sharing the same global audit log directory.
```

## Base default fee cap is incompatible with the priority-fee floor

**Severity:** info · denial_of_service

**Claim:**

For chain ids 8453 and 84532, the default maxFeePerGas cap is exactly 1 gwei while compute_fees always applies a 1 gwei minimum priority fee and then rejects whenever 2 * baseFeeNext + priorityFee exceeds the cap. With the default configuration and any nonzero Base baseFeeNext, write commands fail with ErrFeeCapExceeded before signing or broadcasting, allowing ordinary network activity or a malicious feeHistory source that reports a nonzero base fee to deny deposits/withdrawals until an operator overrides the cap.

**Evidence:**

- `clients/rust-payment-client/src/fees/mod.rs:53`

```
pub fn default_max_fee_per_gas_cap_wei(chain_id: u64) -> Option<u64> {
    match chain_id {
        // L1 mainnet — 100 gwei keeps us out of fee spikes.
        1 => Some(100 * ONE_GWEI as u64),
        // Base mainnet and Base Sepolia — typical fees are sub-gwei,
        // so 1 gwei is the right "loud" ceiling.
        8453 | 84532 => Some(ONE_GWEI as u64),
The default maxFeePerGas cap for Base networks is set to exactly ONE_GWEI.
```

- `clients/rust-payment-client/src/fees/mod.rs:74`

```
pub const PRIORITY_FEE_FLOOR_WEI: u128 = ONE_GWEI;
The fee calculator never bids a priority fee below the same one-gwei value used as the Base total-fee cap.
```

- `clients/rust-payment-client/src/fees/mod.rs:123`

```
let target = base_fee_next.saturating_mul(2).saturating_add(priority_fee);

if target > max_fee_cap_wei {
    return Err(RmpcError::ErrFeeCapExceeded);
}
The total max fee is rejected, not clamped, whenever 2*baseFeeNext plus the one-gwei floor is above the cap; for cap=1 gwei this occurs for any nonzero baseFeeNext.
```

- `clients/rust-payment-client/src/config.rs:245`

```
if let Some(v) = crate::fees::default_max_fee_per_gas_cap_wei(self.chain_id) {
    return v;
}
When no CLI or TOML override is supplied, write paths using the config resolver inherit the incompatible Base default.
```

## Chronicle NAV price is consumed without an in-scope freshness check

**Severity:** info · oracle_pricing_or_units

**Claim:**

ChronicleOracleAdapter.twapPrice reads ORACLE.latestAnswer() and ignores the timestamp/heartbeat, and the indexed contracts contain no caller of IChronicleOracle.latestTimestamp(). A BasketVault path using this adapter can therefore continue pricing deposits, redemptions, and slippage floors from a stale Chronicle NAV after the feed stops updating; an unprivileged user can enter or exit before the delayed update and dilute existing holders or cause stale-price execution/DoS depending on the stale price direction.

**Evidence:**

- `contracts/adapters/ChronicleOracleAdapter.sol:204`

```
function twapPrice(
        address, /* pool — unused; Chronicle is pool-independent */
        address baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint32 /* window — unused; Chronicle is epoch-independent */
    )
        external
        view
        returns (uint256 quoteAmount)
    {
        if (baseToken == address(0) || quoteToken == address(0)) revert ZeroAddress();
        if (baseAmount == 0) return 0;

        uint256 navPrice = ORACLE.latestAnswer(); // WAD: USDC per RWA, 18 dec
The price used for NAV and slippage floors is the latest answer only; no timestamp or heartbeat is checked in the adapter.
```

- `contracts/adapters/ChronicleOracleAdapter.sol:8`

```
//   - NAV pricing uses the Chronicle push oracle instead of a DEX TWAP.
//     The `window` parameter accepted by `twapPrice()` is ignored; Chronicle provides
//     a single signed price that is authoritative regardless of the lookback window.
//   - The Chronicle oracle heartbeat staleness check is enforced at the RwaVault level
//     (in RwaVault._checkOracleFreshness), not here, to keep this adapter stateless.
The adapter explicitly delegates freshness enforcement elsewhere, but that enforcement contract is not present in the indexed source set.
```

- `contracts/interfaces/IChronicleOracle.sol:31`

```
function latestAnswer() external view returns (uint256 price);

    /// @notice Returns the Unix timestamp of the last price push.
    /// @dev Used by the vault to enforce the staleness heartbeat check.
    /// @return timestamp Unix timestamp (seconds) when `latestAnswer` was last updated.
    function latestTimestamp() external view returns (uint256 timestamp);
The interface exposes a timestamp specifically intended for heartbeat enforcement.
```

```
No references found for: latestTimestamp
No indexed contract actually calls the timestamp method, so the visible BasketVault/adapter integration lacks the promised freshness gate.
```

- `contracts/vaults/BasketVault.sol:785`

```
if (adapter != address(0)) {
            uint32 window = effectiveTwapWindow(token);
            return
                IBasketSwapAdapter(adapter)
                    .twapPrice(pool, token, address(_USDC), tokenAmount, window);
        }
BasketVault consumes the adapter price directly for NAV; the window is passed but ignored by ChronicleOracleAdapter.
```

- `contracts/vaults/BasketVault.sol:517`

```
uint256 supplyBefore = totalSupply();
        uint256 taBefore = totalAssets();
...
        uint256 realizedDelta = totalAssets() - taBefore;
...
        uint256 mintShares = credit.mulDiv(
            supplyBefore + 10 ** _decimalsOffset(), taBefore + 1, Math.Rounding.Floor
        );
Deposits price shares from totalAssets, so a stale Chronicle price can under- or over-value the pre-deposit vault when minting new shares.
```

## Default-weight length guard blocks router eligibility changes from a consistent state

**Severity:** info · logic_error

**Claim:**

VaultRegistry.setRouterEligible requires the linked router's existing non-empty defaultWeightsLength to already equal the post-change routerEligibleCount. In the normal consistent state where defaultWeightsLength equals the current routerEligibleCount, any attempt to add or remove one eligible vault computes a different newCount and reverts. Because the registry only reads defaultWeightsLength and cannot atomically update the router's default vector, governance can be forced into clearing/defaultless intermediate state or be unable to revoke/onboard router eligibility when a vault must be rotated.

**Evidence:**

- `contracts/VaultRegistry.sol:314`

```
uint256 newCount = eligible ? routerEligibleCount + 1 : routerEligibleCount - 1;

if (address(router) != address(0)) {
    uint256 defaultLength = router.defaultWeightsLength();
    if (defaultLength != 0 && defaultLength != newCount) {
        revert StaleDefaultWeightsLength(newCount, defaultLength);
    }
}

routerEligibleCount = newCount;
...
_routerEligible[vault] = eligible;
From a consistent non-empty state defaultLength == routerEligibleCount, a toggle makes newCount routerEligibleCount +/- 1, so defaultLength != newCount and the eligibility change reverts.
```

- `contracts/VaultRegistry.sol:14`

```
interface IRouterDefaultWeights {
    /// @notice Number of legs in the router's default weight vector.
    function defaultWeightsLength() external view returns (uint256);
}
The registry interface to the router is read-only; it cannot update the router vector in the same state transition that changes routerEligibleCount.
```

- `contracts/VaultRegistry.sol:323`

```
// Block stale-length state: if a router is linked and already carries a
// non-empty default weight vector, that vector must be re-set to span
// the new eligible set before (or atomically with) this change. The
// empty default (length 0) is exempt — it means "no default configured
// yet", which is always consistent.
The intended safe transition requires pre-setting or atomic updating, but this contract only checks the old router length and then updates the count, making non-empty consistent states fail ordinary +/-1 eligibility changes.
```

- `contracts/RouterGovernance.sol:335`

```
/// The router enforces: ADMIN_ROLE on the router (this contract must
/// hold it), bps sum == BPS_DENOMINATOR, and length == the
/// registry's router-eligible vault count.
function setDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
    external
    onlyRole(ADMIN_ROLE)
{
    router.setDefaultWeights(vaults, bps);
}
The documented router-side length check makes pre-setting the default vector to the post-change length before routerEligibleCount changes unlikely to succeed, reinforcing the transition deadlock.
```

## Deposit tabs keep successful deposit simulations signable after state-changing deposits

**Severity:** info · state_synchronization

**Claim:**

After a vault-selector or router deposit transaction is mined, the UI only stops treating the transaction as pending; it does not refetch the consumed allowance/balance nor invalidate the `depositSim` request. The same connected user can therefore immediately sign a stale cached deposit request from the already-mutated pre-deposit state, causing an unintended duplicate deposit when allowance/balance still cover it or a reverting transaction/gas loss when exact allowance or balance was consumed.

**Evidence:**

- `clients/dapp/src/components/VaultSelectorDepositTab.tsx:156`

```
const approveWrite = useWriteContract()
const depositWrite = useWriteContract()
...
const depositReceipt = useWaitForTransactionReceipt({
  hash: depositWrite.data as Hash | undefined,
  query: { enabled: Boolean(depositWrite.data) },
});
...
useEffect(() => {
  if (approveReceipt.isSuccess) void refetchAllowance();
}, [approveReceipt.isSuccess, refetchAllowance]);
The component tracks a mined deposit receipt but only refetches allowance after approvals; no equivalent deposit-success effect refreshes allowance or balance after the deposit has consumed them.
```

- `clients/dapp/src/components/VaultSelectorDepositTab.tsx:105`

```
const hasInsufficientBalance =
  depositAssets !== null && typeof usdcBalance === "bigint" && usdcBalance < depositAssets;

const allowanceOk =
  depositAssets !== null && typeof allowance === "bigint" && allowance >= depositAssets;
...
const onDeposit = () => {
  if (!depositSim) return;
  depositWrite.writeContract(depositSim.request);
};
...
<button ... disabled={Boolean(submitDisabledReason) || isPending}>
The post-receipt submit gate continues to rely on cached `usdcBalance`, cached `allowance`, and cached `depositSim.request`; once `isPending` clears there is no state invalidation preventing the old request from being signed again.
```

- `clients/dapp/src/components/RouterDepositTab.tsx:52`

```
const depositReceipt = useWaitForTransactionReceipt({
  hash: depositWrite.data as Hash | undefined,
  query: { enabled: Boolean(depositWrite.data) },
});
...
useEffect(() => {
  if (approveReceipt.isSuccess) void refetchAllowance();
}, [approveReceipt.isSuccess, refetchAllowance]);
The router path has the same pattern: it waits for the mined deposit only for `isPending`, but never refreshes the allowance or invalidates the simulated router deposit after success.
```

- `clients/dapp/src/components/RouterDepositTab.tsx:202`

```
const onDeposit = () => {
  if (!depositSim) return;
  depositWrite.writeContract(depositSim.request);
};
...
<button ... disabled={
  !isConnected ||
  !depositSim ||
  !allowanceOk ||
  isPending ||
  routerPreview?.ok !== true ||
  hasUnavailable === true ||
  vaultListChanged === true
}>
After the receipt is no longer fetching, the stale `depositSim` and stale `allowanceOk` can make the same router calldata signable again.
```

- `clients/dapp/src/components/DepositWithdrawTab.tsx:311`

```
useEffect(() => {
  if (depositReceipt.isSuccess) {
    void refetchAllowance();
    void refetchShareBalance();
  }
}, [depositReceipt.isSuccess, refetchAllowance, refetchShareBalance]);
The legacy deposit tab contains the missing post-deposit refetch pattern, showing the intended state transition that the other deposit tabs omit.
```

## Failed proposals do not automatically restore default router weights

**Severity:** info · logic_error

**Claim:**

RouterGovernance documents the default weight vector as the fallback when the most recent proposal fails quorum, but a proposal becoming Defeated is only a view-state transition and no code clears the router's voted weights on that outcome. After any successful executed proposal has activated voted weights, a later below-quorum proposal leaves those old voted weights active until an ADMIN_ROLE holder manually calls clearVotedWeights, violating the below-quorum fallback invariant and keeping stale allocations live.

**Evidence:**

- `contracts/RouterGovernance.sol:320`

```
/// @notice Set the router's default (below-quorum fallback) weight vector,
///         forwarding to `PortfolioRouter.setDefaultWeights`. This is the
///         on-chain vector the router routes by — and the public allocation
///         surface renders — whenever no proposal is active or the most
///         recent proposal failed quorum. A passed vote overrides it; the
///         default itself stays put as the post-vote fallback.
The stated invariant is that a below-quorum/failed most-recent proposal should make the router fall back to default weights.
```

- `contracts/RouterGovernance.sol:607`

```
if (p.votesFor < p.snapshotQuorum) {
    return ProposalState.Defeated;
}

return ProposalState.Queued;
A proposal becomes Defeated only through a view calculation; this does not mutate router state or clear previously applied voted weights.
```

- `contracts/RouterGovernance.sol:467`

```
if (s == ProposalState.Defeated) revert QuorumNotReached();
...
p.executed = true;

// Apply weights to the Portfolio Router.
router.setWeights(p.vaults, p.bps);
The only automatic router mutation in the proposal lifecycle is the queued/executed success path; the defeated path simply reverts and cannot perform the documented fallback.
```

- `contracts/RouterGovernance.sol:346`

```
/// @notice Clear the router's voted weight vector and revert routing to the
///         default vector. Intended for governance to fall back to the
///         default after the most recent proposal failed quorum. Restricted
///         to ADMIN_ROLE. ADR-0002.
function clearVotedWeights() external onlyRole(ADMIN_ROLE) {
    router.clearVotedWeights();
}
Fallback requires a separate privileged transaction; it is not tied to the proposal's defeated state, so stale voted weights persist if this call is delayed or omitted.
```

- `contracts/RouterGovernance.sol:385`

```
if (currentProposalId != 0) {
    ProposalState s = _state(currentProposalId);
    if (s == ProposalState.Active || s == ProposalState.Queued) {
        revert ActiveProposalExists();
    }
}
After a proposal is Defeated, governance can move on to a new proposal without clearing the router's old voted weights, leaving the documented fallback unenforced.
```

## Fee computation trusts feeHistory base fee without cross-checking current block fee

**Severity:** info · oracle_manipulation

**Claim:**

`compute_fees` uses the last `eth_feeHistory.baseFeePerGas` entry as the next-block base fee and directly signs `2 * baseFeeNext + priorityFee` when it is below the cap. A compromised or inconsistent RPC endpoint can return an artificially low base-fee history, causing the client to build and sign an EIP-1559 transaction whose `maxFeePerGas` is below the real network base fee; the transaction will be rejected or remain stuck, blocking the payment flow until timeout/retry rather than failing over to a truthful endpoint.

**Evidence:**

- `clients/rust-payment-client/src/fees/mod.rs:119`

```
let base_fee_next = base_fee_for_next_block(fee_history)?;
let priority_fee = priority_fee_from_history(fee_history);
Fee selection is fully derived from the caller-provided `FeeHistory` object.
```

- `clients/rust-payment-client/src/fees/mod.rs:141`

```
fn base_fee_for_next_block(fh: &FeeHistory) -> Result<u128> {
    fh.base_fee_per_gas
        .last()
        .copied()
        .ok_or_else(|| RmpcError::ErrRpcDecode("eth_feeHistory: empty base_fee_per_gas".into()))
}
The code trusts the final `base_fee_per_gas` entry as the predicted next-block base fee and only checks that the array is non-empty.
```

- `clients/rust-payment-client/src/fees/mod.rs:128`

```
let target = base_fee_next.saturating_mul(2).saturating_add(priority_fee);

if target > max_fee_cap_wei {
    return Err(RmpcError::ErrFeeCapExceeded);
}

Ok(FeeBid {
    max_fee_per_gas: target,
    max_priority_fee_per_gas: priority_fee,
})
There is no lower-bound sanity check against the latest block's actual base fee or a second RPC source before returning the signed fee bid.
```

## Interactive keystore passphrases are read without disabling terminal echo

**Severity:** info · secret_exposure

**Claim:**

When `RMPC_KEYSTORE_PASSPHRASE` is not set, `read_passphrase_from_env_or_stdin` reads the keystore passphrase with `stdin().read_line` and no terminal echo suppression. In the normal interactive path, the user's passphrase can therefore be displayed on the terminal or captured by terminal/session logging, exposing the secret needed to decrypt the software-signing keystore.

**Evidence:**

- `clients/rust-payment-client/src/signer/software.rs:389`

```
fn read_passphrase_from_env_or_stdin() -> Result<String, SignerError> {
    if let Ok(p) = std::env::var(PASSPHRASE_ENV_VAR) {
        if p.is_empty() {
            return Err(SignerError::ErrPassphrase(format!(
                "{PASSPHRASE_ENV_VAR} is set but empty"
            )));
        }
        return Ok(p);
    }
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
The fallback secret-input path uses plain line input from stdin; it does not switch the terminal to no-echo mode or use a password-input helper.
```

- `clients/rust-payment-client/src/signer/software.rs:222`

```
/// The passphrase is read from [`PASSPHRASE_ENV_VAR`] if set, otherwise
/// from a single line on stdin (passphrase prompts are an operator UX
/// concern; the daemon just reads one line).
pub fn load<P: AsRef<Path>>(
    path: P,
    allow_software_fallback: bool,
) -> Result<Self, SignerError> {
The documented production load path explicitly falls back to the plain stdin reader when the environment variable is absent.
```

- `clients/rust-payment-client/src/signer/software.rs:235`

```
let passphrase = read_passphrase_from_env_or_stdin()?;
Self::load_with_passphrase(path, passphrase.as_bytes(), allow_software_fallback)
The passphrase collected by the echoing input path is used directly to unlock the agent signing key.
```

## JSON-RPC responses without a result are accepted as pending receipts

**Severity:** info · validation_bypass

**Claim:**

RpcClient::call cannot distinguish an absent JSON-RPC result field from an explicit result:null and substitutes Value::Null. For eth_getTransactionReceipt this makes a malformed or attacker-controlled RPC response with neither result nor error decode as Ok(None). Deposit/withdraw receipt waits then treat the transaction as pending until timeout; deposit additionally removes its replay-cache entry on that timeout, allowing retries while the original transaction may still later be mined, causing false ErrTxNotFound/refusal states and duplicate broadcasts or gas loss for the same payment.

**Evidence:**

- `clients/rust-payment-client/src/rpc/mod.rs:159`

```
// `result: null` is a *valid* response (e.g. pending receipt). Hand
// through the literal `Value::Null` so callers that decode into
// `Option<T>` see `None`. Only treat a missing `result` field as
// a protocol violation.
let result = parsed.result.unwrap_or(Value::Null);
serde_json::from_value(result)
    .map_err(|e| RmpcError::ErrRpcDecode(format!("result decode: {e}")))
JsonRpcResponse.result is an Option<Value>, so unwrap_or(Value::Null) treats both an explicit null and a missing field identically despite the comment saying missing result should be a protocol violation.
```

- `clients/rust-payment-client/src/rpc/mod.rs:257`

```
pub async fn get_transaction_receipt(
        &self,
        tx_hash: B256,
    ) -> Result<Option<TransactionReceipt>> {
        match self
            .call("eth_getTransactionReceipt", json!([tx_hash]))
            .await
        {
            Ok(receipt) => Ok(receipt),
            Err(e) if is_indexing_transient(&e) => Ok(None),
            Err(e) => Err(e),
        }
    }
For receipt calls the generic call result is decoded into Option<TransactionReceipt>; a missing result therefore becomes Ok(None), the same state as a genuinely pending transaction.
```

- `clients/rust-payment-client/src/commands/deposit.rs:626`

```
let receipt = match receipt_res {
        Ok(r) => r,
        Err(e) => {
            // RPC-2 (finalize-on-failure): the receipt never confirmed within
            // the budget, so the deposit did not durably succeed. Clear the
            // optimistic replay-cache entry so a legitimate retry is allowed
            // instead of being permanently refused by a poisoned entry.
            finalize_replay_on_failure(
                &replay,
                cfg.chain_id,
                gateway_addr,
                agent_address,
                order_id,
                amount,
                idempotency_key,
            );
A malformed receipt response can drive the wait loop to timeout; the deposit path then clears the replay cache even though the already-broadcast transaction may still be pending/mined later.
```

- `clients/rust-payment-client/src/tx/mod.rs:183`

```
for _ in 0..max_attempts {
        if let Some(r) = rpc.get_transaction_receipt(tx_hash).await? {
            return Ok(r);
        }
        tokio::time::sleep(interval).await;
    }
    Err(RmpcError::ErrRpcTransport(format!(
        "timeout waiting for receipt of {tx_hash:#x}"
    )))
The receipt waiter treats Ok(None) as pending and does not surface malformed responses as errors, so an RPC endpoint can force timeout behavior by omitting result.
```

## Keystore import accepts empty passphrases despite load-time refusal

**Severity:** info · validation_bypass

**Claim:**

The keystore import flow treats `RMPC_KEYSTORE_PASSPHRASE` as valid whenever the environment variable exists, and `SoftwareSigner::create_keystore` performs no minimum-length or non-empty passphrase validation. This lets a normal import invocation create a signer keystore encrypted under an empty passphrase, making the private key trivially recoverable offline if the file is copied; the later load path rejects empty passphrases, so creation and use enforce inconsistent secret policy.

**Evidence:**

- `clients/rust-payment-client/src/bin/rmpc_keystore_import.rs:53`

```
let passphrase = match env::var(PASSPHRASE_ENV_VAR) {
    Ok(s) => s,
    Err(_) => {
        eprintln!("rmpc-keystore-import: ${PASSPHRASE_ENV_VAR} is unset");
        return ExitCode::from(2);
    }
};
The import binary only checks that the passphrase environment variable is present; `Ok("")` is accepted and forwarded.
```

- `clients/rust-payment-client/src/signer/software.rs:149`

```
pub fn create_keystore<P: AsRef<Path>>(
    path: P,
    private_key: &[u8; PRIVKEY_LEN],
    passphrase: &[u8],
) -> Result<Keystore, SignerError> {
    use rand_core::{OsRng, RngCore};
The keystore creation API accepts an arbitrary byte slice for the passphrase and contains no non-empty/minimum-strength validation before deriving the encryption key.
```

- `clients/rust-payment-client/src/signer/software.rs:390`

```
if let Ok(p) = std::env::var(PASSPHRASE_ENV_VAR) {
    if p.is_empty() {
        return Err(SignerError::ErrPassphrase(format!(
            "{PASSPHRASE_ENV_VAR} is set but empty"
        )));
    }
    return Ok(p);
}
The load path explicitly refuses an empty passphrase, showing that empty passphrases are intended to be invalid but are not rejected during keystore import/creation.
```

## Last-admin floor can be bypassed by a zero-address admin grant

**Severity:** info · access_control

**Claim:**

AdminFloorAccessControl only blocks revoking ADMIN_ROLE when the current member count is exactly one. Because it does not reject ADMIN_ROLE grants to address(0), an admin can first grant ADMIN_ROLE to the zero address, making the member count two, and then renounce or be revoked. The floor check then allows the removal and leaves address(0) as the sole ADMIN_ROLE holder, permanently bricking self-administered admin functions.

**Evidence:**

- `contracts/lib/AdminFloorAccessControl.sol:42`

```
function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {
    if (role == FLOOR_ADMIN_ROLE && hasRole(role, account) && getRoleMemberCount(role) == 1) {
        revert LastAdminFloor();
    }
    return super._revokeRole(role, account);
}
The floor is based only on the raw role-member count before revocation; it does not check whether the remaining member is a usable nonzero admin address.
```

- `contracts/RouterGovernance.sol:248`

```
if (_router == address(0) || _admin == address(0)) {
    revert ZeroAddress();
}
...
_setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
_grantRole(ADMIN_ROLE, _admin);
The constructor rejects a zero initial admin, showing zero admins are invalid, but the inherited runtime grantRole path is not similarly guarded by this contract.
```

- `contracts/VaultRegistry.sol:180`

```
constructor(address admin) {
    if (admin == address(0)) revert ZeroAddress();
    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);
}
VaultRegistry has the same self-administered ADMIN_ROLE pattern and only validates the initial admin, so the shared floor can be bypassed after deployment by granting ADMIN_ROLE to address(0).
```

- `tool:find_callers`

```
find_callers("_grantRole") -> contracts/RouterGovernance.sol:266 _grantRole(ADMIN_ROLE, _admin); contracts/VaultRegistry.sol:183 _grantRole(ADMIN_ROLE, admin); contracts/gateway/AccessRoles.sol:66 return super._grantRole(role, account);
There is no project override in AdminFloorAccessControl that rejects zero-address ADMIN_ROLE grants on the inherited grantRole path.
```

## Morpho adapter does not translate the full-withdraw sentinel

**Severity:** info · integration_error

**Claim:**

`MorphoAdapter.withdraw` treats `type(uint256).max` as a special value only in its post-call shortfall check, but it forwards that value unchanged to the ERC-4626 Morpho vault as an exact asset amount. Unlike the Aave and Compound adapters, whose upstream protocols support `uint256.max` as "withdraw all", a MetaMorpho/ERC-4626 vault interprets the argument as the number of assets to withdraw and attempts to burn shares for that amount. A vault-side full-exit path that uses the shared adapter sentinel can therefore succeed for Aave/Compound but revert for Morpho, blocking full strategy unwinds or redemptions until the caller computes an exact withdrawable amount.

**Evidence:**

- `contracts/adapters/MorphoAdapter.sol:62`

```
function withdraw(uint256 amount) external onlyVault returns (uint256) {
    uint256 preBalance = USDC.balanceOf(VAULT);
    MORPHO_VAULT.withdraw(amount, VAULT, address(this));
    uint256 postBalance = USDC.balanceOf(VAULT);
    uint256 actual = postBalance - preBalance;
    if (amount != type(uint256).max && actual < amount) {
        revert WithdrawShortfall(amount, actual);
    }
    return actual;
}
The adapter exempts `type(uint256).max` from the shortfall check, indicating sentinel handling, but forwards it unchanged to `MORPHO_VAULT.withdraw`.
```

- `contracts/adapters/AaveV3Adapter.sol:69`

```
function withdraw(uint256 amount) external onlyVault returns (uint256) {
    uint256 actual = POOL.withdraw(address(USDC), amount, VAULT);
    if (amount != type(uint256).max && actual < amount) {
        revert WithdrawShortfall(amount, actual);
    }
    return actual;
}
The sibling Aave adapter uses the same sentinel branch while Aave's pool API supports `uint256.max` withdrawals, creating a shared-interface expectation that Morpho does not satisfy.
```

- `contracts/adapters/CompoundV3Adapter.sol:64`

```
COMET.withdraw(address(USDC), amount);
...
if (amount != type(uint256).max && actual < amount) {
    revert WithdrawShortfall(amount, actual);
}
The Compound adapter also uses the same sentinel branch; Compound Comet's implementation maps `uint256.max` to `balanceOf(src)` for base-token withdrawals.
```

- `morpho-org/metamorpho/src/MetaMorpho.sol:555`

```
function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256 shares) {
    uint256 newTotalAssets = _accrueFee();
    shares = _convertToSharesWithTotals(assets, totalSupply(), newTotalAssets, Math.Rounding.Ceil);
    _updateLastTotalAssets(newTotalAssets.zeroFloorSub(assets));
    _withdraw(_msgSender(), receiver, owner, assets, shares);
}
The public MetaMorpho/ERC-4626 implementation treats the first parameter as an exact `assets` amount; it does not translate `type(uint256).max` into the caller's balance.
```

## Plain deposits bypass the policy destination allowlist

**Severity:** info · validation_bypass

**Claim:**

RobotMoneyGateway enforces AgentPolicy.allowedDestinations only in depositTo(), but the sibling deposit() entrypoint unconditionally deposits into the pinned vault without checking whether that vault is present in a non-empty allowedDestinations list. An authorized agent can therefore bypass a policy that intentionally restricts destinations to the router or another allowed set by calling deposit() instead of depositTo(vault), causing funds to be routed to a destination the owner excluded while still satisfying the other caps and deadline checks.

**Evidence:**

- `contracts/gateway/RobotMoneyGateway.sol:701`

```
AgentPolicy memory p = agents[msg.sender];
...
// 10. vault deposit; receiver = pre-registered shareReceiver.
sharesMinted = vaultContract.deposit(amount, p.shareReceiver);
The plain deposit path snapshots the policy and deposits into vaultContract, but it never checks p.allowedDestinations before using the implicit vault destination.
```

- `contracts/gateway/RobotMoneyGateway.sol:839`

```
// 4. destination validation + allowedDestinations whitelist.
args.isRouter = _validateDestination(destination, p.allowedDestinations);
args.shareReceiver = p.shareReceiver;
The paired depositTo path does enforce the destination whitelist, showing the policy is intended to constrain destination selection on routed deposits.
```

- `contracts/gateway/RobotMoneyGateway.sol:923`

```
uint256 len = allowedDestinations.length;
if (len > 0) {
    for (uint256 i = 0; i < len; i++) {
        if (allowedDestinations[i] == destination) return isRouter; // allowed
    }
    revert InvalidDestination();
}
When the allowlist is non-empty, a vault destination not listed would be rejected by depositTo(), but deposit() bypasses this helper entirely.
```

- `contracts/gateway/interfaces/IGateway.sol:35`

```
/// @param allowedDestinations     Whitelist of deposit destinations (vault or router
///                                addresses). When non-empty, `depositTo` requires the
///                                supplied destination to appear in this list.
The policy field is explicitly a destination whitelist; the implementation only applies it to one of the two deposit entrypoints.
```

## Preflight trusts active policy without verifying AGENT_ROLE

**Severity:** info · logic_error

**Claim:**

The Rust preflight accepts an agent when agents(agent).active is true and the policy is unexpired, but it never verifies that the signer still has AGENT_ROLE. Because RobotMoneyGateway inherits OpenZeppelin AccessControl, an agent can renounce AGENT_ROLE (or an admin can revoke it) without clearing agents[agent] or agentOwner[agent]. After that state split, preflight run()/run_withdraw_gateway() can return success and allow a transaction to be signed even though deposit(), depositTo(), withdraw(), and withdrawFromRouter() will fail their onlyRole(AGENT_ROLE) gate before executing.

**Evidence:**

- `clients/rust-payment-client/src/policy/mod.rs:272`

```
let agent = self
    .call_view_agents(gateway_addr, inputs.signer_address)
    .await?;
if !agent.active {
    return Err(RmpcError::ErrAgentNotAuthorized);
}
let now = now_unix();
if (agent.validUntil as u64) < now {
    return Err(RmpcError::ErrAgentNotAuthorized);
}
Deposit preflight checks the policy struct but does not call hasRole(AGENT_ROLE, signer_address).
```

- `clients/rust-payment-client/src/policy/mod.rs:176`

```
let agent = self
    .call_view_agents(gateway_addr, inputs.signer_address)
    .await?;
if !agent.active {
    return Err(RmpcError::ErrAgentNotAuthorized);
}
let now = now_unix();
if (agent.validUntil as u64) < now {
    return Err(RmpcError::ErrAgentNotAuthorized);
}
Withdraw gateway preflight has the same blind spot and can report an active policy even when the role gate will fail.
```

- `contracts/gateway/RobotMoneyGateway.sol:701`

```
function deposit(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idempotencyKey)
        external
        nonReentrant
        onlyRole(AGENT_ROLE)
        returns (bytes32 paymentId, uint256 sharesMinted)
The on-chain deposit entrypoint requires AGENT_ROLE in addition to an active policy.
```

- `contracts/gateway/RobotMoneyGateway.sol:806`

```
) external nonReentrant onlyRole(AGENT_ROLE) returns (bytes32 paymentId) {
The routed deposit entrypoint also fails before policy checks if the signer lacks AGENT_ROLE.
```

- `OpenZeppelin/openzeppelin-contracts/contracts/access/AccessControl.sol:155`

```
function renounceRole(bytes32 role, address callerConfirmation) public virtual {
        if (callerConfirmation != _msgSender()) {
            revert AccessControlBadConfirmation();
        }

        _revokeRole(role, callerConfirmation);
    }
An AGENT_ROLE holder can remove its own role through the inherited public AccessControl API without RobotMoneyGateway clearing the policy mapping.
```

## Raw private-key import uses an environment variable as the secret transport

**Severity:** info · secret_exposure

**Claim:**

`rmpc-keystore-import` requires the raw secp256k1 private key in `RMPC_IMPORT_PRIVKEY_HEX`. Although the child process removes the variable after reading it, the key is present in the process environment during startup and remains in the parent shell or launcher environment that set it. Local processes or environment-capturing tooling can therefore recover the unencrypted agent private key before it is converted into the encrypted keystore.

**Evidence:**

- `clients/rust-payment-client/src/bin/rmpc_keystore_import.rs:18`

```
//! Inputs:
//!   argv[1]                   — output keystore path.
//!   $RMPC_IMPORT_PRIVKEY_HEX  — 64-hex-char (optionally 0x-prefixed) secp256k1 private key.
//!   $RMPC_KEYSTORE_PASSPHRASE — passphrase used to encrypt the keystore.
The documented import interface transports the raw signing key through an environment variable.
```

- `clients/rust-payment-client/src/bin/rmpc_keystore_import.rs:42`

```
let privkey_hex = match env::var(PRIVKEY_ENV_VAR) {
    Ok(s) => s,
    Err(_) => {
        eprintln!("rmpc-keystore-import: ${PRIVKEY_ENV_VAR} is unset");
        return ExitCode::from(2);
    }
};
// Best-effort scrub from the child env so subprocesses cannot read it.
env::remove_var(PRIVKEY_ENV_VAR);
The scrub only occurs after process startup and only affects the child process environment; it cannot prevent exposure through the launcher/parent environment or observation before this point.
```

- `clients/rust-payment-client/src/bin/rmpc_keystore_import.rs:73`

```
let mut privkey = [0u8; 32];
privkey.copy_from_slice(&bytes);

match SoftwareSigner::create_keystore(&out_path, &privkey, passphrase.as_bytes()) {
The environment-provided value is the actual raw private key used to create the signing keystore, so exposure compromises the agent account directly.
```

## Receipt timeouts clear replay protection for still-pending transactions

**Severity:** info · replay_protection_bypass

**Claim:**

`ReplayCache::remove` is designed to run when a receipt wait times out, but a timeout only proves the client did not observe finality, not that the broadcast transaction failed. Because `remove` deletes the paymentId entry unconditionally, a user can retry the same deposit inputs while the first transaction is still pending; the client will no longer catch the replay and may sign/broadcast a duplicate transaction, leaving the on-chain idempotency check to revert one transaction and burn gas or obscure the original successful tx hash.

**Evidence:**

- `clients/rust-payment-client/src/replay_cache.rs:210`

```
/// RPC-2 (finalize-on-failure): the cache is populated optimistically
/// right after broadcast, before the receipt is known. When the receipt
/// later reverts or the wait times out, the deposit did NOT durably
/// succeed, so the optimistic entry must be removed
The intended failure finalization conflates receipt timeout with transaction failure; a timed-out transaction can remain pending and later be mined.
```

- `clients/rust-payment-client/src/replay_cache.rs:229`

```
let payment_id =
    compute_payment_id(chain_id, gateway, agent, order_id, amount, idempotency_key);
let key = format!("{payment_id:#x}");
self.with_locked_file(|file, mut map| {
    map.remove(&key);
    write_back(file, &map)
})
Removal is keyed only by payment inputs and does not check the optimistic transaction hash or pending/mined status before clearing the replay entry.
```

- `clients/rust-payment-client/src/replay_cache.rs:156`

```
let map = self.read_locked()?;
Ok(map.get(&key).map(|e| e.tx_hash.clone()))
Subsequent retry preflight only observes whether the paymentId key remains in the cache; after unconditional removal the duplicate is treated as a fresh submission.
```

## Replay cache hard-codes the deposit paymentId namespace

**Severity:** info · logic_error

**Claim:**

ReplayCache.lookup, insert, and remove all call compute_payment_id, and compute_payment_id always hashes OP_DEPOSIT even though the component defines OP_WITHDRAW and OP_DEPOSIT_TO for other authorized actions. Because the public cache API has no operation-kind parameter, a depositTo or withdrawal flow using this component cannot compute its gateway-equivalent paymentId; it will be cached under the deposit namespace. This can make a prior deposit with the same chain/gateway/agent/order_id/amount/idempotency_key falsely block a legitimate depositTo or withdrawal whose on-chain paymentId is intentionally disjoint, and it also records incorrect payment_id values for non-deposit audit/replay decisions.

**Evidence:**

- `clients/rust-payment-client/src/replay_cache.rs:8`

```
//! The `OP_DEPOSIT = 1u8` prefix namespaces deposit ids away from withdrawal
//! ids (which use `OP_WITHDRAW = 2u8`) and depositTo ids (which use
//! `OP_DEPOSIT_TO = 3u8`) — see PAYMENTID-001 / issue #679.
The component explicitly models separate on-chain paymentId namespaces for deposit, withdrawal, and depositTo.
```

- `clients/rust-payment-client/src/replay_cache.rs:63`

```
pub const OP_DEPOSIT: u8 = 1;
...
pub const OP_WITHDRAW: u8 = 2;
...
pub const OP_DEPOSIT_TO: u8 = 3;
The non-deposit namespace constants exist but must be selected by the paymentId computation to mirror the gateway.
```

- `clients/rust-payment-client/src/replay_cache.rs:79`

```
pub fn compute_payment_id(
    chain_id: u64,
    gateway: Address,
    agent: Address,
    order_id: B256,
    amount: U256,
    idempotency_key: B256,
) -> B256 {
    ...
    let encoded = (
        U256::from(OP_DEPOSIT),
        U256::from(chain_id),
        gateway,
        agent,
        order_id,
        amount,
        idempotency_key,
    )
        .abi_encode_sequence();
The only paymentId helper has no operation-kind argument and always encodes OP_DEPOSIT.
```

- `clients/rust-payment-client/src/replay_cache.rs:166`

```
let payment_id =
    compute_payment_id(chain_id, gateway, agent, order_id, amount, idempotency_key);
Each public replay-cache operation derives its key through the deposit-only helper, so callers cannot store or check OP_WITHDRAW/OP_DEPOSIT_TO ids through this API.
```

- `clients/rust-payment-client/src/gateway/mod.rs:88`

```
/// The `depositTo` selector must match
/// `keccak256("depositTo(bytes32,uint256,uint64,bytes32,address,uint256[])")[..4]`.
The client has a non-deposit gateway action whose replay identity is documented as OP_DEPOSIT_TO, but the replay cache cannot select that namespace.
```

- `clients/rust-payment-client/src/commands/mod.rs:25`

```
pub mod withdraw;
pub mod withdraw_router;
The CLI surface includes withdrawal modules that require the OP_WITHDRAW namespace described by the replay-cache component comments.
```

## Rolling-window pruning can exceed block gas after high-frequency use

**Severity:** info · denial_of_service

**Claim:**

The rolling-window buffers can grow to one live entry per second for a full 86,400-second window, and `_pruneWindow` attempts to remove all expired entries in a single unbounded loop. An authorized agent can create many distinct-second entries with minimal deposits, wait until they expire, and then any later deposit or withdrawal for that agent must scan the accumulated expired entries before proceeding, making the agent's gateway operations revert from gas exhaustion. Revocation does not clear the private rolling-window buffers, so the gas-heavy state persists for the same agent address.

**Evidence:**

- `contracts/gateway/RobotMoneyGateway.sol:112`

```
uint64 public constant WINDOW_SECONDS = 86400;
The rolling window permits up to one day of distinct per-second entries.
```

- `contracts/gateway/RobotMoneyGateway.sol:258`

```
uint256 public constant MAX_WINDOW_ENTRIES = WINDOW_SECONDS;
The configured maximum live buffer size is 86,400 entries, far above what can be pruned in one transaction with storage reads.
```

- `contracts/gateway/RobotMoneyGateway.sol:423`

```
while (count > 0 && w.slots[head].timestamp <= cutoff) {
            total -= w.slots[head].amount;
            head = head + 1 == cap ? 0 : head + 1;
            count--;
        }
Pruning all expired entries is performed in one loop whose iteration count is the number of expired live entries.
```

- `contracts/gateway/RobotMoneyGateway.sol:445`

```
// Same-second coalescing: fold into the newest live entry if present.
        if (count > 0) {
            ...
            if (w.slots[newest].timestamp == uint64(block.timestamp)) {
                w.slots[newest].amount += amount;
                w.total += amount;
                return;
            }
        }
        // Distinct second: claim the next ring slot after the newest live entry.
The implementation intentionally creates a new entry for each distinct second, so an agent can grow the live count by submitting one operation per block/second over time.
```

- `contracts/gateway/RobotMoneyGateway.sol:749`

```
_accrueRollingDeposit(msg.sender, amount, p.maxPerWindow);
Every future deposit must call the potentially unbounded prune path before it can proceed.
```

- `contracts/gateway/RobotMoneyGateway.sol:653`

```
delete agents[agent];
        delete agentOwner[agent];
        if (hasRole(AGENT_ROLE, agent)) {
            _revokeRole(AGENT_ROLE, agent);
        }
Revocation clears policy/owner/role but does not clear `_depositWindow` or `_withdrawWindow`, so reusing the same agent address inherits the gas-heavy buffer state.
```

## Router withdrawal cap preflight sums shares with wrapping U256 arithmetic

**Severity:** info · accounting_error

**Claim:**

`withdraw-router` computes `total_shares` with the `U256` `+` operator and then passes only that wrapped sum into `Preflight::run_withdraw_gateway`, while the transaction calldata still contains the original per-leg `sharesPerLeg` values. Because alloy/ruint unsigned integers use modular addition, a caller can choose per-leg shares whose mathematical sum exceeds 2^256-1 and wraps to a small nonzero `total_shares`; the CLI then performs max-withdraw-per-payment/window preflight and audit accounting on the small wrapped value while signing/broadcasting calldata for the much larger per-leg redemption amounts.

**Evidence:**

- `clients/rust-payment-client/src/commands/withdraw_router.rs:139`

```
let shares_per_leg: Vec<U256> = {
        let mut out = Vec::with_capacity(args.shares_per_leg.len());
        for s in &args.shares_per_leg {
            match U256::from_str(s) {
                Ok(v) => out.push(v),
...
let total_shares: U256 = shares_per_leg.iter().fold(U256::ZERO, |a, &b| a + b);
if total_shares == U256::ZERO {
        log::error!("rmpc withdraw-router: --shares-per-leg must have at least one non-zero entry");
        return EXIT_STARTUP_FAIL;
}
The aggregate used for policy is computed with unchecked `a + b`; only the all-zero wrapped result is rejected, so wrap to a small nonzero value is accepted.
```

- `clients/rust-payment-client/src/commands/withdraw_router.rs:405`

```
let preflight_result = rt.block_on(async {
        let pf = Preflight::new(&rpc, &cfg);
        pf.run_withdraw_gateway(PreflightInputs {
            signer_address: agent_address,
            amount: total_shares,
        })
        .await
    });
The gateway withdrawal cap/window preflight sees only the wrapped aggregate, not the mathematical sum of the per-leg redemptions.
```

- `clients/rust-payment-client/src/commands/withdraw_router.rs:546`

```
let calldata = RobotMoneyGateway::withdrawFromRouterCall {
        orderId: order_id,
        vaults: vaults.clone(),
        sharesPerLeg: shares_per_leg.clone(),
        minAssetsPerLeg: min_assets_per_leg.clone(),
        deadline,
        idempotencyKey: idempotency_key,
    }
    .abi_encode();
The signed transaction contains the original per-leg share amounts, so the value checked by preflight can diverge from the amounts sent on chain.
```

- `alloy-rs/ruint/src/add.rs:61`

```
pub const fn overflowing_add(mut self, rhs: Self) -> (Self, bool) {
        ...
        let overflow = carry | (self.limbs[LIMBS - 1] > Self::MASK);
        (self.masked(), overflow)
    }
...
pub const fn wrapping_add(self, rhs: Self) -> Self {
        self.overflowing_add(rhs).0
    }
The upstream integer implementation exposes wrapping addition as the masked result of overflowing_add; its tests also assert modular identities such as `a + (-a) == U::ZERO`, supporting that `+` is modular rather than checked.
```

## Router withdrawal preflight does not aggregate duplicate vault legs

**Severity:** info · validation_bypass

**Claim:**

`withdraw-router` allows the same vault address to appear in multiple legs and checks each `(vault, shares)` leg independently against the current share allowance and balance. If a caller supplies duplicate vault legs where each leg is individually below the allowance/balance but the duplicate legs' aggregate exceeds it, the preflight passes and the CLI signs/broadcasts `withdrawFromRouter` calldata that attempts to spend more shares from that vault than the agent approved or holds, producing a late on-chain failure instead of the intended local refusal.

**Evidence:**

- `clients/rust-payment-client/src/commands/withdraw_router.rs:160`

```
// Parse --vaults. The redeem legs are driven by the caller-supplied
// vaults[] (issue #967): vaults[i] is identity-bound to
// sharesPerLeg[i], so the two arrays must be the same non-empty length.
let vaults: Vec<Address> = { ... }
...
if vaults.len() != shares_per_leg.len() { ... }
The parser enforces non-empty equal-length arrays but does not reject or aggregate duplicate vault addresses.
```

- `clients/rust-payment-client/src/commands/withdraw_router.rs:438`

```
// Run the same per-vault share allowance/balance/paused check the single-vault `withdraw` path
// uses, once per identity-bound (vault, shares) leg.
for (vault, leg_shares) in vaults.iter().zip(shares_per_leg.iter()) {
    let leg_result = rt.block_on(async {
        withdraw_vault_preflight(&rpc, *vault, gateway_addr, agent_address, *leg_shares).await
    });
    if let Err(err) = leg_result { ... }
}
The preflight loops per leg and never accumulates required shares per vault before checking allowance/balance.
```

- `clients/rust-payment-client/src/commands/withdraw.rs:614`

```
let allowance = call_erc20_allowance(rpc, source_vault, agent, gateway).await?;
if allowance < shares {
    return Err(RmpcError::ErrShareAllowanceInsufficient);
}

let balance = call_erc20_balance_of(rpc, source_vault, agent).await?;
if balance < shares {
    return Err(RmpcError::ErrShareBalanceInsufficient);
}
The shared helper compares allowance and balance only against the single leg's `shares`, so duplicate legs can each pass against the same unchanged allowance/balance snapshot.
```

- `clients/rust-payment-client/src/commands/withdraw_router.rs:546`

```
let calldata = RobotMoneyGateway::withdrawFromRouterCall {
    orderId: order_id,
    vaults: vaults.clone(),
    sharesPerLeg: shares_per_leg.clone(),
    minAssetsPerLeg: min_assets_per_leg.clone(),
    deadline,
    idempotencyKey: idempotency_key,
}
.abi_encode();
The duplicate vault legs are forwarded unchanged to the gateway after the false-positive preflight.
```

## Same-block voting-power changes apply retroactively to proposal snapshots

**Severity:** info · accounting_error

**Claim:**

Proposal snapshots and voting-power checkpoints both use only `block.number`, and `_getPastVotes` treats every checkpoint whose `fromBlock <= voteSnapshot` as already active. If voting power is granted or revoked later in the same block as `propose()`, the last same-block checkpoint is returned for that proposal, so an account whose power changed after proposal creation can cast (or lose) voting power on that already-created proposal contrary to the snapshot invariant.

**Evidence:**

- `contracts/RouterGovernance.sol:402`

```
p.snapshotQuorum = quorumThreshold;
        p.voteSnapshot = block.number;
The proposal records only the current block number as its voting-power snapshot, with no transaction-order distinction.
```

- `contracts/RouterGovernance.sol:303`

```
function setVotingPower(address voter, uint256 power) external onlyRole(ADMIN_ROLE) {
        if (voter == address(0)) revert ZeroAddress();
        uint256 old = votingPower(voter);
        totalVotingPower = totalVotingPower - old + power;
        _votingPowerCheckpoints[voter].push(
            VotingPowerCheckpoint(uint64(block.number), uint216(power))
        );
A power change made later in the same block as a proposal stores the same `fromBlock` value as the proposal snapshot.
```

- `contracts/RouterGovernance.sol:595`

```
if (ckpts[mid].fromBlock <= blockNumber) {
                low = mid + 1;
            } else {
                high = mid;
            }
...
        return ckpts[low - 1].power;
The binary search returns the latest checkpoint with `fromBlock <= voteSnapshot`, so a checkpoint appended after proposal creation but in the same block is counted as if it existed at the snapshot.
```

- `contracts/RouterGovernance.sol:450`

```
uint256 power = _getPastVotes(msg.sender, p.voteSnapshot);
        if (power == 0) revert NoVotingPower();

        _hasVoted[proposalId][msg.sender] = true;
        p.votesFor += power;
The retroactively returned power is directly added to the proposal tally.
```

## Stale vault eligibility can leave a queued proposal blocking new weights

**Severity:** info · denial_of_service

**Claim:**

RouterGovernance validates vault eligibility only during propose() and then treats a proposal as Queued solely from votes and timestamps. If a proposed vault becomes ineligible or non-Active before execute(), router.setWeights is expected to revert, but the proposal remains the current Queued proposal. Because propose() rejects while currentProposalId is Active or Queued, no replacement weight proposal can be created until ADMIN_ROLE cancels the stale proposal, delaying removal/reweighting of the affected vault.

**Evidence:**

- `contracts/RouterGovernance.sol:373`

```
for (uint256 i = 0; i < vaults.length; i++) {
    if (!router.isRouterEligibleAndActive(vaults[i])) {
        revert VaultNotEligible(vaults[i]);
    }
}
...
if (currentProposalId != 0) {
    ProposalState s = _state(currentProposalId);
    if (s == ProposalState.Active || s == ProposalState.Queued) {
        revert ActiveProposalExists();
    }
}
Eligibility is checked only before the proposal enters the voting pipeline, and any current Queued proposal blocks creation of a corrective proposal.
```

- `contracts/RouterGovernance.sol:391`

```
p.votingDeadline = deadline;
p.executableAfter = execAfter;
p.snapshotQuorum = quorumThreshold;
p.voteSnapshot = block.number;

// Copy arrays into storage.
for (uint256 i = 0; i < vaults.length; i++) {
    p.vaults.push(vaults[i]);
    p.bps.push(bps[i]);
}
The proposal stores only the vault addresses/weights and snapshots quorum/voting block, not the vault eligibility/status that was validated at proposal time.
```

- `contracts/RouterGovernance.sol:467`

```
ProposalState s = _state(proposalId);
...
if (s == ProposalState.Queued) {
    if (block.timestamp < p.executableAfter) revert ExecutionDelayNotElapsed();
}
...
p.executed = true;

// Apply weights to the Portfolio Router.
router.setWeights(p.vaults, p.bps);
execute does not re-check eligibility or mark/cancel a stale proposal before calling the router; if the router rejects an ineligible/non-Active vault, the whole transaction reverts and the proposal remains queued.
```

- `contracts/RouterGovernance.sol:607`

```
if (block.timestamp <= p.votingDeadline) {
    return ProposalState.Active;
}

// Voting ended — check quorum against snapshot taken at propose() time.
if (p.votesFor < p.snapshotQuorum) {
    return ProposalState.Defeated;
}

return ProposalState.Queued;
Queued state is derived only from time and votes, so a proposal with now-invalid vaults remains Queued and continues to trip ActiveProposalExists.
```

- `contracts/RouterGovernance.sol:375`

```
// Prevents governance deadlock — and self-DoS of router deposits — from proposals
// that would permanently fail on execute() because router.setWeights()
// reverts on a vault that is ineligible ... OR not Active (Paused/Retired).
The contract itself documents that router.setWeights reverts on ineligible/non-Active vaults, which is the stale-window failure mode after propose-time validation.
```

## Uncapped feeHistory rewards can inflate signed priority fees

**Severity:** info · oracle_manipulation

**Claim:**

When max_priority_fee_per_gas_cap is omitted, the fee policy accepts the median priority reward returned by eth_feeHistory as long as the resulting maxFeePerGas stays below the total cap. A malicious or compromised primary RPC endpoint can return low baseFeeNext and high reward values below the total cap, causing the client to sign transactions with an excessive maxPriorityFeePerGas and pay inflated validator tips on-chain; configured failover URLs do not help against a syntactically successful but dishonest feeHistory response.

**Evidence:**

- `clients/rust-payment-client/src/config.rs:121`

```
/// Operator-policy ceiling on `maxPriorityFeePerGas`, in wei.
///
/// Mirrors `max_fee_per_gas_cap`: `compute_fees` refuses
/// (`ErrFeeCapExceeded`) when the observed network tip exceeds
/// this ceiling. Optional in TOML — `None` (i.e. omitted) means
/// "no priority-fee cap"; the `max_fee_per_gas_cap` total still
/// bounds the bid.
#[serde(default)]
pub max_priority_fee_per_gas_cap: Option<u64>,
The documented default leaves the priority-fee component uncapped except by the total maxFeePerGas cap.
```

- `clients/rust-payment-client/src/fees/mod.rs:115`

```
let base_fee_next = base_fee_for_next_block(fee_history)?;
let priority_fee = priority_fee_from_history(fee_history);

// Audit M3: refuse when the observed network tip already exceeds
// the operator's policy ceiling.
if priority_fee > priority_cap_wei {
    return Err(RmpcError::ErrFeeCapExceeded);
}
The priority bid is taken directly from RPC-provided feeHistory rewards and is only rejected if the caller supplies a finite priority cap.
```

- `clients/rust-payment-client/src/fees/mod.rs:153`

```
let mut tips: Vec<u128> = rewards
    .iter()
    .filter_map(|row| row.first().copied())
    .collect();
...
tips.sort_unstable();
let median = tips[tips.len() / 2];
median.max(PRIORITY_FEE_FLOOR_WEI)
A dishonest feeHistory response controls the reward samples used as the priority-fee median.
```

- `clients/rust-payment-client/src/fees/mod.rs:123`

```
let target = base_fee_next.saturating_mul(2).saturating_add(priority_fee);

if target > max_fee_cap_wei {
    return Err(RmpcError::ErrFeeCapExceeded);
}

Ok(FeeBid {
    max_fee_per_gas: target,
    max_priority_fee_per_gas: priority_fee,
})
If the RPC also reports a low baseFeeNext, the inflated priority fee can be accepted up to the total fee cap and placed directly in the signed transaction.
```

- `clients/rust-payment-client/src/config.rs:61`

```
/// When set, `rmpc` tries each URL in order for every JSON-RPC call,
/// moving to the next endpoint on any transport or server error.
/// A request only fails if every listed endpoint fails.
The configured failover model handles failed RPC calls, not successful-but-manipulated feeHistory data from the first responding endpoint.
```

## Uniswap V4 adapter calls a non-official router selector

**Severity:** info · integration_error

**Claim:**

UniswapV4SwapAdapter.swap assumes the configured V4 router exposes exactInputSingle(ExactInputSingleParams) with a sqrtPriceLimitX96 field and returns amountOut, but the official Uniswap v4-periphery routes swaps through the action router/unlock flow and its ExactInputSingleParams has minHopPriceX36 instead of sqrtPriceLimitX96. A BasketVault asset configured for the V4 venue with the official router will therefore revert on every deposit, redeem, or emergency unwind leg that reaches _executeSwap, causing a denial of service for that asset path.

**Evidence:**

- `contracts/adapters/UniswapV4SwapAdapter.sol:109`

```
amountOut = ROUTER.exactInputSingle(
            IUniswapV4SwapRouter.ExactInputSingleParams({
                poolKey: IUniswapV4SwapRouter.PoolKey({
                    currency0: currency0,
                    currency1: currency1,
                    fee: fee,
                    tickSpacing: tickSpacing,
                    hooks: address(0)
                }),
                zeroForOne: zeroForOne,
                amountIn: SafeCast.toUint128(amountIn),
                amountOutMinimum: SafeCast.toUint128(minAmountOut),
                sqrtPriceLimitX96: 0,
                hookData: ""
            })
        );
The adapter makes a direct external call to a simplified exactInputSingle ABI.
```

- `contracts/interfaces/IUniswapV4SwapRouter.sol:25`

```
struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
        bytes hookData;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
The local interface includes sqrtPriceLimitX96 and an external exactInputSingle function.
```

- `Uniswap/v4-periphery/src/interfaces/IV4Router.sol:28`

```
struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }
The official V4 router parameter layout differs: the fifth field is minHopPriceX36, not sqrtPriceLimitX96.
```

- `Uniswap/v4-periphery/src/V4Router.sol:34`

```
function _handleAction(uint256 action, bytes calldata params) internal override {
        // swap actions and payment actions in different blocks for gas efficiency
        if (action < Actions.SETTLE) {
            if (action == Actions.SWAP_EXACT_IN) {
                IV4Router.ExactInputParams calldata swapParams = params.decodeSwapExactInParams();
                _swapExactInput(swapParams);
                return;
            } else if (action == Actions.SWAP_EXACT_IN_SINGLE) {
                IV4Router.ExactInputSingleParams calldata swapParams = params.decodeSwapExactInSingleParams();
                _swapExactInputSingle(swapParams);
                return;
Official v4-periphery handles exact-input swaps as encoded actions inside the router callback flow rather than exposing the local exactInputSingle entrypoint.
```

- `contracts/vaults/BasketVault.sol:1504`

```
IERC20(tokenIn).forceApprove(adapter, amountIn);
            amountOut = IBasketSwapAdapter(adapter)
                .swap(tokenIn, tokenOut, fee, amountIn, minAmountOut, recipient, block.timestamp);
            IERC20(tokenIn).forceApprove(adapter, 0);
Deposits, redemptions, and emergency unwinds route through the adapter swap call, so the incompatible router ABI blocks user-facing vault flows for V4 assets.
```

## Uniswap V4 TWAP path assumes non-existent observable pool contracts

**Severity:** info · integration_error

**Claim:**

UniswapV4SwapAdapter.twapPrice and BasketVault's V4 asset checks treat a V4 pool as a contract exposing token0(), token1(), observe(), slot0(), and liquidity(), but official Uniswap v4-core keeps all pools inside the singleton PoolManager mapping keyed by PoolId/PoolKey and reads state through PoolManager storage helpers. A V4 asset configured against official Uniswap V4 therefore cannot be added/priced, and if a compatible-looking address is forced into configuration, user deposits, redeems, and totalAssets-dependent paths will revert when they call the nonexistent observe/token pair ABI.

**Evidence:**

- `contracts/adapters/UniswapV4SwapAdapter.sol:152`

```
TwapTickMath.checkPoolPair(pool, baseToken, quoteToken);

        int24 meanTick = TwapTickMath.meanTick(pool, window);
        quoteAmount = TwapTickMath.priceFromTick(meanTick, baseToken, quoteToken, baseAmount);
The V4 adapter prices through the supplied pool address using the shared observable-pool helper.
```

- `contracts/lib/TwapTickMath.sol:36`

```
function checkPoolPair(address pool, address baseToken, address quoteToken) internal view {
        address t0 = IObservablePool(pool).token0();
        address t1 = IObservablePool(pool).token1();
The shared helper assumes the pool address is a contract with token0/token1 methods.
```

- `contracts/lib/TwapTickMath.sol:50`

```
function meanTick(address pool, uint32 window) public view returns (int24) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = IObservablePool(pool).observe(secondsAgos);
The NAV and slippage floor path requires observe(uint32[]) on the pool address.
```

- `contracts/interfaces/IUniswapV4Pool.sol:7`

```
///         V4 pools expose the same `observe(uint32[] secondsAgos)` TWAP interface
///         as V3 (EIP-7680 compatibility), so the arithmetic-mean tick computation
///         is identical to the V3 path in BasketVault._twapQuote().
interface IUniswapV4Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128);
The local V4 pool interface encodes the incorrect per-pool observe-contract assumption.
```

- `Uniswap/v4-core/src/PoolManager.sol:80`

```
contract PoolManager is IPoolManager, ProtocolFees, NoDelegateCall, ERC6909Claims, Extsload, Exttload {
    ...
    mapping(PoolId id => Pool.State) internal _pools;
    ...
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external noDelegateCall returns (int24 tick) {
        ...
        PoolId id = key.toId();

        tick = _pools[id].initialize(sqrtPriceX96, lpFee);
        ...
        emit Initialize(id, key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks, sqrtPriceX96, tick);
Official Uniswap V4 pools are state entries inside the singleton PoolManager, not standalone pool contracts with token0/observe methods.
```

- `Uniswap/v4-core/src/libraries/StateLibrary.sol:40`

```
function getSlot0(IPoolManager manager, PoolId poolId)
        internal
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
    {
        // slot key of Pool.State value: `pools[poolId]`
        bytes32 stateSlot = _getPoolStateSlot(poolId);

        bytes32 data = manager.extsload(stateSlot);
Official state reads use PoolManager plus PoolId storage access rather than calling a pool contract's slot0/observe ABI.
```

- `contracts/vaults/BasketVault.sol:448`

```
function totalAssets() public view virtual override returns (uint256) {
        uint256 sum = _USDC.balanceOf(address(this));
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 bal = IERC20(assets[i].token).balanceOf(address(this));
            if (bal > 0) {
                sum += _twapUsdcValue(assets[i].pool, assets[i].token, assets[i].adapter, bal);
Once a V4 asset is active, user-facing vault operations that call totalAssets depend on the faulty V4 TWAP path.
```

## Vault depositTo payment id includes an ignored slippage array

**Severity:** info · logic_error

**Claim:**

For `depositTo` calls targeting the pinned vault, `minSharesPerLeg` has no effect on execution but is still included in the `paymentId`, and the vault branch does not require it to be empty. An authorized agent can therefore repeat the same vault deposit intent (`orderId`, `amount`, `idempotencyKey`, `destination`) by varying the ignored array, producing fresh `paymentId` values that bypass `usedPaymentIds` and execute duplicate deposits up to the policy caps.

**Evidence:**

- `contracts/gateway/RobotMoneyGateway.sol:865`

```
paymentId = keccak256(
            abi.encode(
                OP_DEPOSIT_TO,
                block.chainid,
                address(this),
                msg.sender,
                orderId,
                amount,
                idempotencyKey,
                destination,
                minSharesPerLeg
            )
        );
        if (usedPaymentIds[paymentId]) revert PaymentIdAlreadyUsed();
The replay key changes when the caller changes `minSharesPerLeg`, even if that array has no semantic effect for the selected execution branch.
```

- `contracts/gateway/RobotMoneyGateway.sol:946`

```
function _executeDeposit(DepositArgs memory args, uint256[] calldata minSharesPerLeg) internal {
        if (args.isRouter) {
            _executeRouterDeposit(args, minSharesPerLeg);
        } else {
            _executeVaultDeposit(args);
        }
    }
The vault branch discards `minSharesPerLeg`; only the router branch forwards it.
```

- `contracts/gateway/RobotMoneyGateway.sol:986`

```
function _executeVaultDeposit(DepositArgs memory args) internal {
        uint256 shareBalanceBefore = IERC20(args.destination).balanceOf(address(this));

        usdcToken.forceApprove(args.destination, args.amount);
        uint256 sharesMinted = IERC4626(args.destination).deposit(args.amount, args.shareReceiver);
Vault execution depends on `amount`, `destination`, and `shareReceiver`, but not on the caller-supplied `minSharesPerLeg` array that differentiates payment ids.
```

- `contracts/gateway/interfaces/IGateway.sol:224`

```
/// @param minSharesPerLeg  Per-leg slippage floor (router path only). Pass
    ///                         empty array when routing to a single vault.
The interface documents that `minSharesPerLeg` is router-only, supporting that non-empty arrays for vault deposits are not part of the material vault intent.
```

## Vault query derives share price after decimals read failure

**Severity:** info · logic_error

**Claim:**

get-vault computes a non-null share_price whenever totalAssets and totalSupply succeed, even if vault.decimals() failed. Because VaultData/RegistryVaultData derive Default, decimals remains 0 after the failed subread, so the command emits partial:true but includes a plausible share_price scaled by 10^0 instead of the vault's actual share decimals. A failing/misbehaving vault or RPC decimals response can therefore make downstream users or automation consume a materially under-scaled price rather than an absent value.

**Evidence:**

- `clients/rust-payment-client/src/commands/get_vault.rs:278`

```
match call_decimals(rpc, vault, &block_tag).await {
        Ok(d) => b.data_mut().decimals = d,
        Err(e) => b.record_err("decimals", e),
    }
...
// share_price: only computable when both reads succeeded.
if let (Some(ta), Some(ts)) = (total_assets, total_supply) {
        let decimals = b.data_mut().decimals;
        let price = compute_share_price(ta, ts, decimals);
        b.data_mut().share_price = price;
    }
The derived share_price is gated only on total_assets and total_supply, not on a successful decimals read; after a decimals error it uses the existing data.decimals value.
```

- `clients/rust-payment-client/src/commands/get_vault.rs:358`

```
match call_decimals(rpc, vault, &block_tag).await {
        Ok(d) => b.data_mut().decimals = d,
        Err(e) => b.record_err("decimals", e),
    }
...
if let (Some(ta), Some(ts)) = (total_assets, total_supply) {
        let decimals = b.data_mut().decimals;
        let price = compute_share_price(ta, ts, decimals);
        b.data_mut().share_price = price;
    }
The registry-mode path has the same dependency bug and can emit a derived price from a default decimals value while marking only the decimals field as partial.
```

- `clients/rust-payment-client/src/commands/get_vault.rs:49`

```
#[derive(Debug, Default, Serialize)]
pub struct VaultData {
...
    pub decimals: u8,
...
    pub share_price: Option<String>,
The Default derive initializes decimals to 0, which is indistinguishable from a real zero-decimal vault in the later share_price calculation.
```

- `clients/rust-payment-client/src/commands/get_vault.rs:425`

```
fn compute_share_price(total_assets: U256, total_supply: U256, decimals: u8) -> Option<String> {
    if total_supply.is_zero() {
        return None;
    }
    let scale = U256::from(10u64).pow(U256::from(decimals as u64));
    let numerator = total_assets.saturating_mul(scale);
    let price = numerator / total_supply;
    Some(price.to_string())
}
The price formula is directly scaled by decimals, so using the default 0 can under-scale an 18-decimal vault by 10^18.
```

- `clients/rust-payment-client/src/read_output.rs:184`

```
pub fn finish(self) -> Envelope<T> {
        Envelope {
            chain_id: self.chain_id,
            block_number: self.block_number,
            source: Source::JsonRpc,
            network_env: NetworkEnv::from_chain_id(self.chain_id),
            partial: !self.errors.is_empty(),
            errors: self.errors,
            data: self.data,
        }
    }
The envelope marks partial:true but still includes the data fields; consumers that read share_price may receive a concrete incorrect value rather than None.
```

## Vault status updates can leave direct deposits unhalted when vault sync fails

**Severity:** info · logic_error

**Claim:**

`VaultRegistry.setVaultStatus` writes a vault to `Paused` or `Retired` before calling the vault's `retire()` hook, but wraps that hook in `try/catch` and ignores all failures. For any registered vault whose halt hook reverts, is missing, or is not linked to this registry, the registry can advertise a non-Active status while the vault-level direct-deposit halt remains unset, allowing users to continue depositing directly into a vault that governance intended to pause or retire.

**Evidence:**

- `contracts/VaultRegistry.sol:275`

```
function setVaultStatus(address vault, VaultStatus newStatus) external onlyRole(ADMIN_ROLE) {
        if (!_registered[vault]) revert NotRegistered();
        _status[vault] = newStatus;
...
        if (vault.code.length > 0) {
            if (newStatus == VaultStatus.Active) {
                try IRetirableVault(vault).unretire() {} catch {}
            } else {
                try IRetirableVault(vault).retire() {} catch {}
            }
        }

        emit VaultStatusChanged(vault, newStatus, block.timestamp);
    }
The registry status is committed and the non-Active event is emitted even if the vault-level halt call fails, because the catch block is empty.
```

- `contracts/VaultRegistry.sol:257`

```
/// @notice Update a vault's lifecycle status, driving the vault's own
    ///         deposit-halt flag in the same call so registry status and the vault
    ///         flag never drift (LIFE-1; finding F-04 residual).
The documented invariant for this entrypoint is that registry status and vault deposit-halt state stay synchronized; swallowing the hook failure violates that invariant.
```

- `contracts/VaultRegistry.sol:234`

```
function retire(address vault) external onlyRole(ADMIN_ROLE) {
        if (!_registered[vault]) revert NotRegistered();
        _status[vault] = VaultStatus.Retired;
        IRetirableVault(vault).retire();
        emit VaultStatusChanged(vault, VaultStatus.Retired, block.timestamp);
    }
The dedicated retire path is atomic because a failed vault hook reverts the status update, showing the safer lifecycle behavior that `setVaultStatus` bypasses.
```

- `contracts/VaultRegistry.sol:54`

```
/// @dev Retired: withdraw-only. Existing depositors keep standard
        ///      ERC-4626 `redeem` at any time and `PortfolioRouter` routes no
        ///      new deposits here.
A Retired status is intended to be withdraw-only; if the vault hook failure is ignored, direct deposits can remain possible despite the registry state.
```

## Voting power setter silently truncates values above uint216

**Severity:** info · accounting_error

**Claim:**

RouterGovernance.setVotingPower accepts a uint256 power and accounts totalVotingPower/events using that full value, but stores the checkpoint as uint216 without validating the range. A power value above type(uint216).max is silently truncated for votingPower() and vote() while totalVotingPower records the untruncated amount, producing inconsistent governance accounting and potentially making an apparently funded voter unable to vote or making displayed total voting power unreachable.

**Evidence:**

- `contracts/RouterGovernance.sol:303`

```
function setVotingPower(address voter, uint256 power) external onlyRole(ADMIN_ROLE) {
    if (voter == address(0)) revert ZeroAddress();
    uint256 old = votingPower(voter);
    totalVotingPower = totalVotingPower - old + power;
    _votingPowerCheckpoints[voter].push(
        VotingPowerCheckpoint(uint64(block.number), uint216(power))
    );
    emit VotingPowerSet(voter, old, power);
}
The function accepts uint256 and updates totalVotingPower with the full value, then downcasts to uint216 for the actual voting checkpoint without a range check.
```

- `contracts/RouterGovernance.sol:314`

```
function votingPower(address voter) public view returns (uint256) {
    VotingPowerCheckpoint[] storage ckpts = _votingPowerCheckpoints[voter];
    if (ckpts.length == 0) return 0;
    return ckpts[ckpts.length - 1].power;
}
The displayed/current voting power is read from the truncated uint216 checkpoint, not from the full amount added to totalVotingPower.
```

- `contracts/RouterGovernance.sol:444`

```
uint256 power = _getPastVotes(msg.sender, p.voteSnapshot);
if (power == 0) revert NoVotingPower();

_hasVoted[proposalId][msg.sender] = true;
p.votesFor += power;
Votes are tallied from the checkpointed value, so a power such as 2^216 records a large totalVotingPower increase but truncates to zero voting power at the checkpoint.
```
