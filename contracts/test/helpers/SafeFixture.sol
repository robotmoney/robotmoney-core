// SPDX-License-Identifier: MIT
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops) principle 11 — no mock Safes
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployTimelock} from "../../script/DeployTimelock.s.sol";
import {SafeL2} from "../vendor/safe-1.4.1/SafeL2.sol";
import {SafeProxyFactory} from "../vendor/safe-1.4.1/proxies/SafeProxyFactory.sol";
import {CompatibilityFallbackHandler} from
    "../vendor/safe-1.4.1/handler/CompatibilityFallbackHandler.sol";

/// @dev Setup call of Safe 1.4.1 (`Safe.setup`).
interface ISafeSetupCall {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

/// @title SafeFixture
/// @notice Builds REAL Safe 1.4.1 proxies in-process from the vendored Safe sources
///         (contracts/test/vendor/safe-1.4.1). Replaces every hand-written Safe
///         stand-in.
/// @dev The vendored sources compile with this repo's solc settings, so their runtime
///      bytecode differs from the canonical on-chain deployments. The fixture therefore
///      installs the vendored SafeL2 and CompatibilityFallbackHandler at the canonical
///      Base addresses, deploys the proxy through a vendored SafeProxyFactory, and then
///      etches the canonical SafeProxy 1.4.1 runtime (read from a live Base Safe proxy,
///      codehash 0xd7d408eb...) onto it. Storage (singleton, owners, threshold, handler)
///      is the factory's and `setup()`'s own. DeployTimelock accepts or rejects the
///      result by the same checks it runs on a real chain.
abstract contract SafeFixture is Test {
    /// @dev Canonical Safe 1.4.1 addresses on Base (the Twin chain carries the same ones).
    address internal constant FIXTURE_SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant FIXTURE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    /// @dev Runtime of the SafeProxy 1.4.1 deployed by the canonical factory.
    bytes internal constant CANONICAL_SAFE_PROXY_RUNTIME =
        hex"608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033";

    uint256 internal constant FIXTURE_THRESHOLD = 2;

    SafeProxyFactory internal safeFactory;
    uint256 internal safeSaltNonce;

    /// @dev Installs the Safe contract set and the proxy factory. Call once in setUp.
    function _installSafeSet() internal {
        vm.etch(FIXTURE_SAFE_L2_SINGLETON, address(new SafeL2()).code);
        vm.etch(FIXTURE_FALLBACK_HANDLER, address(new CompatibilityFallbackHandler()).code);
        safeFactory = new SafeProxyFactory();
    }

    /// @dev The default 3 owners every fixture Safe uses.
    function _fixtureOwners() internal returns (address[] memory owners) {
        owners = new address[](3);
        owners[0] = makeAddr("safe-owner-1");
        owners[1] = makeAddr("safe-owner-2");
        owners[2] = makeAddr("safe-owner-3");
    }

    /// @dev The SAFE_OWNERS / SAFE_THRESHOLD spec matching `_newDefaultSafe()`.
    function _fixtureSpec() internal returns (DeployTimelock.SafeSpec memory) {
        return DeployTimelock.SafeSpec({owners: _fixtureOwners(), threshold: FIXTURE_THRESHOLD});
    }

    /// @dev A real Safe proxy with the canonical fallback handler, `threshold`-of-N.
    function _newSafe(address[] memory owners, uint256 threshold) internal returns (address proxy) {
        proxy = _newSafeWith(owners, threshold, FIXTURE_FALLBACK_HANDLER);
    }

    function _newSafeWith(address[] memory owners, uint256 threshold, address handler)
        internal
        returns (address proxy)
    {
        bytes memory init = abi.encodeCall(
            ISafeSetupCall.setup,
            (owners, threshold, address(0), "", handler, address(0), 0, payable(address(0)))
        );
        proxy = address(
            safeFactory.createProxyWithNonce(FIXTURE_SAFE_L2_SINGLETON, init, ++safeSaltNonce)
        );
        vm.etch(proxy, CANONICAL_SAFE_PROXY_RUNTIME);
    }

    /// @dev The default 2-of-3 Safe.
    function _newDefaultSafe() internal returns (address) {
        return _newSafe(_fixtureOwners(), FIXTURE_THRESHOLD);
    }
}
