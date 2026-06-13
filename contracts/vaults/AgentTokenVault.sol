// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (agent-token basket)
// (See also: docs/technical/basket-vault-gap-report.md — router-eligibility checklist;
//            docs/adr/ADR-0001-mvp-agent-token-shortlist.md — accepted MVP shortlist;
//            docs/adr/ADR-0004-agent-token-shortlist-governance.md — production governance
//            mechanism (admin multisig + TimelockController, 48h addAsset / 24h removeAsset
//            delays, public veto window). ADR-0004 resolves open-questions §1.3 and §1.4
//            and unblocks rmAGENT router-eligibility pending TWAP oracle, rebalancing
//            model, and liquidity proof gaps.)
// Production-readiness: not audited. Router-eligibility is registry state
// (VaultRegistry.isRouterEligible) set by governance once audit / oracle hardening
// is complete. See docs/development/single-production-codebase.md.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {BasketVault} from "./BasketVault.sol";

/// @title AgentTokenVault
/// @notice ERC-4626 USDC vault holding a basket of agent-economy tokens curated
///         via a governed shortlist. Swaps in/out via Uniswap V3.
///
///         ## Shortlist governance (ADR-0004)
///
///         In production, ADMIN_ROLE is held by a TimelockController deployed by
///         DeployTimelock.s.sol. The Safe (≥2-of-3 multisig) is the sole PROPOSER.
///         Every shortlist change must flow through the timelock:
///
///         - `addAsset`    — minimum 48-hour delay before execution
///         - `removeAsset` — minimum 24-hour delay before execution
///
///         During the delay window any observer may inspect the pending change via
///         the `TimelockController.CallScheduled` event and raise a public challenge.
///         Any Safe signer may cancel a queued change unilaterally via
///         `TimelockController.cancel(id)` before execution (veto path).
///
///         The `CANCELLER_ROLE` on `TimelockController` may later be extended to an
///         RM-token veto module (Option B in ADR-0004) without redeploying this vault.
///
///         ## addAsset gate criteria (ADR-0004)
///
///         Before proposing a new token via TimelockController, the Safe MUST verify:
///         - Market cap ≥ $10M 30-day trailing average
///         - Listing age ≥ 90 days on-chain (Base or bridged)
///         - Daily volume ≥ $100K 30-day trailing average
///         - Holder count ≥ 500 distinct holders
///         - Oracle: Uniswap V3 pool on Base with ≥ 30-day TWAP history for the
///           USDC pair (or a Chainlink feed with ≥ 30-day history)
///         - Liquidity depth ≥ $50K within 2% of mid-price on the primary
///           Uniswap V3 pool (synchronous-redemption guarantee at ≤300 bps slippage)
///
///         Gate evidence is recorded in the TimelockController.schedule() calldata
///         or as a linked off-chain hash (IPFS CID or governance-forum post URL).
///         The contract enforces pool cardinality and token/USDC pairing on-chain
///         via BasketVault.addAsset(); all other gate criteria are verified off-chain
///         by the Safe signers at proposal time.
///
///         ## Operational notes
///
///         The active shortlist is seeded
///         from config/agent-token-shortlist.json via
///         contracts/script/DeployAgentTokenVault.s.sol — no token address is
///         hardcoded here.
///
///         Depositors receive rmAGENT shares. Basket contents change only when
///         admin adds or removes assets via the timelock path. Existing positions
///         are unaffected until the vault is rebalanced or the user redeems.
///
///         Risk label: SPECULATIVE — agent tokens are volatile and may have
///         limited swap liquidity. Set slippageBps accordingly per shortlist.
///
/// Base mainnet SwapRouter02: 0x2626664c2603336E57B271c5C0b26F421741e481
contract AgentTokenVault is BasketVault {
    uint256 private constant _MAX_ASSETS = 15;
    uint256 private constant _DEFAULT_SLIPPAGE_BPS = 300; // 3% — agent tokens are less liquid

    /// @notice Minimum timelock delay required for addAsset proposals (48 hours).
    ///         Enforced off-chain by the Safe signers; recorded here for reference
    ///         and off-chain monitoring tooling.
    uint256 public constant SHORTLIST_ADD_DELAY = 48 hours;

    /// @notice Minimum timelock delay required for removeAsset proposals (24 hours).
    ///         Enforced off-chain by the Safe signers; recorded here for reference
    ///         and off-chain monitoring tooling.
    uint256 public constant SHORTLIST_REMOVE_DELAY = 24 hours;

    constructor(
        IERC20 usdc_,
        ISwapRouter swapRouter_,
        uint256 tvlCap_,
        uint256 perDepositCap_,
        uint256 exitFeeBps_,
        address feeRecipient_,
        address admin_,
        address emergencyResponder_
    )
        BasketVault(
            "Robot Money Agent Tokens",
            "rmAGENT",
            usdc_,
            swapRouter_,
            tvlCap_,
            perDepositCap_,
            exitFeeBps_,
            _DEFAULT_SLIPPAGE_BPS,
            feeRecipient_,
            admin_,
            emergencyResponder_
        )
    {}

    function maxAssets() public pure override returns (uint256) {
        return _MAX_ASSETS;
    }

    // ─── Shortlist management ─────────────────────────────────────────
    //
    // addAsset and removeAsset are inherited from BasketVault and gated on
    // ADMIN_ROLE. In production, ADMIN_ROLE is held by a TimelockController
    // so every shortlist change must be scheduled via timelock.schedule()
    // with at least SHORTLIST_ADD_DELAY (addAsset) or SHORTLIST_REMOVE_DELAY
    // (removeAsset) before execution. See ADR-0004 and the NatSpec above.

    /// @notice Returns token address, pool, swap fee, active flag, and current vault balance
    ///         for every shortlist entry. Intended for off-chain display and rmpc reads.
    function shortlist()
        external
        view
        returns (
            address[] memory tokens,
            address[] memory pools,
            uint24[] memory fees,
            bool[] memory active,
            uint256[] memory balances
        )
    {
        uint256 len = assets.length;
        tokens = new address[](len);
        pools = new address[](len);
        fees = new uint24[](len);
        active = new bool[](len);
        balances = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            tokens[i] = assets[i].token;
            pools[i] = assets[i].pool;
            fees[i] = assets[i].swapFee;
            active[i] = assets[i].active;
            balances[i] = IERC20(assets[i].token).balanceOf(address(this));
        }
    }
}
