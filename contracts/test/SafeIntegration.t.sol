// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Implements: issue #422 — Safe multisig integration test suite
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {RoleHolders} from "./helpers/RoleHolders.sol";

/// @title ISafe — minimal interface for the Safe (Gnosis Safe) multisig contract.
///
/// @dev Only the functions required by the integration test suite are listed.
///      The canonical Safe ABI is available at https://github.com/safe-global/safe-smart-account.
interface ISafe {
    /// @notice Returns the current threshold required for a Safe transaction.
    function getThreshold() external view returns (uint256);

    /// @notice Returns the list of current Safe owners.
    function getOwners() external view returns (address[] memory);

    /// @notice Execute a transaction signed by `threshold` or more owners.
    ///
    ///         Signature encoding for the EIP-712 `SafeMessage` / `SafeTx` type is
    ///         described in https://docs.safe.global/advanced/smart-account-signatures.
    ///         For Forge unit tests we use `eth_sign` / `contract` signature types.
    ///
    /// @param to             Target address.
    /// @param value          Ether value to forward.
    /// @param data           Calldata.
    /// @param operation      0 = CALL, 1 = DELEGATECALL.
    /// @param safeTxGas      Gas for the inner call (0 = use all).
    /// @param baseGas        Gas for data / refund handling (0).
    /// @param gasPrice       Gas price for refund (0 = no refund).
    /// @param gasToken       ERC-20 gas token address (0 = ETH).
    /// @param refundReceiver Refund recipient (0 = tx.origin).
    /// @param signatures     Packed signature bytes (65 bytes per owner, sorted ascending by owner).
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    /// @notice Returns the EIP-712 hash of `SafeTx` that owners must sign.
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);

    /// @notice Returns the on-chain nonce (number of executed transactions).
    function nonce() external view returns (uint256);

    /// @notice Whether `owner` is in the Safe's owner set.
    function isOwner(address owner) external view returns (bool);
}

/// @title ISafeProxyFactory — minimal interface for Safe{Wallet} ProxyFactory.
///
/// @dev Address on Base mainnet (and many networks): 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67.
interface ISafeProxyFactory {
    /// @notice Deploy a new SafeProxy and call `initializer` on the singleton.
    /// @param singleton    The Safe singleton (implementation) address.
    /// @param initializer  `setup(...)` calldata.
    /// @param saltNonce    Salt for CREATE2 (allows deterministic addresses).
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @title SafeIntegrationTest
/// @notice Fork-based integration tests proving that a 2-of-3 Safe proxy deployed via
///         `SafeProxyFactory` enforces quorum for all ADMIN_ROLE operations on the five
///         governed Robot Money contracts.
///
/// @dev CI starts Anvil from the checked-in Base fixture at localhost:8545. A
///      live fork remains available locally through `FORK_RPC_URL`.
///
///      To run locally:
///        FORK_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> \
///          forge test --match-contract SafeIntegration -vvv
///
/// @dev Safe deployment approach:
///      We call `SafeProxyFactory.createProxyWithNonce` against the canonical Base-mainnet
///      factory (0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67) with the canonical
///      `SafeL2` singleton (0x29fcB43b46531BcA003ddC8FCB67FFE91900C762). Base is an L2,
///      so `SafeL2` is the singleton production uses (governance-isomorphism.md §2.2, R4).
///      The golden fixture carries it because snapshot-fork.sh warms the whole Safe set
///      and check-fork-safe-set.sh refuses a fixture without it (R2, R3).
///      This proves the quorum is enforced by actual Safe contract code, not vm.prank.
///
/// @dev EIP-712 signing:
///      Safe uses its own `SafeTx` struct for EIP-712 signing.  `getTransactionHash` on
///      the deployed proxy returns the correct domain-separated digest that owners sign.
///      We call `vm.sign(pk, digest)` for each owner key, then sort and pack signatures
///      into the `bytes` parameter of `execTransaction`.
contract SafeIntegrationTest is Test {
    // ─── Base mainnet addresses ────────────────────────────────────────────────

    /// @dev Safe ProxyFactory on Base mainnet (same address across EVM chains).
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;

    /// @dev Safe L2 singleton (implementation) on Base mainnet.
    ///      This is the SafeL2.sol variant that emits extra events for L2 indexers.
    ///      Until issue #1447 this constant held 0x41675C09…, the L1 `Safe` singleton,
    ///      despite its name (governance-isomorphism.md §3.4).
    address internal constant SAFE_SINGLETON_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;

    /// @dev Safe Compatibility Fallback Handler on Base mainnet.
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    /// @dev Safe MultiSend v1.4.1 on Base mainnet (governance-isomorphism.md §2.2).
    address internal constant SAFE_MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526;

    /// @dev FallbackManager's handler slot: keccak256("fallback_manager.handler.address").
    bytes32 internal constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    // ─── Role constant ────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Timelock delay ────────────────────────────────────────────────────────

    uint256 public constant MIN_DELAY = 2 days;

    // ─── Test state ───────────────────────────────────────────────────────────

    /// Safe owner private keys — 3 signers, 2-of-3 threshold.
    uint256 internal ownerPk1;
    uint256 internal ownerPk2;
    uint256 internal ownerPk3;

    address internal owner1;
    address internal owner2;
    address internal owner3;

    /// The deployed 2-of-3 Safe proxy.
    ISafe internal safe;

    /// The five governed contracts.
    RobotMoneyVault internal vault;
    RobotMoneyGateway internal gateway;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal governance;

    TestERC20 internal usdc;

    /// Deployed timelock wiring.
    DeployTimelock.Deployed internal d;

    /// Snapshot id used for per-test isolation.
    uint256 internal _snap;

    /// The deploy script and its deployer (the script's own address; see setUp).
    DeployTimelock internal script;
    address internal deployer;

    /// Who holds what after the handover, replayed from every RoleGranted /
    /// RoleRevoked log since before the contracts were built. The contracts are
    /// not AccessControlEnumerable, so this is the only complete member list.
    mapping(address => address[]) internal adminHolders;
    address[] internal gatewayRootHolders;

    // ─── Set-up ────────────────────────────────────────────────────────────────

    /// @dev Select an override URL or the offline golden-fixture RPC.
    function _trySelectFork() internal returns (bool) {
        string memory rpc;
        try vm.envString("FORK_RPC_URL") returns (string memory s) {
            if (bytes(s).length > 0) rpc = s;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "http://127.0.0.1:8545";
        vm.createSelectFork(rpc);
        return true;
    }

    /// @dev Deploy the five governed contracts, wire them to a fresh TimelockController
    ///      whose PROPOSER is the deployed 2-of-3 Safe proxy.
    function setUp() public {
        _trySelectFork();
        vm.recordLogs();

        // Generate 3 deterministic signing keys.
        ownerPk1 = uint256(keccak256("owner1-pk"));
        ownerPk2 = uint256(keccak256("owner2-pk"));
        ownerPk3 = uint256(keccak256("owner3-pk"));
        owner1 = vm.addr(ownerPk1);
        owner2 = vm.addr(ownerPk2);
        owner3 = vm.addr(ownerPk3);

        // Deploy token + contracts.
        usdc = new TestERC20();

        // The deployer is the DeployTimelock script's own address. In a real
        // `forge script --broadcast` run the broadcaster both sends the grants
        // and revokes and is the `msg.sender` the script revokes from. In process
        // the script's calls come from address(script), so only when the deployer
        // IS address(script), and runInProcess is called from it, does the
        // handover revoke the roles the deployer actually holds (issue #1447).
        script = new DeployTimelock();
        deployer = address(script);

        vault = new RobotMoneyVault(
            usdc,
            type(uint256).max, // tvlCap
            type(uint256).max, // perDepositCap
            0, // exitFeeBps
            makeAddr("feeRecipient"),
            deployer,
            deployer
        );

        gateway = new RobotMoneyGateway(
            usdc,
            vault,
            deployer,
            makeAddr("pauser"),
            address(0) // no router yet
        );

        registry = new VaultRegistry(deployer);

        router = new PortfolioRouter(address(usdc), address(registry), deployer);

        governance = new RouterGovernance(address(router), deployer, 7 days, 1 days, 2);

        // RouterGovernance must hold the router's ADMIN_ROLE before the handover:
        // ADMIN_ROLE is what gates setWeights, so without it every proposal that
        // reaches quorum reverts inside execute(). DeployRouterGovernance performs
        // this grant for a real deployment; this fixture constructs RouterGovernance
        // directly, so it must do the same. DeployTimelock's R7 precondition asserts
        // it below.
        vm.prank(deployer);
        IAccessControl(address(router)).grantRole(ADMIN_ROLE, address(governance));

        // Deploy 2-of-3 Safe proxy via the canonical factory on Base mainnet.
        // Owners must be sorted ascending for the Safe setup call.
        address[] memory owners = _sortedOwners();

        bytes memory safeSetup = abi.encodeCall(
            _ISafeSetup.setup,
            (
                owners,
                2, // threshold = 2-of-3
                address(0), // to (no delegate call on setup)
                "", // data
                SAFE_FALLBACK_HANDLER,
                address(0), // paymentToken
                0, // payment
                payable(address(0)) // paymentReceiver
            )
        );

        address safeProxy = ISafeProxyFactory(SAFE_PROXY_FACTORY)
            .createProxyWithNonce(SAFE_SINGLETON_L2, safeSetup, uint256(keccak256("safe-salt-422")));
        safe = ISafe(safeProxy);

        // Verify the Safe from the Safe itself, never from what this test asked
        // for (governance-isomorphism.md R12).
        assertEq(safe.getThreshold(), 2, "safe threshold must be 2");
        assertEq(safe.getOwners().length, 3, "safe must have 3 owners");
        for (uint256 i = 0; i < owners.length; i++) {
            assertTrue(safe.isOwner(owners[i]), "every intended signer must be a safe owner");
        }
        // SafeProxy keeps its singleton in storage slot 0 (`masterCopy`): the proxy
        // must delegate to SafeL2, not the L1 singleton (R4).
        assertEq(
            address(uint160(uint256(vm.load(safeProxy, bytes32(0))))),
            SAFE_SINGLETON_L2,
            "safe proxy must delegate to the SafeL2 singleton"
        );
        // setup() stored the canonical fallback handler, and the handler and
        // MultiSend the Safe set promises are real code on this fork, not empty
        // accounts a call would silently succeed against (R2).
        assertEq(
            address(uint160(uint256(vm.load(safeProxy, FALLBACK_HANDLER_STORAGE_SLOT)))),
            SAFE_FALLBACK_HANDLER,
            "safe fallback handler must be the canonical CompatibilityFallbackHandler"
        );
        assertGt(SAFE_FALLBACK_HANDLER.code.length, 0, "fallback handler has no code on this fork");
        assertGt(SAFE_MULTISEND.code.length, 0, "MultiSend has no code on this fork");

        // Deploy TimelockController and wire ADMIN_ROLE on all five contracts,
        // called from the deployer so its roles are the ones revoked.
        vm.prank(deployer);
        d = script.runInProcess(
            address(vault),
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            address(safe),
            makeAddr("emergency"), // independent emergency hot key (ACL-1 / F-01)
            MIN_DELAY
        );

        // Verify wiring.
        assertTrue(
            IAccessControl(address(vault)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on vault"
        );
        assertTrue(
            IAccessControl(address(gateway)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on gateway"
        );
        assertTrue(
            IAccessControl(address(registry)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on registry"
        );
        assertTrue(
            IAccessControl(address(router)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on router"
        );
        assertTrue(
            IAccessControl(address(governance)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on governance"
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();
        address[5] memory governed = _governed();
        for (uint256 i = 0; i < governed.length; i++) {
            adminHolders[governed[i]] = RoleHolders.holders(logs, governed[i], ADMIN_ROLE);
        }
        gatewayRootHolders = RoleHolders.holders(logs, address(gateway), bytes32(0));

        // Take a snapshot for per-test revert.
        _snap = vm.snapshot();
    }

    function _governed() internal view returns (address[5] memory) {
        return
            [
                address(vault),
                address(gateway),
                address(registry),
                address(router),
                address(governance)
            ];
    }

    // ─── The handover leaves no second admin ──────────────────────────────────

    /// @notice After the handover the timelock is the ONLY ADMIN_ROLE holder on
    ///         every governed contract, the router excepted: RouterGovernance
    ///         also holds router ADMIN_ROLE by design (R7). The lists are complete
    ///         member sets replayed from the role logs, so an admin nobody thought
    ///         to name (the deploy script's contract, the test) cannot hide.
    function test_handover_timelockIsTheOnlyAdminOnEveryGovernedContract() public withSnap {
        address[5] memory governed = _governed();
        for (uint256 i = 0; i < governed.length; i++) {
            address[] memory h = adminHolders[governed[i]];
            bool isRouter = governed[i] == address(router);
            assertEq(h.length, isRouter ? 2 : 1, "unexpected number of ADMIN_ROLE holders");
            for (uint256 j = 0; j < h.length; j++) {
                bool allowed =
                    h[j] == address(d.timelock) || (isRouter && h[j] == address(governance));
                assertTrue(allowed, "an address other than the timelock holds ADMIN_ROLE");
                assertTrue(
                    IAccessControl(governed[i]).hasRole(ADMIN_ROLE, h[j]),
                    "replay disagrees with hasRole"
                );
            }
            assertFalse(
                IAccessControl(governed[i]).hasRole(ADMIN_ROLE, deployer),
                "deployer (the script contract) kept ADMIN_ROLE"
            );
            assertFalse(
                IAccessControl(governed[i]).hasRole(ADMIN_ROLE, address(this)),
                "the test contract holds ADMIN_ROLE"
            );
        }
    }

    /// @notice No address other than the timelock holds the gateway root.
    function test_handover_timelockIsTheOnlyGatewayRootHolder() public withSnap {
        assertEq(
            gatewayRootHolders.length, 1, "gateway DEFAULT_ADMIN_ROLE has more than one holder"
        );
        assertEq(gatewayRootHolders[0], address(d.timelock), "gateway root is not the timelock");
        assertFalse(gateway.hasRole(bytes32(0), deployer), "deployer kept the gateway root");
        assertFalse(gateway.hasRole(bytes32(0), address(this)), "the test holds the gateway root");
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    /// @dev Revert to post-setUp snapshot before each test.
    modifier withSnap() {
        vm.revertTo(_snap);
        _snap = vm.snapshot();
        _;
    }

    /// @dev Return owners sorted ascending by address (Safe requirement).
    function _sortedOwners() internal view returns (address[] memory owners) {
        owners = new address[](3);
        owners[0] = owner1;
        owners[1] = owner2;
        owners[2] = owner3;
        // Simple 3-element sort.
        if (owners[0] > owners[1]) (owners[0], owners[1]) = (owners[1], owners[0]);
        if (owners[1] > owners[2]) (owners[1], owners[2]) = (owners[2], owners[1]);
        if (owners[0] > owners[1]) (owners[0], owners[1]) = (owners[1], owners[0]);
    }

    /// @dev Get private key for a given owner address.
    function _pkFor(address owner) internal view returns (uint256) {
        if (owner == owner1) return ownerPk1;
        if (owner == owner2) return ownerPk2;
        if (owner == owner3) return ownerPk3;
        revert("unknown owner");
    }

    /// @dev Build a 2-of-3 packed signature for a Safe transaction hash.
    ///      Signs with the two lowest-address owners (sorted ascending — Safe requirement).
    function _buildTwoOwnerSigs(bytes32 txHash) internal view returns (bytes memory) {
        address[] memory sorted = _sortedOwners();
        // Sign with first two (sorted ascending — Safe requires signers sorted by address).
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(_pkFor(sorted[0]), txHash);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(_pkFor(sorted[1]), txHash);
        // Pack: each sig is 65 bytes (r, s, v).
        return abi.encodePacked(r1, s1, v1, r2, s2, v2);
    }

    /// @dev Build a 1-of-3 packed signature (only one owner signs — quorum not met).
    function _buildOneOwnerSig(bytes32 txHash) internal view returns (bytes memory) {
        address[] memory sorted = _sortedOwners();
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(_pkFor(sorted[0]), txHash);
        return abi.encodePacked(r1, s1, v1);
    }

    /// @dev Sign `txHash` with a single non-owner key and return the 65-byte sig.
    function _signOne(uint256 pk, bytes32 txHash) internal view returns (bytes memory sig65) {
        (uint8 v_, bytes32 r_, bytes32 s_) = vm.sign(pk, txHash);
        sig65 = abi.encodePacked(r_, s_, v_);
    }

    /// @dev Build a 2-signer signature using two private keys NOT in the Safe owner set.
    ///      Splits signing into a helper to stay within the stack-depth limit.
    function _buildWrongSignerSigs(bytes32 txHash) internal view returns (bytes memory) {
        uint256 wrongPkA = uint256(keccak256("wrong-signer-1"));
        uint256 wrongPkB = uint256(keccak256("wrong-signer-2"));
        return bytes.concat(_signOne(wrongPkA, txHash), _signOne(wrongPkB, txHash));
    }

    /// @dev Execute a Safe transaction that calls `callData` on `target`.
    ///      Builds the EIP-712 hash, signs with two owners, calls execTransaction.
    function _safeExec(address target, bytes memory callData, bytes memory signatures)
        internal
        returns (bool)
    {
        uint256 currentNonce = safe.nonce();
        bytes32 txHash = safe.getTransactionHash(
            target,
            0, // value
            callData,
            0, // operation = CALL
            0, // safeTxGas
            0, // baseGas
            0, // gasPrice
            address(0), // gasToken
            payable(address(0)), // refundReceiver
            currentNonce
        );
        return safe.execTransaction(
            target,
            0, // value
            callData,
            0, // operation = CALL
            0, // safeTxGas
            0, // baseGas
            0, // gasPrice
            address(0), // gasToken
            payable(address(0)), // refundReceiver
            signatures
        );
    }

    /// @dev Schedule an operation through the TimelockController via the Safe, then
    ///      mine the delay and execute. Returns when the operation is done.
    function _scheduleAndExecute(address target, bytes memory callData) internal {
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256(abi.encode(target, callData, block.timestamp));

        // Schedule: Safe calls timelock.schedule(...)
        bytes memory scheduleCall = abi.encodeCall(
            d.timelock.schedule, (target, 0, callData, predecessor, salt, MIN_DELAY)
        );

        bytes32 scheduleTxHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        bytes memory scheduleSigs = _buildTwoOwnerSigs(scheduleTxHash);
        bool ok = _safeExec(address(d.timelock), scheduleCall, scheduleSigs);
        assertTrue(ok, "safe.execTransaction(schedule) failed");

        // Advance time past the timelock delay.
        vm.warp(block.timestamp + MIN_DELAY + 1);

        // Execute: Safe calls timelock.execute(...)
        bytes memory executeCall =
            abi.encodeCall(d.timelock.execute, (target, 0, callData, predecessor, salt));

        bytes32 executeTxHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            executeCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        bytes memory executeSigs = _buildTwoOwnerSigs(executeTxHash);
        ok = _safeExec(address(d.timelock), executeCall, executeSigs);
        assertTrue(ok, "safe.execTransaction(execute) failed");
    }

    // ─── SKIP guard ───────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────────────────
    // Happy-path: Safe → TimelockController → governed contract
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice AC1a: Full Safe.execTransaction() → schedule → mine delay → execute on VaultRegistry.
    function test_happyPath_vaultRegistry_registerVault() public withSnap {
        address newVault = makeAddr("newVault");
        VaultRegistry.VaultMetadata memory meta = VaultRegistry.VaultMetadata({
            name: "Test Vault", asset: address(usdc), registeredAt: block.timestamp
        });
        bytes memory callData = abi.encodeCall(VaultRegistry.registerVault, (newVault, meta));

        _scheduleAndExecute(address(registry), callData);

        assertEq(registry.vaultCount(), 1, "vault should be registered after timelock execution");
    }

    /// @notice AC1b: Full Safe+timelock path on PortfolioRouter (setRouterCap).
    function test_happyPath_portfolioRouter_setRouterCap() public withSnap {
        bytes memory callData = abi.encodeCall(PortfolioRouter.setRouterCap, (1_000_000e6));
        _scheduleAndExecute(address(router), callData);

        assertEq(router.routerCap(), 1_000_000e6, "router cap should be updated");
    }

    /// @notice AC1c: Full Safe+timelock path on RouterGovernance (setQuorumThreshold).
    function test_happyPath_routerGovernance_setQuorumThreshold() public withSnap {
        bytes memory callData = abi.encodeCall(RouterGovernance.setQuorumThreshold, (5));
        _scheduleAndExecute(address(governance), callData);

        assertEq(governance.quorumThreshold(), 5, "quorum threshold should be updated");
    }

    /// @notice AC1d: Full Safe+timelock path on RobotMoneyVault (setExitFeeBps).
    function test_happyPath_vault_setExitFeeBps() public withSnap {
        bytes memory callData = abi.encodeCall(RobotMoneyVault.setExitFeeBps, (50));
        _scheduleAndExecute(address(vault), callData);

        assertEq(vault.exitFeeBps(), 50, "exit fee bps should be updated");
    }

    /// @notice AC1e: Full Safe+timelock path on RobotMoneyGateway (ADMIN_ROLE grant).
    function test_happyPath_gateway_adminRoleGrant() public withSnap {
        address newAdmin = makeAddr("newAdmin");
        bytes memory callData = abi.encodeCall(IAccessControl.grantRole, (ADMIN_ROLE, newAdmin));
        _scheduleAndExecute(address(gateway), callData);

        assertTrue(
            IAccessControl(address(gateway)).hasRole(ADMIN_ROLE, newAdmin),
            "newAdmin should hold ADMIN_ROLE on gateway"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sad-path: quorum not met (1-of-3 signature)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice AC2 / governance-isomorphism.md R13: threshold - 1 valid owner signatures
    ///         revert with Safe's own GS020, and the very same SafeTx then succeeds with
    ///         threshold signatures. The positive twin is what makes the revert evidence
    ///         of quorum enforcement rather than of some unrelated failure that a bare
    ///         `expectRevert()` would also have accepted.
    function test_sadPath_quorumNotMet_oneSignerReverts() public withSnap {
        bytes memory callData = abi.encodeCall(
            VaultRegistry.registerVault,
            (
                makeAddr("vault"),
                VaultRegistry.VaultMetadata({
                    name: "x", asset: address(usdc), registeredAt: block.timestamp
                })
            )
        );
        bytes memory scheduleCall = abi.encodeCall(
            d.timelock.schedule,
            (address(registry), 0, callData, bytes32(0), keccak256("salt1"), MIN_DELAY)
        );

        bytes32 txHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        bytes memory sigs = _buildOneOwnerSig(txHash);

        // GS020: signatures data too short for the threshold.
        vm.expectRevert(bytes("GS020"));
        safe.execTransaction(
            address(d.timelock), 0, scheduleCall, 0, 0, 0, 0, address(0), payable(address(0)), sigs
        );

        // The revert consumed no nonce, so the identical SafeTx is still the pending
        // one: with a second owner's signature it must now go through.
        assertTrue(
            safe.execTransaction(
                address(d.timelock),
                0,
                scheduleCall,
                0,
                0,
                0,
                0,
                address(0),
                payable(address(0)),
                _buildTwoOwnerSigs(txHash)
            ),
            "the same SafeTx must execute once quorum is met"
        );
    }

    /// @notice R13 / §1.1 "two DISTINCT owner signatures": one owner signing twice has
    ///         the right byte length but only one owner's authority. Safe requires
    ///         strictly ascending signers, so the repeat reverts GS026.
    function test_sadPath_sameOwnerTwice_reverts() public withSnap {
        bytes memory scheduleCall = abi.encodeCall(
            d.timelock.schedule,
            (address(registry), 0, hex"", bytes32(0), keccak256("salt-dup"), MIN_DELAY)
        );
        bytes32 txHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        bytes memory one = _buildOneOwnerSig(txHash);

        vm.expectRevert(bytes("GS026"));
        safe.execTransaction(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            bytes.concat(one, one)
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sad-path: wrong signers (addresses not in the owner set)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice AC3: Two signatures from addresses not in the Safe owner set revert.
    function test_sadPath_wrongSigners_revert() public withSnap {
        bytes memory callData = abi.encodeCall(
            VaultRegistry.registerVault,
            (
                makeAddr("vault2"),
                VaultRegistry.VaultMetadata({
                    name: "y", asset: address(usdc), registeredAt: block.timestamp
                })
            )
        );
        bytes memory scheduleCall = abi.encodeCall(
            d.timelock.schedule,
            (address(registry), 0, callData, bytes32(0), keccak256("salt2"), MIN_DELAY)
        );

        bytes32 txHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        bytes memory sigs = _buildWrongSignerSigs(txHash);

        // GS026: a recovered signer that is not an owner.
        vm.expectRevert(bytes("GS026"));
        safe.execTransaction(
            address(d.timelock), 0, scheduleCall, 0, 0, 0, 0, address(0), payable(address(0)), sigs
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sad-path: execute before min delay elapses
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice AC4: TimelockController.execute() before min delay elapses reverts.
    function test_sadPath_preDelayExecute_reverts() public withSnap {
        address newVault = makeAddr("vaultForDelay");
        VaultRegistry.VaultMetadata memory meta = VaultRegistry.VaultMetadata({
            name: "Delay Test", asset: address(usdc), registeredAt: block.timestamp
        });
        bytes memory callData = abi.encodeCall(VaultRegistry.registerVault, (newVault, meta));
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("pre-delay-salt");

        // Schedule via Safe.
        bytes memory scheduleCall = abi.encodeCall(
            d.timelock.schedule, (address(registry), 0, callData, predecessor, salt, MIN_DELAY)
        );
        bytes32 scheduleTxHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        safe.execTransaction(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _buildTwoOwnerSigs(scheduleTxHash)
        );

        // Attempt execute before delay — must revert.
        bytes memory executeCall =
            abi.encodeCall(d.timelock.execute, (address(registry), 0, callData, predecessor, salt));
        bytes32 executeTxHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            executeCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        // The Safe transaction itself succeeds (the Safe doesn't know about the delay),
        // but the inner timelock.execute() call must fail.
        // execTransaction returns false (and does NOT revert) when the inner call fails
        // with requireSuccess=false. With default Safe behaviour the inner revert bubbles
        // up as a Safe GS013 revert.
        vm.expectRevert();
        safe.execTransaction(
            address(d.timelock),
            0,
            executeCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _buildTwoOwnerSigs(executeTxHash)
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sad-path: replay of an already-executed operation
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice AC5: Replaying an already-executed Safe+timelock operation reverts.
    function test_sadPath_replay_reverts() public withSnap {
        address newVault = makeAddr("vaultForReplay");
        VaultRegistry.VaultMetadata memory meta = VaultRegistry.VaultMetadata({
            name: "Replay Test", asset: address(usdc), registeredAt: block.timestamp
        });
        bytes memory callData = abi.encodeCall(VaultRegistry.registerVault, (newVault, meta));
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("replay-salt");

        // First: schedule.
        bytes memory scheduleCall = abi.encodeCall(
            d.timelock.schedule, (address(registry), 0, callData, predecessor, salt, MIN_DELAY)
        );
        bytes32 scheduleTxHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        safe.execTransaction(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _buildTwoOwnerSigs(scheduleTxHash)
        );

        // Advance past delay.
        vm.warp(block.timestamp + MIN_DELAY + 1);

        // Execute (first time — should succeed).
        bytes memory executeCall =
            abi.encodeCall(d.timelock.execute, (address(registry), 0, callData, predecessor, salt));
        bytes32 execTxHash1 = safe.getTransactionHash(
            address(d.timelock),
            0,
            executeCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        bool ok = safe.execTransaction(
            address(d.timelock),
            0,
            executeCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _buildTwoOwnerSigs(execTxHash1)
        );
        assertTrue(ok, "first execute should succeed");
        assertEq(registry.vaultCount(), 1, "vault should be registered");

        // Attempt replay (second execute with same params) — must revert.
        bytes32 execTxHash2 = safe.getTransactionHash(
            address(d.timelock),
            0,
            executeCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        vm.expectRevert();
        safe.execTransaction(
            address(d.timelock),
            0,
            executeCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _buildTwoOwnerSigs(execTxHash2)
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sad-path: direct ADMIN_ROLE call bypassing Safe + timelock
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice AC6a: Direct ADMIN_ROLE call on VaultRegistry reverts.
    function test_sadPath_directAdminBypass_vaultRegistry() public withSnap {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), ADMIN_ROLE
            )
        );
        vm.prank(address(safe));
        registry.registerVault(
            makeAddr("x"),
            VaultRegistry.VaultMetadata({
                name: "x", asset: address(usdc), registeredAt: block.timestamp
            })
        );
    }

    /// @notice AC6b: Direct ADMIN_ROLE call on PortfolioRouter reverts.
    function test_sadPath_directAdminBypass_portfolioRouter() public withSnap {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), ADMIN_ROLE
            )
        );
        vm.prank(address(safe));
        router.setRouterCap(42);
    }

    /// @notice AC6c: Direct ADMIN_ROLE call on RouterGovernance reverts.
    function test_sadPath_directAdminBypass_routerGovernance() public withSnap {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), ADMIN_ROLE
            )
        );
        vm.prank(address(safe));
        governance.setQuorumThreshold(99);
    }

    /// @notice AC6d: Direct ADMIN_ROLE call on RobotMoneyVault reverts.
    function test_sadPath_directAdminBypass_vault() public withSnap {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), ADMIN_ROLE
            )
        );
        vm.prank(address(safe));
        vault.setExitFeeBps(10);
    }

    /// @notice AC6e: Direct root-admin call on RobotMoneyGateway reverts.
    function test_sadPath_directAdminBypass_gateway() public withSnap {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), bytes32(0)
            )
        );
        vm.prank(address(safe));
        IAccessControl(address(gateway)).grantRole(ADMIN_ROLE, makeAddr("attacker"));
    }

    /// @notice AC6f: Direct ADMIN_ROLE call from random EOA reverts (all contracts).
    function test_sadPath_directAdminBypass_stranger() public withSnap {
        address stranger = makeAddr("stranger");

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ADMIN_ROLE
            )
        );
        vm.prank(stranger);
        registry.registerVault(
            makeAddr("v"),
            VaultRegistry.VaultMetadata({
                name: "v", asset: address(usdc), registeredAt: block.timestamp
            })
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sad-path: cancelled operation cannot be executed
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice AC7: A cancelled timelock operation cannot be executed after cancellation.
    function test_sadPath_cancelledOperation_cannotExecute() public withSnap {
        address newVault = makeAddr("vaultForCancel");
        VaultRegistry.VaultMetadata memory meta = VaultRegistry.VaultMetadata({
            name: "Cancel Test", asset: address(usdc), registeredAt: block.timestamp
        });
        bytes memory callData = abi.encodeCall(VaultRegistry.registerVault, (newVault, meta));
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("cancel-salt");

        bytes32 opId = d.timelock.hashOperation(address(registry), 0, callData, predecessor, salt);

        // Schedule via Safe.
        bytes memory scheduleCall = abi.encodeCall(
            d.timelock.schedule, (address(registry), 0, callData, predecessor, salt, MIN_DELAY)
        );
        bytes32 scheduleTxHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        safe.execTransaction(
            address(d.timelock),
            0,
            scheduleCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _buildTwoOwnerSigs(scheduleTxHash)
        );

        // Cancel through the Safe itself, with two owner signatures: OZ v5's
        // TimelockController grants every proposer CANCELLER_ROLE, so the Safe
        // holds it, and only a quorum of owners can make the Safe use it. A
        // vm.prank here would prove the role, not the quorum.
        assertTrue(
            d.timelock.hasRole(d.timelock.CANCELLER_ROLE(), address(safe)),
            "safe must hold CANCELLER_ROLE"
        );
        bytes memory cancelCall = abi.encodeCall(d.timelock.cancel, (opId));
        bytes32 cancelTxHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            cancelCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        assertTrue(
            _safeExec(address(d.timelock), cancelCall, _buildTwoOwnerSigs(cancelTxHash)),
            "safe.execTransaction(cancel) failed"
        );

        // Verify operation is cancelled (state = Unset).
        assertEq(
            uint256(d.timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Unset),
            "operation should be Unset after cancellation"
        );

        // Advance past delay — attempt execute should revert.
        vm.warp(block.timestamp + MIN_DELAY + 1);

        bytes memory executeCall =
            abi.encodeCall(d.timelock.execute, (address(registry), 0, callData, predecessor, salt));
        bytes32 executeTxHash = safe.getTransactionHash(
            address(d.timelock),
            0,
            executeCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            safe.nonce()
        );
        vm.expectRevert();
        safe.execTransaction(
            address(d.timelock),
            0,
            executeCall,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _buildTwoOwnerSigs(executeTxHash)
        );
    }
}

// ─── Minimal interface shim for Safe.setup() ─────────────────────────────────

/// @dev Used only to generate the `setup(...)` calldata for SafeProxyFactory.
///      Not imported from a Safe library to keep the test self-contained.
interface _ISafeSetup {
    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}
