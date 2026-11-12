// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.1 (per-asset targets), §4.2 (NAV), §5.1 (plan), §6.1 (size)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {AssetConfig, Plan} from "../FundTypes.sol";

/// @notice Every piece of `RobotMoneyFund` state outside the OpenZeppelin namespaces, in one struct so the
///         delegatecall-linked fund libraries (`FundValuationLib`, `FundFlowsLib`, `FundAdminLib`) take one
///         storage reference per call (§6.1: logic lives in linked libraries to keep the fund under EIP-170).
/// @param assets          The asset list (§4.1). Indices are stable: deactivated, never removed.
/// @param codeHashAllowed Adapter runtime code hashes ADMIN approved (ADP-2 / NC-2). A Lending asset whose
///                        adapter code hash is revoked leaves NAV and opens an exclusion record (§4.2).
/// @param usdc            The underlying (cached `asset()`).
/// @param tvlCap          Max `totalAssets()` after a deposit.
/// @param perDepositCap   Max USDC per deposit.
/// @param exitFeeBps      Exit fee on realized redeem proceeds (<= 100).
/// @param feeRecipient    Exit fee recipient.
/// @param maxSlippageBps  Deposit / redeem swap floor against TWAP (<= 500, above every basket pool fee).
/// @param navDeviationGuardBps ORA-4 band (0 disables; else above every basket pool fee and <= 2 000).
/// @param depositsPaused  EMERGENCY pause of deposit and mint only.
/// @param shutdown        EMERGENCY shutdown: deposits closed, tvlCap 0, until ADMIN `restore`.
/// @param lastStepAt      Timestamp of the last executed step over all plans (§5.3 step 1).
/// @param targetBps       Persistent end target per asset, index-aligned (pushed 0 on `addAsset`).
/// @param plan            The current plan (§5.1, §5.5); the latest opened, possibly terminal.
/// @param deferredTotal   Per asset: the amount the fund still owes to `redeemInKind` exits whose leg could not
///                        pay out (§4.4, §5.8 row 7, RB-6). Basket: token units still in the fund's balance.
///                        Lending: USDC still inside the adapter. Never counted in NAV or in any pro-rata leg.
/// @param deferredOf      Per asset and account: that account's part of `deferredTotal` (`claimDeferred`).
/// @param rolesBound      `bindRebalanceRoles` ran (GOVERNANCE_ROLE and REBALANCER_ROLE bind once, RB-1).
///
///        Step 3d (proposal §4.5, §5.9; eng plan E1, E9, E13, E14, E19, E20). Appended after `rolesBound`:
/// @param flowQueue          The FlowQueue that holds FLOW_ROLE (`bindFlowRole`, once). address(0) before binding.
///                           `ledgerBalanceOf(flowQueue)` is 0 (E13: the queue's own address has no entitlement).
/// @param flowRoleBound      `bindFlowRole` ran.
/// @param seeded             `seed` ran (E14). Set once, never cleared.
/// @param minSeedUsdc        Least USDC `seed` accepts (§5.9.5, default `DEFAULT_MIN_SEED_USDC`).
/// @param poolShareBps       Pool-share rule of §4.5 rule 3 (default `DEFAULT_POOL_SHARE_BPS`).
/// @param positionUnits      Per Lending asset index: total units of that lending position (E9, RB-21). Units are
///                           minted and burned as the fund's position changes, so one unit is always the same
///                           fraction of the position. Holders' units are `positionUnits - positionClaimTotal`.
/// @param positionClaimTotal Per Lending asset index: units held by position-share claims of past in-kind exits.
/// @param positionClaimOf    Per Lending asset index and account: that account's claim units (`claimPosition`).
/// @param inKindUsed         Per period index (`block.timestamp / inKindPeriod`, below): lending USDC that left the
///                           venues for in-kind exits in that period, fee included (E20 allowance).
/// @param lastGoodNav        The last NAV computed while every feed was healthy (E19), USDC 6 decimals.
/// @param lastGoodNavAt      Its timestamp.
///
///        Appended by fund-extras (scaffold plan §7.4):
/// @param inKindBps          In-kind allowance per period, in bps of the fund's lending holdings (E20).
/// @param inKindFloorUsdc    The allowance is at least this many USDC per period.
/// @param inKindPeriod       Period length in seconds; `inKindUsed` is keyed by `block.timestamp / inKindPeriod`.
///                           The fund holds these three itself (coordinator ruling 6, proposal §5.9.5), so
///                           `inKindUsed` is keyed by this period, not by the queue's `epochLength`.
struct FundState {
    AssetConfig[] assets;
    mapping(bytes32 codeHash => bool allowed) codeHashAllowed;
    address usdc;
    uint256 tvlCap;
    uint256 perDepositCap;
    uint256 exitFeeBps;
    address feeRecipient;
    uint256 maxSlippageBps;
    uint256 navDeviationGuardBps;
    bool depositsPaused;
    bool shutdown;
    uint64 lastStepAt;
    uint16[] targetBps;
    Plan plan;
    mapping(uint256 index => uint256) deferredTotal;
    mapping(uint256 index => mapping(address account => uint256)) deferredOf;
    bool rolesBound;
    // ── Step 3d (append-only below this line) ──
    address flowQueue;
    bool flowRoleBound;
    bool seeded;
    uint256 minSeedUsdc;
    uint16 poolShareBps;
    mapping(uint256 index => uint256) positionUnits;
    mapping(uint256 index => uint256) positionClaimTotal;
    mapping(uint256 index => mapping(address account => uint256)) positionClaimOf;
    mapping(uint256 period => uint256) inKindUsed;
    uint256 lastGoodNav;
    uint64 lastGoodNavAt;
    // ── fund-extras (append-only below this line) ──
    uint16 inKindBps;
    uint128 inKindFloorUsdc;
    uint32 inKindPeriod;
}

/// @title FundStorage
/// @notice ERC-7201 namespaced location of `FundState` (`robotmoney.storage.RobotMoneyFund`), so the fund's
///         own state can never collide with the OpenZeppelin upgradeable namespaces behind `GovernedUUPS`.
library FundStorage {
    /// @dev keccak256(abi.encode(uint256(keccak256("robotmoney.storage.RobotMoneyFund")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0x1f474ae58db9fb6ccfa907fed2f1bf5577ac55e97dddcd5c18f25868bd856c00;

    /// @dev Basket TWAP window bounds (BasketVault.MIN_TWAP_WINDOW / MAX_TWAP_WINDOW).
    uint32 internal constant MIN_TWAP_WINDOW = 600;
    uint32 internal constant MAX_TWAP_WINDOW = 86_400;
    /// @dev BasketVault.MIN_POOL_LIQUIDITY: in-range liquidity floor checked at `addAsset`.
    uint128 internal constant MIN_POOL_LIQUIDITY = 1e6;
    /// @dev BasketVault / RobotMoneyVault ceilings.
    uint256 internal constant MAX_EXIT_FEE_BPS = 100;
    uint256 internal constant MAX_SLIPPAGE_BPS = 500;
    uint256 internal constant MAX_NAV_DEVIATION_BPS = 2_000;

    /// @dev The fund's state.
    function layout() internal pure returns (FundState storage $) {
        bytes32 slot = SLOT;
        assembly {
            $.slot := slot
        }
    }
}
