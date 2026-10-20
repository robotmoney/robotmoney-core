// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (SYS-1)
// Implements: issue 1892 (SS-1019-10). Stateful invariant: with no gateway deployed, rebalancing by default weights
// keeps working through any sequence of weight changes, and the vaults contracts never grow a gateway dependency.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {RouterGovernance} from "../../RouterGovernance.sol";
import {PortfolioRouter} from "../../PortfolioRouter.sol";
import {VaultRegistry} from "../../VaultRegistry.sol";
import {CoreProxies} from "../helpers/CoreProxies.sol";
import {MockUsdc, MockGovVault} from "../RouterGovernance.t.sol";

contract SystemSplitHandler is Test {
    RouterGovernance public immutable gov;
    address public immutable admin;
    address[] public vaults;
    uint256 public calls;

    constructor(RouterGovernance gov_, address admin_, address[] memory vaults_) {
        gov = gov_;
        admin = admin_;
        vaults = vaults_;
    }

    /// @dev The admin sets default weights split between the first two vaults.
    function setDefault(uint256 seed) external {
        uint256 a = bound(seed, 0, 10_000);
        address[] memory vs = new address[](2);
        vs[0] = vaults[0];
        vs[1] = vaults[1];
        uint256[] memory bps = new uint256[](2);
        bps[0] = a;
        bps[1] = 10_000 - a;
        vm.prank(admin);
        gov.setDefaultWeights(vs, bps);
        calls++;
    }
}

contract SystemSplitInvariantTest is Test {
    PortfolioRouter internal router;
    VaultRegistry internal registry;
    RouterGovernance internal gov;
    SystemSplitHandler internal handler;

    function setUp() public {
        MockUsdc usdc = new MockUsdc();
        address registryAdmin = makeAddr("registryAdmin");
        address routerAdmin = makeAddr("routerAdmin");
        address govAdmin = makeAddr("govAdmin");
        registry = CoreProxies.vaultRegistry(registryAdmin);
        address[] memory vs = new address[](2);
        vm.startPrank(registryAdmin);
        for (uint256 i = 0; i < 2; i++) {
            MockGovVault v = new MockGovVault(address(usdc));
            vs[i] = address(v);
            registry.registerVault(
                vs[i], VaultRegistry.VaultMetadata({name: "V", asset: address(usdc), registeredAt: 0})
            );
            registry.setRouterEligible(vs[i], true);
        }
        vm.stopPrank();
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), routerAdmin);
        gov = CoreProxies.routerGovernance(address(router), address(new MockGovVault(address(usdc))), govAdmin);
        vm.startPrank(routerAdmin);
        router.grantRole(router.ADMIN_ROLE(), address(gov));
        router.grantRole(router.WEIGHT_SETTER_ROLE(), address(gov));
        vm.stopPrank();
        handler = new SystemSplitHandler(gov, govAdmin, vs);
        targetContract(address(handler));
    }

    /// @notice Whatever the sequence of default-weight changes, the effective vector sums to MAX_BPS with no gateway present.
    function invariant_SYS1_effectiveWeightsSumToMaxBpsWithNoGateway() public view {
        (, uint256[] memory bps) = router.getEffectiveWeights();
        uint256 sum;
        for (uint256 i = 0; i < bps.length; i++) {
            sum += bps[i];
        }
        if (handler.calls() > 0) assertEq(sum, 10_000, "effective weights do not sum to MAX_BPS");
    }

    /// @notice The vaults contracts answer no gateway() call: none holds a gateway address.
    function invariant_SYS1_noVaultsContractHoldsAGateway() public view {
        address[3] memory targets = [address(router), address(registry), address(gov)];
        for (uint256 i = 0; i < targets.length; i++) {
            (bool ok,) = targets[i].staticcall(abi.encodeWithSignature("gateway()"));
            assertFalse(ok, "a vaults contract exposes gateway()");
        }
    }
}
