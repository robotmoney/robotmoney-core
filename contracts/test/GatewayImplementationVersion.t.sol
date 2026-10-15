// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §10 — signed authorizations across an upgrade
// Canonical: docs/technical/smart-contract-invariants.md — UPG-8 (consents bind the implementation version)
// Implements: core issue 1810 (QA plan v1 P3, Decisions D5 "bind") — the gateway implementation version
//             is the EIP-712 domain version of every agent consent.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ProposerFloorTimelock} from "../ProposerFloorTimelock.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {AgentConsent} from "./helpers/AgentConsent.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {Proxied} from "./helpers/Proxied.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev A v2 that changes what a signed consent means, so it bumps the version (ADR-0014 §10).
contract RobotMoneyGatewayVersionBump is RobotMoneyGateway {
    function implementationVersion() public pure override returns (string memory) {
        return "2";
    }
}

/// @dev A v2 that is a pure fix: new code, same consent meaning, same version.
contract RobotMoneyGatewayPureFix is RobotMoneyGateway {
    function fixMarker() external pure returns (uint256) {
        return 2;
    }
}

/// @title GatewayImplementationVersionTest
/// @notice QA plan Decisions D5: an outstanding agent consent is bound to the gateway
///         implementation version. The version is the EIP-712 domain `version`, read from
///         `implementationVersion()`. An upgrade that bumps it makes every consent signed before
///         the upgrade fail `InvalidAgentConsent`; a pure fix keeps them valid. The domain stays
///         bound to the proxy address, never to an implementation.
/// @dev The upgrade runs through a real `ProposerFloorTimelock` (Safe proposes, the delay runs,
///      anyone executes), as in `GovernedUpgradeLifecycle.t.sol`. The commitment is made before the
///      upgrade and revealed after it, which is the window D5 is about.
contract GatewayImplementationVersionTest is SafeGovernance {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant DELAY = 2 days;

    TestERC20 internal usdc;
    MockVault internal vault;
    ProposerFloorTimelock internal timelock;
    RobotMoneyGateway internal gateway;

    /// @dev A real 2-of-3 SafeL2 (helpers/SafeGovernance.sol): the timelock's only proposer.
    address internal safe;
    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal depositor = makeAddr("depositor");
    address internal agent;
    uint256 internal agentKey;

    bytes32 internal constant SALT = keccak256("version-salt");

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.roll(100);
        (agent, agentKey) = makeAddrAndKey("versionAgent");
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));
        _installSafeSet();
        safe = _newDefaultSafe();
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new ProposerFloorTimelock(DELAY, proposers, executors, address(0));
        gateway = Proxied.robotMoneyGatewayAs(
            address(timelock),
            IERC20(address(usdc)),
            IERC4626(address(vault)),
            admin,
            pauser,
            address(0)
        );
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _policy() internal view returns (IGateway.AgentPolicy memory p) {
        address[] memory none = new address[](0);
        p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: 100 * ONE_USDC,
            maxPerWindow: 1_000 * ONE_USDC,
            shareReceiver: depositor,
            allowedDestinations: none,
            assetRecipient: depositor,
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: none
        });
    }

    /// @dev The depositor commits to binding the agent, and one block passes.
    function _commit() internal {
        vm.prank(depositor);
        gateway.commitAuthorization(keccak256(abi.encode(agent, depositor, SALT)));
        vm.roll(block.number + 1);
    }

    /// @dev The agent's consent for the depositor, signed in the domain of `version` and naming
    ///      `verifyingContract`.
    function _consent(string memory version, address verifyingContract, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        return AgentConsent.signDigest(
            agentKey,
            AgentConsent.digestAt(
                version, verifyingContract, block.chainid, agent, depositor, depositor, nonce
            )
        );
    }

    /// @dev What rmpc and the dapp sign: the live `implementationVersion()` of the proxy.
    function _liveConsent() internal view returns (bytes memory) {
        return _consent(gateway.implementationVersion(), address(gateway), 0);
    }

    /// @dev Safe → timelock (delay) → `upgradeToAndCall`, with no migration call.
    function _upgradeTo(address implementation) internal {
        bytes memory data = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (implementation, ""));
        _govSchedule(safe, timelock, address(gateway), data, bytes32(0), DELAY);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        timelock.execute(address(gateway), 0, data, bytes32(0), bytes32(0));
    }

    function _expectInvalid(bytes memory consent) internal {
        IGateway.AgentPolicy memory p = _policy();
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.InvalidAgentConsent.selector);
        gateway.revealAuthorization(agent, SALT, p, consent);
    }

    function _reveal(bytes memory consent) internal {
        IGateway.AgentPolicy memory p = _policy();
        vm.prank(depositor);
        gateway.revealAuthorization(agent, SALT, p, consent);
    }

    // ─── Tests ────────────────────────────────────────────────────────

    /// @notice The getter clients read is the domain version the gateway checks: a consent signed
    ///         under any other version string fails, one signed under the live value binds.
    function test_implementationVersion_isTheConsentDomainVersion() public {
        assertEq(gateway.implementationVersion(), "1", "first release version");
        _commit();

        _expectInvalid(_consent("2", address(gateway), 0));
        _expectInvalid(_consent("", address(gateway), 0));
        assertEq(gateway.agentConsentNonce(agent), 0, "a refused consent moved the nonce");

        _reveal(_liveConsent());
        assertEq(gateway.agentOwner(agent), depositor, "live-version consent refused");
        assertEq(gateway.agentConsentNonce(agent), 1, "nonce not advanced");
    }

    /// @notice D5 "bind": a consent the agent signed before an upgrade that bumps the version stops
    ///         verifying after it, even though its commitment, nonce, owner and proxy are unchanged.
    ///         A consent signed under the new version binds.
    function test_versionBump_invalidatesOutstandingConsent() public {
        _commit();
        bytes memory signedBefore = _liveConsent();

        _upgradeTo(address(new RobotMoneyGatewayVersionBump()));
        assertEq(gateway.implementationVersion(), "2", "upgrade did not bump the version");

        _expectInvalid(signedBefore);
        assertEq(gateway.agentOwner(agent), address(0), "a pre-upgrade consent bound the agent");
        assertEq(gateway.agentConsentNonce(agent), 0, "a refused consent moved the nonce");

        _reveal(_liveConsent());
        assertEq(gateway.agentOwner(agent), depositor, "new-version consent refused");
        assertTrue(gateway.agentConsented(agent), "consent not recorded");
    }

    /// @notice A pure fix keeps the version, so an outstanding consent survives the upgrade. The
    ///         domain names the proxy before and after: a consent naming either implementation
    ///         address never verifies.
    function test_pureFix_keepsOutstandingConsentAndProxyDomain() public {
        address implementationV1 =
            address(uint160(uint256(vm.load(address(gateway), ERC1967Utils.IMPLEMENTATION_SLOT))));
        _commit();
        bytes memory signedBefore = _liveConsent();

        address implementationV2 = address(new RobotMoneyGatewayPureFix());
        _upgradeTo(implementationV2);
        assertEq(RobotMoneyGatewayPureFix(address(gateway)).fixMarker(), 2, "upgrade not live");
        assertEq(gateway.implementationVersion(), "1", "a pure fix changed the version");

        _expectInvalid(_consent("1", implementationV1, 0));
        _expectInvalid(_consent("1", implementationV2, 0));

        _reveal(signedBefore);
        assertEq(gateway.agentOwner(agent), depositor, "pure fix invalidated a consent");
    }
}
