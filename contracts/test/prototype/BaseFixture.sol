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
///
///         The check is slow: it records every storage access and decodes it after each phase. A test that
///         runs thousands of slots (the rebalance sim) turns it off by default through `_fixtureCheckByDefault`.
///         `PROTO_FIXTURE_CHECK=1` (or `=0`) overrides the default for every test. The recorder's replay passes
///         set it to 1, so each re-recorded fixture is proven to cover the sim. A deterministic run that passed
///         the check on this fixture and code reads the same state when it runs without the check.
///
///         **Strict check** (`PROTO_FIXTURE_STRICT=1` with the check on; the recorder's replay passes set it). The
///         recorder replays first and records only what misses, so a test may be accepted on a fixture that no
///         recording of its current code produced. The strict check makes that as safe as recording it: every
///         account the test touches (called, created, balance or code read, or calling) must be in the fixture,
///         and every slot of a fixture account it reads or writes must be in it, not only the slots it reads
///         first. An account the fixture lacks is allowed only if it holds code the test did not create (forge's
///         linked libraries, `vm.etch`) or is a precompile or forge's own. The strict check also reports what it
///         saw, as `-vv` logs: `fixture-strict: setUp` from `setUp`, `fixture-strict: final` after the last check
///         of a `fixtureCovered` test, and `fixture-manifest-accounts` / `fixture-manifest-slots` (packed
///         addresses, and address plus slot) for every fixture account and slot touched. The recorder keeps them
///         as the pass's manifest. Without `PROTO_FIXTURE_STRICT` the check is exactly the one described above.
abstract contract BaseFixture is Test {
    string internal constant ALLOC_PATH = "contracts/test/prototype/fixtures/base-state.alloc.json";
    string internal constant META_PATH = "contracts/test/prototype/fixtures/base-state.meta.json";

    error FixtureSlotMiss(address account, bytes32 slot);
    error FixtureAccountMiss(address account);
    /// @dev Strict check only: the test touched an account the fixture lacks.
    error FixtureStrictAccountMiss(address account);
    /// @dev Strict check only: the test wrote a fixture account's slot, before reading it, that the fixture lacks.
    error FixtureStrictSlotMiss(address account, bytes32 slot);

    /// @dev Forge's deployer of linked libraries (`keccak256("foundry library deployer")`): it deploys them through
    ///      the CREATE2 factory on forge's own chain before the fork exists, so no recording ever fetches it.
    address internal constant LIBRARY_DEPLOYER = 0x1F95D37F27EA0dEA9C252FC09D5A6eaA97647353;

    bool internal recording;
    /// @dev Replay with the coverage check on (see the contract note).
    bool internal fixtureCheck;
    /// @dev Replay with the strict check on (see the contract note). Implies `fixtureCheck`.
    bool internal fixtureStrict;

    mapping(address => bool) private _fxAccount;
    mapping(address => mapping(bytes32 => bool)) private _fxSlot;
    mapping(address => mapping(bytes32 => bool)) private _seen;
    /// @dev Contracts the test created. Internal so a test that consumes part of the recording itself
    ///      (Invariants) can report its creations here too.
    mapping(address => bool) internal _created;
    /// @dev Strict only: contracts the test created on the fixture's chain (forge creates the linked libraries on its
    ///      own chain first). A record run reads each of these addresses, so the fixture must hold them.
    mapping(address => bool) private _createdHere;

    function setUp() public virtual {
        string memory rpc = vm.envOr("PROTO_RECORD_RPC", string(""));
        if (bytes(rpc).length != 0) {
            recording = true;
            vm.createSelectFork(rpc, vm.envUint("PROTO_PIN"));
        } else {
            fixtureCheck = vm.envOr("PROTO_FIXTURE_CHECK", _fixtureCheckByDefault());
            fixtureStrict = fixtureCheck && vm.envOr("PROTO_FIXTURE_STRICT", false);
            _loadFixture();
        }
        if (fixtureStrict) emit log_named_string("fixture-strict", "setUp");
        if (fixtureCheck) vm.startStateDiffRecording();
    }

    /// @dev Whether replay runs the coverage check when PROTO_FIXTURE_CHECK is unset.
    function _fixtureCheckByDefault() internal view virtual returns (bool) {
        return true;
    }

    /// @dev Put on every prototype test. Runs the coverage check after the test body in replay.
    modifier fixtureCovered() {
        _;
        if (fixtureCheck) this.checkFixtureCoverageNow();
        if (fixtureStrict) emit log_named_string("fixture-strict", "final");
    }

    /// @dev Skips the current test the way `vm.skip(true, reason)` does, after the coverage check (when it is on) has
    ///      checked everything the test read so far. A skip decided on fixture state (a G8 finding's numbers, "the
    ///      fixture lacks X") is then as proven as a pass: a miss fails loudly instead of skipping. In strict mode the
    ///      reason ends with `[fixture-strict: checked]`, which the recorder reads (forge keeps no logs of a skipped
    ///      test, only its reason).
    function _skipCovered(string memory reason) internal {
        if (fixtureCheck) this.checkFixtureCoverageNow();
        if (fixtureStrict) {
            reason =
                bytes(reason).length == 0 ? SKIP_CHECKED : string.concat(reason, " ", SKIP_CHECKED);
        }
        if (bytes(reason).length == 0) vm.skip(true);
        else vm.skip(true, reason);
    }

    string internal constant SKIP_CHECKED = "[fixture-strict: checked]";

    /// @dev Replay only: check everything recorded so far and restart the recording. A long test calls it
    ///      between phases. The check runs in an external self-call, so the decoded state diff lives in that
    ///      call's own memory and is freed on return: forge's EVM memory limit then bounds one phase, not the
    ///      whole test.
    function _fixtureCheckpoint() internal {
        if (fixtureCheck) this.checkFixtureCoverageNow();
    }

    /// @dev Self-call target of `fixtureCovered` and `_fixtureCheckpoint`. Not a test.
    function checkFixtureCoverageNow() external {
        require(msg.sender == address(this), "self only");
        _assertFixtureCovered();
        vm.startStateDiffRecording();
    }

    function _loadFixture() private {
        string memory meta = vm.readFile(META_PATH);
        vm.loadAllocs(ALLOC_PATH);
        vm.chainId(vm.parseJsonUint(meta, ".chainId"));
        vm.roll(vm.parseJsonUint(meta, ".block"));
        vm.warp(vm.parseJsonUint(meta, ".timestamp"));
        vm.fee(vm.parseJsonUint(meta, ".basefee"));
        if (!fixtureCheck) return;

        // The slot index is parsed once: a parse per account would copy the whole meta file into memory once
        // per account. Indexing thousands of slots costs more gas than a test has, so it runs unmetered (it is
        // the fixture's own bookkeeping, not code under test).
        vm.pauseGasMetering();
        address[] memory accounts = vm.parseJsonAddressArray(meta, ".accounts");
        bytes32[][] memory slots = abi.decode(vm.parseJson(meta, ".slots"), (bytes32[][]));
        require(slots.length == accounts.length, "fixture meta: one slot list per account");
        for (uint256 i = 0; i < accounts.length; i++) {
            address a = accounts[i];
            _fxAccount[a] = true;
            bytes32[] memory s = slots[i];
            for (uint256 j = 0; j < s.length; j++) {
                _fxSlot[a][s[j]] = true;
            }
        }
        vm.resumeGasMetering();
    }

    function _assertFixtureCovered() private {
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        // Mark every contract the test created first: forge lists a constructor's nested calls (a proxy's
        // initializer delegatecall) before the Create entry itself. The record run also fetches each
        // address the test deploys to, so the fixture lists them as (empty) accounts. Their storage is
        // the test's own, never Base state, so it needs no fixture slot.
        uint256 nStorage;
        for (uint256 i = 0; i < acc.length; i++) {
            if (acc[i].kind == VmSafe.AccountAccessKind.Create) {
                _created[acc[i].account] = true;
                if (acc[i].chainInfo.chainId == block.chainid) _createdHere[acc[i].account] = true;
            }
            nStorage += acc[i].storageAccesses.length;
        }
        // Strict only: what this check saw, for the manifest (upper bounds; `nA` and `nS` count the entries).
        Manifest memory m;
        if (fixtureStrict) {
            m.accounts = new address[](2 * acc.length);
            m.slotAccounts = new address[](nStorage);
            m.slots = new bytes32[](nStorage);
        }
        for (uint256 i = 0; i < acc.length; i++) {
            VmSafe.AccountAccess memory x = acc[i];
            // Entries on another chain than the fixture's happened on forge's own chain before `_loadFixture` set the
            // chain id: forge deploying the linked libraries (library deployer, CREATE2 factory, the libraries).
            if (fixtureStrict && x.chainInfo.chainId == block.chainid) {
                _strictAccount(x.account, m);
                _strictAccount(x.accessor, m);
            }
            bool isCall = x.kind == VmSafe.AccountAccessKind.Call
                || x.kind == VmSafe.AccountAccessKind.StaticCall
                || x.kind == VmSafe.AccountAccessKind.DelegateCall;
            if (
                isCall && x.data.length != 0 && !_fxAccount[x.account] && !_created[x.account]
                    && uint160(x.account) > 0xffff && x.account.code.length == 0
            ) revert FixtureAccountMiss(x.account);

            for (uint256 j = 0; j < x.storageAccesses.length; j++) {
                VmSafe.StorageAccess memory s = x.storageAccesses[j];
                if (!_fxAccount[s.account] || _created[s.account] || _seen[s.account][s.slot]) {
                    continue;
                }
                _seen[s.account][s.slot] = true;
                if (!_fxSlot[s.account][s.slot]) {
                    if (!s.isWrite) revert FixtureSlotMiss(s.account, s.slot);
                    if (fixtureStrict) revert FixtureStrictSlotMiss(s.account, s.slot);
                } else if (fixtureStrict) {
                    m.slotAccounts[m.nS] = s.account;
                    m.slots[m.nS] = s.slot;
                    m.nS++;
                }
            }
        }
        if (fixtureStrict) _emitManifest(m);
    }

    /// @dev Strict only: the fixture accounts and slots one check saw, each once per test (slots through `_seen`,
    ///      accounts through transient storage, which forge's isolation resets per call, so an account can repeat
    ///      across checks; the recorder dedups).
    struct Manifest {
        address[] accounts;
        uint256 nA;
        address[] slotAccounts;
        bytes32[] slots;
        uint256 nS;
    }

    function _strictAccount(address a, Manifest memory m) private {
        if (_fxAccount[a]) {
            bytes32 key = keccak256(abi.encode("fixture.seenAccount", a));
            bool seen;
            assembly {
                seen := tload(key)
            }
            if (!seen) {
                assembly {
                    tstore(key, 1)
                }
                m.accounts[m.nA] = a;
                m.nA++;
            }
            return;
        }
        if (
            uint160(a) <= 0xffff || a == address(this) || a == VM_ADDRESS || a == CONSOLE
                || a == DEFAULT_SENDER || a == LIBRARY_DEPLOYER
        ) return;
        // A contract the test created must be in the fixture (the record run reads every address it deploys to, so
        // the fixture holds its real balance). Other code the fixture lacks is forge's (linked libraries) or the
        // test's own (`vm.etch`), not Base state.
        if (!_createdHere[a] && a.code.length != 0) return;
        revert FixtureStrictAccountMiss(a);
    }

    /// @dev Packs 20-byte addresses (accounts) and 20-byte address plus 32-byte slot (slots), back to back.
    function _emitManifest(Manifest memory m) private {
        if (m.nA != 0) {
            // 12 spare bytes: each 32-byte store writes an address and 12 zero bytes the next store overwrites.
            bytes memory packed = new bytes(m.nA * 20 + 12);
            address[] memory accounts = m.accounts;
            uint256 n = m.nA;
            assembly {
                let out := add(packed, 32)
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    mstore(add(out, mul(i, 20)), shl(96, mload(add(add(accounts, 32), mul(i, 32)))))
                }
                mstore(packed, mul(n, 20))
            }
            emit log_named_bytes("fixture-manifest-accounts", packed);
        }
        if (m.nS != 0) {
            bytes memory packed = new bytes(m.nS * 52);
            address[] memory slotAccounts = m.slotAccounts;
            bytes32[] memory slots = m.slots;
            uint256 n = m.nS;
            assembly {
                let out := add(packed, 32)
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let o := add(out, mul(i, 52))
                    mstore(o, shl(96, mload(add(add(slotAccounts, 32), mul(i, 32)))))
                    mstore(add(o, 20), mload(add(add(slots, 32), mul(i, 32))))
                }
            }
            emit log_named_bytes("fixture-manifest-slots", packed);
        }
    }
}
