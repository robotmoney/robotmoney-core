// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (agent-token basket)
// (See also: docs/technical/basket-vault-gap-report.md; docs/development/open-questions.md §1.3 — shortlist governance)
// PROTOTYPE — not audited, not for production use.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {BasketVault} from "./BasketVault.sol";

/// @title AgentTokenVault
/// @notice PROTOTYPE ERC-4626 USDC vault holding a basket of agent-economy tokens
///         curated by ADMIN_ROLE. Swaps in/out via Uniswap V3.
///
///         The shortlist is admin-controlled for this prototype. In production this
///         will be replaced by on-chain RM-token governance or a bribery mechanism
///         (see docs/development/open-questions.md §1.3, §1.4, §3.2).
///
///         Depositors receive rmAGENT shares. Basket contents change only when
///         admin adds or removes assets. Existing positions are unaffected until
///         the vault is rebalanced or the user redeems.
///
///         Risk label: SPECULATIVE — agent tokens are volatile and may have
///         limited swap liquidity. Set slippageBps accordingly per shortlist.
///
/// Base mainnet SwapRouter02: 0x2626664c2603336E57B271c5C0b26F421741e481
contract AgentTokenVault is BasketVault {
    uint256 private constant _MAX_ASSETS = 15;
    uint256 private constant _DEFAULT_SLIPPAGE_BPS = 300; // 3% — agent tokens are less liquid

    constructor(
        IERC20 usdc_,
        ISwapRouter swapRouter_,
        uint256 tvlCap_,
        uint256 perDepositCap_,
        uint256 exitFeeBps_,
        address feeRecipient_,
        address admin_
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
            admin_
        )
    {}

    function maxAssets() public pure override returns (uint256) {
        return _MAX_ASSETS;
    }

    // ─── Shortlist management (admin-curated in this prototype) ───────

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
