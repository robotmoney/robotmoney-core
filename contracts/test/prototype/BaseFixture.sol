// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice One-vault experiment (docs/technical/one-vault-rebalancer-proposal.md). Base for every
///         prototype test. The tests run on real Base state with no RPC and no anvil process:
///
///         - **Replay (default).** `setUp` loads the committed fixture
///           (`fixtures/base-state.alloc.json`) with `vm.loadAllocs` and sets the block, timestamp,
///           base fee and chain id from `fixtures/base-state.meta.json`. Plain `forge test` runs it.
///         - **Record.** With `PROTO_RECORD_RPC` and `PROTO_PIN` set, `setUp` forks real Base at the
///           pin. Forge's fork cache then holds the original value of every account and slot the
///           tests touched. `scripts/prototype/record-base-fixture.ts` turns that cache into the
///           fixture. Re-record whenever a test starts touching new state.
///
///         A fixture is lazy: it holds only what the recording run read. A slot it lacks would read
///         as zero in replay, which is a silent wrong answer. So every test that uses
///         `fixtureCovered` checks, after its body, that every storage slot of a fixture account it
///         read first (before writing it) is in the fixture, and that every contract it called
///         either is in the fixture or was created by the test. A miss fails with the account and
///         slot, so the fix (re-record) is named.
abstract contract BaseFixture is Test {
    string internal constant ALLOC_PATH = "contracts/test/prototype/fixtures/base-state.alloc.json";
    string internal constant META_PATH = "contracts/test/prototype/fixtures/base-state.meta.json";

    error FixtureSlotMiss(address account, bytes32 slot);
    error FixtureAccountMiss(address account);

    bool internal recording;

    mapping(address => bool) private _fxAccount;
    mapping(address => mapping(bytes32 => bool)) private _fxSlot;
    mapping(address => mapping(bytes32 => bool)) private _seen;
    mapping(address => bool) private _created;

    function setUp() public virtual {
        string memory rpc = vm.envOr("PROTO_RECORD_RPC", string(""));
        if (bytes(rpc).length != 0) {
            recording = true;
            vm.createSelectFork(rpc, vm.envUint("PROTO_PIN"));
        } else {
            _loadFixture();
        }
        vm.startStateDiffRecording();
    }

    /// @dev Put on every prototype test. Runs the coverage check after the test body in replay.
    modifier fixtureCovered() {
        _;
        if (!recording) _assertFixtureCovered();
    }

    function _loadFixture() private {
        string memory meta = vm.readFile(META_PATH);
        vm.loadAllocs(ALLOC_PATH);
        vm.chainId(vm.parseJsonUint(meta, ".chainId"));
        vm.roll(vm.parseJsonUint(meta, ".block"));
        vm.warp(vm.parseJsonUint(meta, ".timestamp"));
        vm.fee(vm.parseJsonUint(meta, ".basefee"));

        address[] memory accounts = vm.parseJsonAddressArray(meta, ".accounts");
        for (uint256 i = 0; i < accounts.length; i++) {
            address a = accounts[i];
            _fxAccount[a] = true;
            bytes32[] memory slots =
                vm.parseJsonBytes32Array(meta, string.concat(".slots[", vm.toString(i), "]"));
            for (uint256 j = 0; j < slots.length; j++) {
                _fxSlot[a][slots[j]] = true;
            }
        }
    }

    function _assertFixtureCovered() private {
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        for (uint256 i = 0; i < acc.length; i++) {
            VmSafe.AccountAccess memory x = acc[i];
            if (x.kind == VmSafe.AccountAccessKind.Create) _created[x.account] = true;
            bool isCall = x.kind == VmSafe.AccountAccessKind.Call
                || x.kind == VmSafe.AccountAccessKind.StaticCall
                || x.kind == VmSafe.AccountAccessKind.DelegateCall;
            if (
                isCall && x.data.length != 0 && !_fxAccount[x.account] && !_created[x.account]
                    && uint160(x.account) > 0xffff && x.account.code.length == 0
            ) revert FixtureAccountMiss(x.account);

            for (uint256 j = 0; j < x.storageAccesses.length; j++) {
                VmSafe.StorageAccess memory s = x.storageAccesses[j];
                if (!_fxAccount[s.account] || _seen[s.account][s.slot]) continue;
                _seen[s.account][s.slot] = true;
                if (!s.isWrite && !_fxSlot[s.account][s.slot]) {
                    revert FixtureSlotMiss(s.account, s.slot);
                }
            }
        }
    }
}
