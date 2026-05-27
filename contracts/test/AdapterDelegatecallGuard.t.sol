// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §2 — adapter-allowlist no-proxy invariant.
// Issue: #448 — guard RobotMoneyVault adapter codehash check against
//                delegatecall-proxy adapters.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AdapterBytecodeGuard} from "../script/AdapterBytecodeGuard.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../adapters/CompoundV3Adapter.sol";
import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {PassthroughAdapter} from "../adapters/PassthroughAdapter.sol";

/// @dev A contrived "proxy adapter" whose runtime bytecode contains a
///      `DELEGATECALL` opcode. Mirrors the EIP-1167 minimal-proxy shape: a
///      single delegatecall to a stored implementation. The point is purely
///      that `address(this).code` contains opcode `0xF4`; the adapter is
///      never actually wired to a vault.
contract DelegatecallProxyAdapter {
    address public immutable IMPLEMENTATION;

    constructor(address implementation_) {
        IMPLEMENTATION = implementation_;
    }

    /// @dev Fallback performs a `delegatecall`. The compiler emits a `0xF4`
    ///      opcode in the runtime bytecode of this function.
    fallback() external payable {
        address impl = IMPLEMENTATION;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

/// @dev Library-consumer harness so we can test `requireNoDelegatecall`
///      with `vm.expectRevert` against the library's custom error.
contract GuardHarness {
    function requireNoDelegatecall(address adapter_) external view {
        AdapterBytecodeGuard.requireNoDelegatecall(adapter_);
    }

    function containsDelegatecall(bytes memory code) external pure returns (bool) {
        return AdapterBytecodeGuard.containsDelegatecall(code);
    }
}

contract AdapterDelegatecallGuardTest is Test {
    GuardHarness internal guard;
    address internal usdc = makeAddr("usdc");
    address internal vaultAddr = makeAddr("vault");

    function setUp() public {
        guard = new GuardHarness();
    }

    // ─── Contrived-proxy regression ─────────────────────────────────────

    function test_requireNoDelegatecall_revertsForProxyAdapter() public {
        DelegatecallProxyAdapter proxy = new DelegatecallProxyAdapter(makeAddr("impl"));
        // Confirm the contrived adapter does in fact contain the opcode.
        assertTrue(
            guard.containsDelegatecall(address(proxy).code),
            "proxy bytecode must contain DELEGATECALL for this test to be meaningful"
        );

        vm.expectRevert();
        guard.requireNoDelegatecall(address(proxy));
    }

    // ─── Currently-approved adapters must pass ─────────────────────────

    function test_requireNoDelegatecall_passesForAaveAdapter() public {
        AaveV3Adapter aave =
            new AaveV3Adapter(makeAddr("aavePool"), usdc, makeAddr("aToken"), vaultAddr);
        guard.requireNoDelegatecall(address(aave));
        assertFalse(guard.containsDelegatecall(address(aave).code));
    }

    function test_requireNoDelegatecall_passesForCompoundAdapter() public {
        CompoundV3Adapter compound = new CompoundV3Adapter(makeAddr("comet"), usdc, vaultAddr);
        guard.requireNoDelegatecall(address(compound));
        assertFalse(guard.containsDelegatecall(address(compound).code));
    }

    function test_requireNoDelegatecall_passesForMorphoAdapter() public {
        MorphoAdapter morpho = new MorphoAdapter(makeAddr("morphoVault"), usdc, vaultAddr);
        guard.requireNoDelegatecall(address(morpho));
        assertFalse(guard.containsDelegatecall(address(morpho).code));
    }

    function test_requireNoDelegatecall_passesForPassthroughAdapter() public {
        PassthroughAdapter passthrough = new PassthroughAdapter(usdc, vaultAddr);
        guard.requireNoDelegatecall(address(passthrough));
        assertFalse(guard.containsDelegatecall(address(passthrough).code));
    }

    // ─── PUSH-immediate false-positive guard ───────────────────────────

    /// @dev Bytecode `PUSH1 0xF4 STOP` contains byte `0xF4` but only as the
    ///      immediate of a `PUSH1`, not as an opcode. The scan must skip it.
    function test_containsDelegatecall_skipsPushImmediate() public view {
        bytes memory code = hex"60F400"; // PUSH1 0xF4 ; STOP
        assertFalse(guard.containsDelegatecall(code));
    }

    /// @dev Bytecode `STOP DELEGATECALL` should be detected.
    function test_containsDelegatecall_detectsBareOpcode() public view {
        bytes memory code = hex"00F4";
        assertTrue(guard.containsDelegatecall(code));
    }

    /// @dev `PUSH32 <31 bytes> 0xF4` — the trailing `0xF4` is still immediate
    ///      data for the PUSH32 and must not be flagged.
    function test_containsDelegatecall_skipsPush32Immediate() public view {
        bytes memory code = hex"7f00000000000000000000000000000000000000000000000000000000000000F4";
        assertFalse(guard.containsDelegatecall(code));
    }
}
