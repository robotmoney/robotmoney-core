// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (ACL-1, ORA-3, ORA-6)
//            docs/code-review/20260619-code-review-pekshield.md (F-01, F-09, F-17)
//
// POST-DEPLOY ASSERTION HARNESS (issue #964, AC4 — SCOUT STUB)
// ───────────────────────────────────────────────────────────────────────────────
// Deploy-assertion / static-guard checks for three configuration invariants the
// spec calls out for a post-deploy state check:
//
//   - ACL-1 (RED, F-01): after handover NO EOA holds ANY privileged role
//     (DEFAULT_ADMIN_ROLE, ADMIN_ROLE, EMERGENCY_ROLE, PAUSER_ROLE). Today the
//     deployer EOA keeps the Gateway DEFAULT_ADMIN_ROLE and every vault
//     EMERGENCY_ROLE; DeployTimelock.t.sol only asserts ADMIN_ROLE is clear. The
//     #965 fix completes the handover AND broadens the assertion — this is where
//     the broadened assertion will live (or be folded into DeployTimelock.t.sol).
//
//   - ORA-3 (RED, F-09): the pricing-TWAP pool == the execution pool
//     (fee/tickSpacing/hooks). BasketVault.addAsset stores `pool` and `swapFee`
//     independently and never asserts they resolve to one pool. The #966 fix adds
//     the equality check in addAsset; this asserts addAsset reverts on mismatch.
//
//   - ORA-6 (HOLDS — 🟡 TRUSTED, F-17): the decimals scaling between a priced
//     asset and USDC is correct for the asset actually configured. Today the
//     ChronicleOracleAdapter hardcodes 1e12 = 10^(18-6), correct only while
//     deSPXA == 18 decimals and USDC == 6. The constructor SHOULD assert
//     decimals()==18 && usdc.decimals()==6. This is a passing static-guard that
//     documents the current trust assumption (the 1e12 constant) and is the seam
//     where the dynamic decimals() read would be asserted.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {DeployTimelock} from "../../script/DeployTimelock.s.sol";
import {RobotMoneyVault} from "../../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../../gateway/interfaces/IGateway.sol";
import {VaultRegistry} from "../../VaultRegistry.sol";
import {PortfolioRouter} from "../../PortfolioRouter.sol";
import {RouterGovernance} from "../../RouterGovernance.sol";
import {BasketVault} from "../../vaults/BasketVault.sol";
import {BasketAssetConfigGuard} from "../../lib/BasketAssetConfigGuard.sol";
import {ISwapRouter} from "../../interfaces/ISwapRouter.sol";
import {TestERC20} from "../helpers/TestERC20.sol";

/// @dev Minimal 18-dec basket token for the ORA-3 addAsset rig.
contract Ora3Token is ERC20 {
    constructor() ERC20("ORA3 Token", "ORA3T") {}
}

/// @dev Minimal pool mock exposing the surface `BasketVault.addAsset` reads:
///      token0/token1, slot0 cardinality, observe, liquidity, and the `fee()`
///      accessor the ORA-3 equality check asserts against `swapFee_`.
contract Ora3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable poolFee;

    constructor(address token0_, address token1_, uint24 fee_) {
        token0 = token0_;
        token1 = token1_;
        poolFee = fee_;
    }

    function fee() external view returns (uint24) {
        return poolFee;
    }

    function liquidity() external pure returns (uint128) {
        return 1e18;
    }

    function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1 << 96), 0, 0, 100, 100, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
    }
}

/// @dev Concrete BasketVault to exercise `addAsset` (BasketVault is abstract).
contract Ora3BasketVault is BasketVault {
    constructor(IERC20 usdc_, ISwapRouter router_, address admin_)
        BasketVault(
            "ORA3 Basket",
            "bORA3",
            usdc_,
            router_,
            type(uint256).max,
            type(uint256).max,
            0,
            30,
            admin_,
            admin_,
            admin_
        )
    {}

    function maxAssets() public pure override returns (uint256) {
        return 8;
    }
}

/// @dev Minimal 2-of-N Safe stub (code + threshold>=2) so DeployTimelock's
///      SAFE_ADDRESS guards are satisfied without a real Safe.
contract _FvSafeStub {
    function getThreshold() external pure returns (uint256) {
        return 2;
    }
}

/// @dev Stand-in for the deployer EOA. It holds the constructor-granted roles and
///      itself calls `runHandover`, so inside the handover `msg.sender` (the
///      address revoked) is this harness — mirroring the broadcast path where the
///      deployer key both grants and is revoked. It first delegates the
///      role-granting authority (ADMIN_ROLE on all five contracts, plus the
///      gateway DEFAULT_ADMIN_ROLE) to `address(script)`, which is what executes
///      the script's grant/revoke external calls.
contract _FvDeployerHarness {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;

    function grantAdminTo(
        address script_,
        address vault_,
        address gateway_,
        address registry_,
        address router_,
        address governance_
    ) external {
        IAccessControl(vault_).grantRole(ADMIN_ROLE, script_);
        IAccessControl(registry_).grantRole(ADMIN_ROLE, script_);
        IAccessControl(router_).grantRole(ADMIN_ROLE, script_);
        IAccessControl(governance_).grantRole(ADMIN_ROLE, script_);
        // The gateway administers ADMIN_ROLE and DEFAULT_ADMIN_ROLE under
        // DEFAULT_ADMIN_ROLE; the script needs both to grant the timelock the
        // gateway root and to revoke them from this harness.
        IAccessControl(gateway_).grantRole(ADMIN_ROLE, script_);
        IAccessControl(gateway_).grantRole(DEFAULT_ADMIN_ROLE, script_);
    }

    function runHandover(
        DeployTimelock script_,
        address vault_,
        address gateway_,
        address registry_,
        address router_,
        address governance_,
        address safe_,
        address emergency_,
        uint256 minDelay_
    ) external returns (DeployTimelock.Deployed memory) {
        return script_.runInProcess(
            vault_, gateway_, registry_, router_, governance_, safe_, emergency_, minDelay_
        );
    }
}

contract DeployAssertionsTest is Test {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 internal constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;

    // ACL-1 fixture handles (storage, to avoid stack-too-deep in the test body).
    RobotMoneyVault internal _aclVault;
    RobotMoneyGateway internal _aclGateway;
    VaultRegistry internal _aclRegistry;
    PortfolioRouter internal _aclRouter;
    RouterGovernance internal _aclGovernance;
    address internal _aclDeployer;
    address internal _aclEmergency;

    /// @dev Naive substring scan (same pattern as CustodyInvariantGuard.t.sol).
    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i = 0; i + n.length <= h.length; i++) {
            bool matched = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }

    /// @notice ACL-1 (REMEDIATED by #965, F-01): after the DeployTimelock
    ///         handover the deployer EOA holds NONE of {DEFAULT_ADMIN_ROLE,
    ///         ADMIN_ROLE, EMERGENCY_ROLE, PAUSER_ROLE} on the Gateway or the
    ///         vault. The Timelock receives the Gateway root (ADMIN + DEFAULT),
    ///         and an independent hot key receives the vault EMERGENCY_ROLE. This
    ///         is the deep deploy-assertion: it actually runs the handover and
    ///         enumerates every privileged role against the deployer EOA.
    function test_ACL1_eoaHoldsNoPrivilegedRoleAfterHandover() public {
        // The "deployer EOA" is modelled by a harness contract that holds the
        // constructor-granted roles and itself invokes the handover. Inside the
        // script's external grant/revoke calls, the role-granting authority is
        // `address(script)`, while `revokeRole(..., msg.sender)` targets the
        // harness (the caller of runInProcess) — exactly mirroring the broadcast
        // path where the deployer key both grants and is revoked. We therefore
        // assert the HARNESS (the deployer EOA stand-in) holds no role afterward.
        address timelock = _deployAclFixtureAndHandover();
        address deployer = _aclDeployer;

        // ACL-1: the deployer EOA holds NO privileged role of ANY kind.
        assertFalse(
            _aclGateway.hasRole(DEFAULT_ADMIN_ROLE, deployer),
            "deployer retains Gateway DEFAULT_ADMIN"
        );
        assertFalse(
            _aclGateway.hasRole(ADMIN_ROLE, deployer), "deployer retains Gateway ADMIN_ROLE"
        );
        assertFalse(
            _aclGateway.hasRole(PAUSER_ROLE, deployer), "deployer retains Gateway PAUSER_ROLE"
        );
        assertFalse(_aclVault.hasRole(ADMIN_ROLE, deployer), "deployer retains vault ADMIN_ROLE");
        assertFalse(
            _aclVault.hasRole(EMERGENCY_ROLE, deployer), "deployer retains vault EMERGENCY_ROLE"
        );
        assertFalse(
            _aclRegistry.hasRole(ADMIN_ROLE, deployer), "deployer retains registry ADMIN_ROLE"
        );
        assertFalse(_aclRouter.hasRole(ADMIN_ROLE, deployer), "deployer retains router ADMIN_ROLE");
        assertFalse(
            _aclGovernance.hasRole(ADMIN_ROLE, deployer), "deployer retains governance ADMIN_ROLE"
        );

        // The independent hot key holds the vault EMERGENCY_ROLE; the Timelock
        // holds the Gateway root.
        assertTrue(
            _aclVault.hasRole(EMERGENCY_ROLE, _aclEmergency), "emergency hot key missing EMERGENCY"
        );
        assertTrue(
            _aclGateway.hasRole(DEFAULT_ADMIN_ROLE, timelock), "timelock missing gateway root"
        );
        assertTrue(_aclGateway.hasRole(ADMIN_ROLE, timelock), "timelock missing gateway ADMIN");
    }

    /// @notice ACL-7 / NC-10 (FLIPPED GREEN by #970): permissionless agent
    ///         registration can never block a future intended ADMIN/PAUSER address
    ///         from being granted its role during handover. Two layers prove this:
    ///
    ///         1. The Gateway's role-separation invariant means that if an intended
    ///            admin address were already an AGENT, `grantRole(ADMIN_ROLE, …)`
    ///            would revert `RoleSeparationViolated` — a confusing, late-stage
    ///            handover brick (the grant-DoS vector).
    ///         2. The DeployTimelock handover now ASSERTS up front (before any
    ///            gateway grant) that every address about to receive an
    ///            ADMIN/PAUSER-tier role is AGENT-free, turning the griefing vector
    ///            into an explicit, typed deploy-time precondition.
    ///
    ///         This test pins layer 1 (the brick exists without the guard) and
    ///         layer 2 (a normal handover, where no intended admin is pre-bound,
    ///         passes the guard and completes). Deep proof referenced by
    ///         FvInvariants.t.sol::test_ACL7_*.
    function test_ACL7_agentRegistrationCannotBlockRoleGrant() public {
        TestERC20 usdc = new TestERC20();
        address admin = makeAddr("acl7-admin");
        address pauser = makeAddr("acl7-pauser");
        RobotMoneyVault v = new RobotMoneyVault(
            usdc, type(uint256).max, type(uint256).max, 0, makeAddr("acl7-safe"), admin, admin
        );
        RobotMoneyGateway gw = new RobotMoneyGateway(usdc, v, admin, pauser, address(0));

        // An attacker pre-binds an INTENDED future admin address as an AGENT via
        // the permissionless registration surface (modelled here by the
        // ADMIN-gated authorizeAgent, which is the same grant path).
        address intendedAdmin = makeAddr("acl7-future-admin");
        IGateway.AgentPolicy memory p = _acl7Policy();
        vm.prank(admin);
        gw.authorizeAgent(intendedAdmin, p);
        assertTrue(gw.hasRole(AGENT_ROLE, intendedAdmin), "pre: intended admin pre-bound as AGENT");

        // Layer 1: granting ADMIN_ROLE to that pre-bound address now reverts —
        // this is the grant-DoS the deploy guard must catch BEFORE attempting it.
        vm.prank(admin);
        vm.expectRevert(); // RoleSeparationViolated (cross-tier overlap)
        gw.grantRole(ADMIN_ROLE, intendedAdmin);

        // Layer 2: the deploy-time guard catches the same condition explicitly. A
        // clean handover — where no intended admin/pauser is pre-bound as AGENT —
        // passes the guard and completes, which the full ACL-1 handover fixture
        // already exercises end-to-end.
        address freshTimelock = _deployAclFixtureAndHandover();
        assertFalse(
            _aclGateway.hasRole(AGENT_ROLE, freshTimelock),
            "ACL-7: handed-over timelock must be AGENT-free"
        );
        assertTrue(
            _aclGateway.hasRole(ADMIN_ROLE, freshTimelock),
            "ACL-7: AGENT-free timelock receives gateway ADMIN without a grant-DoS"
        );
    }

    /// @dev Minimal valid agent policy for the ACL-7 grant-DoS fixture.
    function _acl7Policy() internal returns (IGateway.AgentPolicy memory p) {
        address[] memory empty = new address[](0);
        p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: 1,
            maxPerWindow: 1,
            shareReceiver: makeAddr("acl7-receiver"),
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
    }

    /// @dev Build the five-contract fixture (deployer = harness), delegate the
    ///      role-granting authority to the script, run the handover, and store the
    ///      handles in storage. Split out of the test body to stay under the EVM
    ///      stack-depth limit. Returns the deployed TimelockController address.
    function _deployAclFixtureAndHandover() internal returns (address timelock) {
        TestERC20 usdc = new TestERC20();
        DeployTimelock script = new DeployTimelock();
        _FvDeployerHarness harness = new _FvDeployerHarness();
        address safe = address(new _FvSafeStub());
        _aclDeployer = address(harness);
        _aclEmergency = makeAddr("fv-emergency");

        // Construct the five contracts with the harness as admin so it holds the
        // at-risk roles. The gateway also grants the harness DEFAULT_ADMIN_ROLE;
        // the vault grants the harness EMERGENCY_ROLE — the pre-fix EOA-retains-
        // role gap the handover must close.
        _aclVault = new RobotMoneyVault(
            usdc, type(uint256).max, type(uint256).max, 0, safe, _aclDeployer, _aclDeployer
        );
        _aclGateway =
            new RobotMoneyGateway(usdc, _aclVault, _aclDeployer, makeAddr("fv-pauser"), address(0));
        _aclRegistry = new VaultRegistry(_aclDeployer);
        _aclRouter = new PortfolioRouter(address(usdc), address(_aclRegistry), _aclDeployer);
        _aclGovernance = new RouterGovernance(address(_aclRouter), _aclDeployer, 7 days, 1 days, 1);

        // The script's grant calls run as `address(script)`, so it needs ADMIN on
        // each contract (and the gateway DEFAULT_ADMIN_ROLE to hand the timelock
        // the gateway root and revoke it from the harness).
        harness.grantAdminTo(
            address(script),
            address(_aclVault),
            address(_aclGateway),
            address(_aclRegistry),
            address(_aclRouter),
            address(_aclGovernance)
        );

        // Pre-condition (pre-fix gap): the deployer EOA DOES hold the at-risk roles.
        assertTrue(
            _aclGateway.hasRole(DEFAULT_ADMIN_ROLE, _aclDeployer), "pre: gateway root on deployer"
        );
        assertTrue(
            _aclVault.hasRole(EMERGENCY_ROLE, _aclDeployer), "pre: vault EMERGENCY on deployer"
        );

        DeployTimelock.Deployed memory d = harness.runHandover(
            script,
            address(_aclVault),
            address(_aclGateway),
            address(_aclRegistry),
            address(_aclRouter),
            address(_aclGovernance),
            safe,
            _aclEmergency,
            2 days
        );
        return address(d.timelock);
    }

    /// @notice ORA-3 (FLIPPED GREEN by #966, F-09): BasketVault.addAsset reverts
    ///         when the execution pool resolved from `swapFee_` does not equal the
    ///         registered TWAP pool (here: the pool's own `fee()`), and SUCCEEDS
    ///         when they match. Pins the equality check the fix added.
    function test_ORA3_addAssetRevertsOnPoolMismatch() public {
        TestERC20 usdc = new TestERC20(); // 6-dec USDC stand-in
        address admin = makeAddr("ora3Admin");
        Ora3BasketVault vault =
            new Ora3BasketVault(IERC20(address(usdc)), ISwapRouter(address(this)), admin);

        Ora3Token token = new Ora3Token();
        (address t0, address t1) = address(token) < address(usdc)
            ? (address(token), address(usdc))
            : (address(usdc), address(token));

        // Mismatch: pool's fee() is 3000 but addAsset is told swapFee_ = 500.
        Ora3Pool mismatchedPool = new Ora3Pool(t0, t1, 3000);
        vm.prank(admin);
        vm.expectRevert(BasketAssetConfigGuard.ExecutionPoolMismatch.selector);
        vault.addAsset(
            address(token), address(mismatchedPool), 500, address(0), BasketVault.Venue.V3
        );

        // Match: pool's fee() equals swapFee_ → addAsset succeeds.
        Ora3Pool matchedPool = new Ora3Pool(t0, t1, 500);
        vm.prank(admin);
        vault.addAsset(address(token), address(matchedPool), 500, address(0), BasketVault.Venue.V3);
        assertEq(vault.assetCount(), 1, "matched pool/fee registers the asset");
    }

    /// @notice ORA-6 (HOLDS — 🟡 TRUSTED, F-17): documents the current decimals
    ///         trust assumption. The ChronicleOracleAdapter hardcodes the
    ///         1e12 = 10^(18-6) scale, correct only while the priced asset is
    ///         18-dec and USDC is 6-dec. This passing static-guard pins that the
    ///         hardcoded constant is still present (so a silent decimals change is
    ///         caught) and marks the seam where #966 would add the dynamic
    ///         `decimals()==18 && usdc.decimals()==6` constructor assertion.
    function test_ORA6_chronicleAdapterDecimalsAssumptionIsDocumented() public view {
        string memory src = vm.readFile("contracts/adapters/ChronicleOracleAdapter.sol");
        // The 18→6 decimals scale is currently hardcoded (1e12). This guard makes
        // any change to that scaling a deliberate, reviewed edit — and is the
        // anchor for ORA-6's eventual dynamic decimals() assertion.
        assertTrue(
            _contains(src, "1e12"),
            "ORA-6: ChronicleOracleAdapter 18->6 decimals scale (1e12) missing - re-verify F-17 assumption"
        );
    }
}
