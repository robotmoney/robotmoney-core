// SPDX-License-Identifier: MIT
// Canonical: docs/code-reviews/20261121-214700-agy/05-meta-review-and-missed-findings.md (MISSED-02)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AssetConfig, AssetKind, Venue} from "../FundTypes.sol";
import {FundState} from "../lib/FundStorage.sol";
import {FundDelistLib} from "../lib/FundDelistLib.sol";

contract ScalingToken is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @notice The fund's delisting books on their own: the claim units and the USDC pot of one in-sale asset.
contract DelistBooks {
    FundState internal s;
    ScalingToken public immutable token;

    constructor(ScalingToken t, uint256 fundTokens) {
        token = t;
        AssetConfig memory a;
        a.kind = AssetKind.Basket;
        a.active = true;
        a.token = address(t);
        a.venue = Venue.V3;
        s.assets.push(a);
        s.targetBps.push(0);
        s.inSale[0] = true;
        t.mint(address(this), fundTokens);
    }

    function claimed() external view returns (uint256) {
        return s.delistClaimedTokens[0];
    }

    function fundTokens() public view returns (uint256) {
        return token.balanceOf(address(this)) - s.delistClaimedTokens[0];
    }

    /// @dev A redemption sets `tok` of the fund's own tokens aside for `owner` (no fee).
    function claim(address owner, uint256 tok) external {
        FundDelistLib.recordDelistClaim(s, 0, owner, tok, 0);
    }

    /// @dev One sale step of `sold` tokens for `usdc` (the swap burns them here).
    function sell(uint256 sold, uint256 usdc) external {
        uint256 fundBefore = fundTokens();
        uint256 claimedBefore = s.delistClaimedTokens[0];
        token.burn(address(this), sold);
        FundDelistLib.finalizeDelistSale(s, 0, sold, usdc, 0, fundBefore, claimedBefore, false);
    }

    function pay(address owner) external returns (uint256 net) {
        (net,,) = FundDelistLib.consumeDelistClaim(s, 0, owner);
    }
}

/// @title DelistClaimScalingTest
/// @notice MISSED-02 claimed that claim units inflate across partial sales until a claimer's USDC rounds to zero. A
///         long sale (1 000 steps of 5 % each) with a new claim before every step must still pay each claimer its fair
///         share: its tokens at the sale price.
contract DelistClaimScalingTest is Test {
    uint256 internal constant PRICE = 3_000e6; // USDC per whole token
    uint256 internal constant STEPS = 1000;

    function test_MISSED02_longSalePaysEveryClaimerItsShare() public {
        ScalingToken t = new ScalingToken();
        DelistBooks b = new DelistBooks(t, 1_000e18);
        address[] memory who = new address[](STEPS);
        uint256[] memory claimTok = new uint256[](STEPS);

        for (uint256 k; k < STEPS; ++k) {
            who[k] = address(uint160(0xC1A1 + k));
            claimTok[k] = b.fundTokens() / 200; // 0.5 % of the fund's tokens
            b.claim(who[k], claimTok[k]);
            uint256 total = b.fundTokens() + b.claimed();
            uint256 sold = k + 1 == STEPS ? total : total / 20; // 5 % a step, everything at the last
            b.sell(sold, sold * PRICE / 1e18);
        }
        assertEq(b.claimed(), 0, "the sale sold every claimed token");

        uint256 worstBps = 10_000;
        for (uint256 k; k < STEPS; ++k) {
            uint256 fair = claimTok[k] * PRICE / 1e18;
            uint256 got = b.pay(who[k]);
            uint256 bps = fair == 0 ? 10_000 : got * 10_000 / fair;
            if (bps < worstBps) worstBps = bps;
            // Each simulated step rounds its own proceeds down, so allow 100 units (0.0001 USDC) on top of 0.01 %.
            assertGe(got + 100, fair - fair / 10_000, "every claimer gets its share, to 0.01 %");
        }
        emit log_named_uint("worst claimer share of fair (bps)", worstBps);
    }
}
