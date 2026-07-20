// SPDX-License-Identifier: MIT
// Canonical: docs/technical/unified-vault-spec.md §2 (`IPositionAdapter`), §3 (lending retrofit);
//            docs/adr/ADR-0010-unified-vault-architecture.md §2.
//
// IPositionAdapter conformance suite for the retrofitted lending adapters
// (MorphoAdapter / AaveV3Adapter / CompoundV3Adapter, issue #1117). These
// exercise the REAL adapter bytecode — only the external lending venue is a
// local mock — so every assertion executes unconditionally in the always-on
// `forge test (unit)` CI job (non-zero count, no fork RPC, no skip). They prove
// the frozen surface end-to-end for the exact (1:1) lending adapters:
//   • identity getters USDC()/VAULT() return the constructor-bound addresses;
//   • isExact() == true;
//   • deploy(usdcIn, usdcIn) returns valueAdded == usdcIn and totalAssets()
//     increases by usdcIn;
//   • deploy reverts SlippageExceeded below the min-out floor;
//   • withdraw(usdcWanted, usdcWanted) delivers >= minUsdcOut to the vault;
//   • withdraw clamps an over-ask at the liquidatable balance;
//   • withdraw reverts SlippageExceeded when realized < minUsdcOut;
//   • deploy/withdraw are onlyVault (revert OnlyVault);
//   • harvestRewards() is a permissionless no-op; sweepForeignToken quarantines.
//
// Real-venue validation against a pinned Base mainnet fork is intentionally NOT
// here: the repository's fork RPC secret (RMPC_FORK_RPC_URL) is unprovisioned,
// so a fork test could only silent-skip or break CI. The exact-adapter semantics
// are venue-independent (1:1 USDC), so a faithful 1:1 mock venue exercises the
// same adapter code paths the fork would.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../adapters/CompoundV3Adapter.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Faithful 1:1 mock venues (uniquely named to avoid forge-doc re-link collisions)
// ─────────────────────────────────────────────────────────────────────────────

/// @dev 1:1 ERC-4626 mock supporting deposit / withdraw / redeem (the Morpho
///      retrofit's withdraw-all + over-ask paths drain via `redeem(shares)`).
contract PosConfMorphoVault is ERC20 {
    IERC20 public immutable asset;

    constructor(address asset_) ERC20("Pos Morpho", "pmUSDC") {
        asset = IERC20(asset_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        asset.transferFrom(msg.sender, address(this), assets);
        shares = assets; // 1:1
        _mint(receiver, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares)
    {
        shares = assets; // 1:1
        _burn(owner, shares);
        asset.transfer(receiver, assets);
    }

    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        assets = shares; // 1:1
        _burn(owner, shares);
        asset.transfer(receiver, assets);
    }

    function convertToAssets(uint256 shares_) external pure returns (uint256) {
        return shares_; // 1:1
    }
}

/// @dev 1:1 Aave V3 Pool mock. `supply` pulls USDC and mints aTokens; `withdraw`
///      supports the type(uint256).max full-balance sentinel and returns actual.
contract PosConfAavePool {
    IERC20 public immutable usdc;
    TestERC20 public immutable aToken;

    constructor(address usdc_, address aToken_) {
        usdc = IERC20(usdc_);
        aToken = TestERC20(aToken_);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == address(usdc), "wrong asset");
        usdc.transferFrom(msg.sender, address(this), amount);
        aToken.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(usdc), "wrong asset");
        uint256 bal = aToken.balanceOf(msg.sender);
        uint256 out = amount == type(uint256).max ? bal : amount;
        aToken.burn(msg.sender, out);
        usdc.transfer(to, out);
        return out;
    }
}

/// @dev 1:1 Compound V3 Comet mock: supply/withdraw credit/debit msg.sender and
///      route USDC to/from msg.sender; supports the max full-balance sentinel.
contract PosConfComet {
    IERC20 public immutable usdc;
    mapping(address => uint256) public balanceOf;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function supply(address asset, uint256 amount) external {
        require(asset == address(usdc), "wrong asset");
        usdc.transferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
    }

    function withdraw(address asset, uint256 amount) external {
        require(asset == address(usdc), "wrong asset");
        uint256 bal = balanceOf[msg.sender];
        uint256 out = amount == type(uint256).max ? bal : amount;
        require(out <= bal, "insufficient");
        balanceOf[msg.sender] = bal - out;
        usdc.transfer(msg.sender, out);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared conformance behaviour. Each concrete suite wires a real adapter to its
// mock venue via _setUpAdapter() and _positionOf().
// ─────────────────────────────────────────────────────────────────────────────

abstract contract PositionConformanceBase is Test {
    TestERC20 internal usdc;
    IPositionAdapter internal adapter;

    address internal vault = makeAddr("vault");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant AMT = 100 * ONE_USDC;

    /// @dev Deploy the concrete adapter + its mock venue. Sets `adapter`.
    function _setUpAdapter() internal virtual;

    /// @dev The adapter's protected venue receipt/share token (for the sweep
    ///      protected-token assertion). address(0) if none applies.
    function _shareToken() internal view virtual returns (address);

    function setUp() public {
        usdc = new TestERC20();
        _setUpAdapter();
    }

    /// @dev Simulate the vault's `safeTransfer` choreography then vault-deploy.
    function _fundAndDeploy(uint256 amount) internal {
        usdc.mint(address(adapter), amount);
        vm.prank(vault);
        adapter.deploy(amount, amount);
    }

    // ── identity + exactness ────────────────────────────────────────────────

    function test_identityViews_returnConstructorBound() public view {
        assertEq(adapter.USDC(), address(usdc), "USDC() not bound");
        assertEq(adapter.VAULT(), vault, "VAULT() not bound");
    }

    function test_isExact_true() public view {
        assertTrue(adapter.isExact(), "lending adapter must be exact");
    }

    // ── deploy: exactness + min-out floor + authority ───────────────────────

    function test_deploy_returnsUsdcInAndIncreasesTotalAssets() public {
        uint256 before = adapter.totalAssets();
        usdc.mint(address(adapter), AMT); // vault-choreographed transfer
        vm.prank(vault);
        uint256 valueAdded = adapter.deploy(AMT, AMT);
        assertEq(valueAdded, AMT, "exact adapter must return usdcIn");
        assertApproxEqAbs(adapter.totalAssets(), before + AMT, 1, "totalAssets += usdcIn");
    }

    function test_deploy_revertsBelowFloor() public {
        usdc.mint(address(adapter), AMT);
        vm.prank(vault);
        vm.expectRevert(IPositionAdapter.SlippageExceeded.selector);
        adapter.deploy(AMT, AMT + 1); // valueAdded (== AMT) < minValueOut
    }

    function test_deploy_revertsForNonVault() public {
        usdc.mint(address(adapter), AMT);
        vm.prank(stranger);
        vm.expectRevert(IPositionAdapter.OnlyVault.selector);
        adapter.deploy(AMT, 0);
    }

    // ── withdraw: delivery >= floor, clamp, floor-revert, authority ─────────

    function test_withdraw_deliversAtLeastMinOutToVault() public {
        _fundAndDeploy(AMT);
        uint256 vaultBefore = usdc.balanceOf(vault);
        vm.prank(vault);
        uint256 usdcOut = adapter.withdraw(AMT, AMT);
        assertGe(usdcOut, AMT, "must deliver at least minUsdcOut");
        assertEq(usdc.balanceOf(vault) - vaultBefore, usdcOut, "proceeds land at vault");
    }

    function test_withdraw_clampsOverAskAtBalance() public {
        _fundAndDeploy(AMT);
        vm.prank(vault);
        // Over-ask above the liquidatable balance clamps (no revert, minUsdcOut 0).
        uint256 usdcOut = adapter.withdraw(2 * AMT, 0);
        assertApproxEqAbs(usdcOut, AMT, 1, "over-ask clamps at position balance");
    }

    function test_withdraw_revertsBelowFloor() public {
        _fundAndDeploy(AMT);
        vm.prank(vault);
        // Realized (<= AMT) is below the AMT+1 floor ⇒ SlippageExceeded.
        vm.expectRevert(IPositionAdapter.SlippageExceeded.selector);
        adapter.withdraw(AMT, AMT + 1);
    }

    function test_withdraw_revertsForNonVault() public {
        _fundAndDeploy(AMT);
        vm.prank(stranger);
        vm.expectRevert(IPositionAdapter.OnlyVault.selector);
        adapter.withdraw(AMT, 0);
    }

    // ── remaining members ───────────────────────────────────────────────────

    function test_harvestRewards_permissionlessNoop() public {
        _fundAndDeploy(AMT);
        uint256 posBefore = adapter.totalAssets();
        uint256 vaultBefore = usdc.balanceOf(vault);
        vm.prank(stranger); // permissionless
        adapter.harvestRewards(); // MUST NOT revert
        assertApproxEqAbs(adapter.totalAssets(), posBefore, 1, "harvest moved position");
        assertEq(usdc.balanceOf(vault), vaultBefore, "harvest credited vault for no-op");
    }

    function test_sweepForeignToken_quarantinesForeignRevertsOnProtected() public {
        TestERC20 foreign = new TestERC20();
        foreign.mint(address(adapter), 7e18);
        vm.prank(stranger); // permissionless
        adapter.sweepForeignToken(address(foreign));
        assertEq(
            foreign.balanceOf(ForeignTokenQuarantine.QUARANTINE), 7e18, "foreign not quarantined"
        );

        // USDC is always protected.
        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(usdc))
        );
        adapter.sweepForeignToken(address(usdc));

        // The venue receipt/share token is protected.
        address share = _shareToken();
        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, share)
        );
        adapter.sweepForeignToken(share);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Concrete suites
// ─────────────────────────────────────────────────────────────────────────────

contract MorphoAdapterPositionTest is PositionConformanceBase {
    PosConfMorphoVault internal morpho;

    function _setUpAdapter() internal override {
        morpho = new PosConfMorphoVault(address(usdc));
        adapter =
            IPositionAdapter(address(new MorphoAdapter(address(morpho), address(usdc), vault)));
    }

    function _shareToken() internal view override returns (address) {
        return address(morpho);
    }
}

contract AaveV3AdapterPositionTest is PositionConformanceBase {
    PosConfAavePool internal pool;
    TestERC20 internal aToken;

    function _setUpAdapter() internal override {
        aToken = new TestERC20();
        pool = new PosConfAavePool(address(usdc), address(aToken));
        adapter = IPositionAdapter(
            address(new AaveV3Adapter(address(pool), address(usdc), address(aToken), vault))
        );
    }

    function _shareToken() internal view override returns (address) {
        return address(aToken);
    }
}

contract CompoundV3AdapterPositionTest is PositionConformanceBase {
    PosConfComet internal comet;

    function _setUpAdapter() internal override {
        comet = new PosConfComet(address(usdc));
        adapter =
            IPositionAdapter(address(new CompoundV3Adapter(address(comet), address(usdc), vault)));
    }

    function _shareToken() internal view override returns (address) {
        return address(comet);
    }
}
