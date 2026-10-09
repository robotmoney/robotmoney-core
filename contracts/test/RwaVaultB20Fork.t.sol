// SPDX-License-Identifier: MIT
// Canonical: docs/technical/base-tokenized-stocks-research.md, core issue 1500
//            docs/prd.md §11.4 — RWA / Thematic Vault (rmRWA)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ForkSelect} from "./helpers/ForkSelect.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {AerodromeSwapAdapter} from "../adapters/AerodromeSwapAdapter.sol";
import {UniswapV3SwapAdapter} from "../adapters/UniswapV3SwapAdapter.sol";

/// @dev Plain 8-decimal ERC20 etched at each B20 address. Anvil and forge cannot run the Base B20
///      precompile (the account code is the single byte 0xef, an invalid opcode off Base), so the
///      token behaviour is a standard ERC20 and everything else is real: the Aerodrome Slipstream
///      factory, router and pools, the pool TWAP history, USDC and the deSPXA pool.
contract B20Stand is ERC20 {
    constructor() ERC20("B20 stand-in", "B20") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }
}

/// @notice Fork test for core 1500: the four Coinbase B20 tokens join rmRWA through a real
///         TimelockController at the production delay, then USDC deposits and redeems with all
///         five assets held. Runs on the Twin chain (FORK_RPC_URL). Unset, it skips with a named
///         reason, and CI refuses a run in which no test executed.
contract RwaVaultB20ForkTest is Test {
    using stdJson for string;

    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    /// @dev Base mainnet timelock delay (security-model.md §4).
    uint256 internal constant MIN_DELAY = 172_800;
    uint256 internal constant DEPOSIT = 1_000 * 1e6;
    /// @dev Vault slippage bound (100 bps) plus pool fee between spot execution and the TWAP.
    uint256 internal constant TOLERANCE_BPS = 150;
    uint256 internal constant POOL_B20_FUNDING = 1e13;

    address internal admin = makeAddr("admin");
    address internal proposer = makeAddr("proposer");
    address internal alice = makeAddr("alice");

    RwaBasketVault internal vault;
    TimelockController internal timelock;
    AerodromeSwapAdapter internal adapter;
    string internal b20Cfg;
    string internal v3Cfg;
    uint32 internal twapWindow;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (!ForkSelect.selectOrSkip(rpc)) return;

        b20Cfg = vm.readFile("contracts/test/fixtures/rwa-b20-assets.json");
        v3Cfg = vm.readFile("config/rwa-assets.json");

        // The launch vault: deSPXA only, deployed by the production script.
        VaultRegistry registry = new VaultRegistry(admin);
        BasketVaultDeployBase.Deployed memory d = new DeployRwaBasketVault()
            .runInProcess(
                BasketVaultDeployBase.Params({
                    admin: admin,
                    swapRouter: v3Cfg.readAddress(".swapRouter02"),
                    usdc: BASE_USDC,
                    registry: address(registry),
                    tvlCap: 100_000 * 1e6,
                    perDepositCap: 10_000 * 1e6,
                    exitFeeBps: 0,
                    feeRecipient: makeAddr("feeRecipient"),
                    navDeviationGuardBps: 2000,
                    minPoolLiquidity: 1e6
                }),
                v3Cfg
            );
        vault = RwaBasketVault(d.vault);
        twapWindow = vault.DEFAULT_TWAP_WINDOW();

        // Handover: the timelock holds ADMIN_ROLE and the deployer gives it up.
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        timelock = new TimelockController(MIN_DELAY, proposers, proposers, address(0));
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.startPrank(admin);
        vault.grantRole(adminRole, address(timelock));
        vault.unpauseDeposits();
        vault.renounceRole(adminRole, admin);
        vm.stopPrank();

        // Stand-in token behaviour at the real B20 addresses, funded in the real pools.
        address stand = address(new B20Stand());
        for (uint256 i = 0; i < 4; i++) {
            address token = _token(i);
            vm.etch(token, stand.code);
            deal(token, _pool(i), POOL_B20_FUNDING);
        }

        adapter = new AerodromeSwapAdapter(
            b20Cfg.readAddress(".aerodromeSlipstreamRouter"),
            b20Cfg.readAddress(".aerodromeSlipstreamFactory")
        );
        deal(BASE_USDC, alice, DEPOSIT);
    }

    function _key(uint256 i) internal pure returns (string memory) {
        return string.concat(".assets[", vm.toString(i), "]");
    }

    function _token(uint256 i) internal view returns (address) {
        return b20Cfg.readAddress(string.concat(_key(i), ".token"));
    }

    function _pool(uint256 i) internal view returns (address) {
        return b20Cfg.readAddress(string.concat(_key(i), ".pool"));
    }

    /// @dev One batch: allow the adapter code hash, then addAsset for each of the four tokens.
    function _addAllFourThroughTimelock() internal {
        address[] memory targets = new address[](5);
        uint256[] memory values = new uint256[](5);
        bytes[] memory payloads = new bytes[](5);
        targets[0] = address(vault);
        payloads[0] = abi.encodeCall(
            BasketVault.setAdapterCodeHashAllowed, (address(adapter).codehash, true)
        );
        for (uint256 i = 0; i < 4; i++) {
            targets[i + 1] = address(vault);
            payloads[i + 1] = abi.encodeCall(
                BasketVault.addAsset,
                (
                    _token(i),
                    _pool(i),
                    uint24(b20Cfg.readUint(string.concat(_key(i), ".poolFee"))),
                    address(adapter),
                    BasketVault.Venue.Aerodrome
                )
            );
        }
        bytes32 salt = keccak256("core-1500-b20");
        vm.prank(proposer);
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, MIN_DELAY);

        // Not executable before the real delay has elapsed.
        vm.prank(proposer);
        vm.expectRevert();
        timelock.executeBatch(targets, values, payloads, bytes32(0), salt);

        vm.warp(block.timestamp + MIN_DELAY);
        vm.prank(proposer);
        timelock.executeBatch(targets, values, payloads, bytes32(0), salt);
    }

    function test_fork_b20_addedThroughRealTimelockAtRealDelay() public {
        assertEq(timelock.getMinDelay(), MIN_DELAY, "production delay");
        assertFalse(vault.hasRole(vault.ADMIN_ROLE(), admin), "deployer gave up admin");
        // A direct call by the deployer cannot bypass the timelock.
        vm.prank(admin);
        vm.expectRevert();
        vault.addAsset(_token(0), _pool(0), 10, address(adapter), BasketVault.Venue.Aerodrome);

        assertEq(vault.assetCount(), 1, "deSPXA only before the timelock batch");
        _addAllFourThroughTimelock();
        assertEq(vault.assetCount(), 5, "deSPXA plus four B20");
        for (uint256 i = 0; i < 4; i++) {
            (address token, address pool, uint24 fee, bool active, address ad,) =
                vault.assets(i + 1);
            assertEq(token, _token(i));
            assertEq(pool, _pool(i));
            assertEq(uint256(fee), 10);
            assertTrue(active);
            assertEq(ad, address(adapter));
        }
    }

    function test_fork_b20_depositAndRedeemWithFourHeld() public {
        _addAllFourThroughTimelock();

        vm.startPrank(alice);
        IERC20(BASE_USDC).approve(address(vault), DEPOSIT);
        uint256 shares = vault.deposit(DEPOSIT, alice);
        vm.stopPrank();
        assertGt(shares, 0);

        uint256 expectedNav = IERC20(BASE_USDC).balanceOf(address(vault));
        for (uint256 i = 1; i < vault.assetCount(); i++) {
            (address token, address pool,,, address ad,) = vault.assets(i);
            uint256 held = IERC20(token).balanceOf(address(vault));
            assertGt(held, 0, "deposit bought each B20");
            expectedNav += AerodromeSwapAdapter(ad)
                .twapPrice(pool, token, BASE_USDC, held, vault.effectiveTwapWindow(token));
        }
        (address despxa, address despxaPool,,, address v3Adapter,) = vault.assets(0);
        uint256 despxaHeld = IERC20(despxa).balanceOf(address(vault));
        assertGt(despxaHeld, 0, "deposit bought deSPXA");
        expectedNav += UniswapV3SwapAdapter(v3Adapter)
            .twapPrice(despxaPool, despxa, BASE_USDC, despxaHeld, vault.effectiveTwapWindow(despxa));

        uint256 nav = vault.totalAssets();
        assertEq(nav, expectedNav, "NAV equals idle USDC plus every pool TWAP value");
        assertGe(nav, DEPOSIT * (10_000 - TOLERANCE_BPS) / 10_000, "NAV not below the TWAP bound");
        assertLe(nav, DEPOSIT * (10_000 + TOLERANCE_BPS) / 10_000, "NAV not above the TWAP bound");

        uint256 before = IERC20(BASE_USDC).balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        uint256 received = IERC20(BASE_USDC).balanceOf(alice) - before;
        assertGe(received, DEPOSIT * (10_000 - TOLERANCE_BPS) / 10_000, "redeem within the bound");
        for (uint256 i = 1; i < 5; i++) {
            assertEq(IERC20(_token(i - 1)).balanceOf(address(vault)), 0, "B20 sold on redeem");
        }
    }
}
