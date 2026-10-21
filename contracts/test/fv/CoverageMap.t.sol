// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md
//
// COVERAGE-MAP GATE (issue #964, AC1 / Test-plan 2)
// ─────────────────────────────────────────────────
// Enforces a 1:1 mapping between the invariant IDs declared in the textual
// source of truth (docs/technical/smart-contract-invariants.md) and the IDs in
// the executable InvariantRegistry. CI fails if either side has an ID the other
// lacks, so a new invariant added to the spec without a corresponding FV test
// (registry entry) breaks the build — and a stray/typo'd registry entry that the
// spec does not document also breaks it.
//
// HOW SPEC IDs ARE PARSED: every invariant entry in the spec begins a line with
//   > **`ID` —
// (see the spec's "How to read an entry" section). We scan for that exact
// `> **\`` prefix and read the backtick-delimited ID that follows. This is
// deterministic and immune to IDs that appear inline in prose (which are never
// at the start of a `> **\`` heading line).
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvariantRegistry} from "./InvariantRegistry.sol";

contract CoverageMapTest is Test {
    string internal constant SPEC = "docs/technical/smart-contract-invariants.md";

    /// @dev Heading marker that precedes every invariant ID in the spec.
    bytes internal constant HEADING = bytes("> **`");

    /// @notice AC1: every invariant ID in the spec has exactly one registry entry,
    ///         and every registry entry corresponds to a spec ID. Fails CI if the
    ///         two sets diverge in either direction.
    function test_specAndRegistryAreInBijection() public view {
        string[] memory specIds = _parseSpecIds(vm.readFile(SPEC));
        InvariantRegistry.Entry[] memory reg = InvariantRegistry.entries();

        // 1. Every spec ID is present in the registry.
        for (uint256 i = 0; i < specIds.length; i++) {
            assertTrue(
                _registryHas(reg, specIds[i]),
                string.concat(
                    "Spec invariant ",
                    specIds[i],
                    " has no InvariantRegistry entry (unmapped FV test)"
                )
            );
        }

        // 2. Every registry ID is present in the spec (no stray/typo'd entries).
        for (uint256 i = 0; i < reg.length; i++) {
            assertTrue(
                _arrayHas(specIds, reg[i].id),
                string.concat("Registry invariant ", reg[i].id, " is not documented in ", SPEC)
            );
        }

        // 3. Cardinality matches (no duplicate registry entries masking a gap).
        assertEq(
            specIds.length, reg.length, "spec-ID count != registry-entry count (duplicate or gap)"
        );
    }

    /// @notice Every RED registry entry names a remediation issue; every HOLDS or RETIRED
    ///         entry has none. Guards the invariant that an expected-fail test can
    ///         always tell its downstream issue which test to flip green.
    function test_everyRedEntryNamesRemediationIssue() public pure {
        InvariantRegistry.Entry[] memory reg = InvariantRegistry.entries();
        for (uint256 i = 0; i < reg.length; i++) {
            if (reg[i].status == InvariantRegistry.Status.RED) {
                require(
                    reg[i].remediationIssue != 0,
                    string.concat("RED entry ", reg[i].id, " has no remediation issue")
                );
            } else {
                require(
                    reg[i].remediationIssue == 0,
                    string.concat(
                        "HOLDS or RETIRED entry ", reg[i].id, " must not name a remediation issue"
                    )
                );
            }
        }
    }

    /// @notice Issue 1892 (RS-1019-11): a spec heading that is struck through (`~~`) and marked
    ///         Retired maps to exactly one TOMBSTONE registry entry, and a TOMBSTONE entry maps to
    ///         such a heading. ACL-4 and ACL-8 are tombstones. SYS-2 is a retired non-registry ID:
    ///         it has no `> **` heading and no registry entry.
    function test_tombstoneStatusMatchesRetiredHeadings() public view {
        string memory spec = vm.readFile(SPEC);
        string[] memory ids = _parseSpecIds(spec);
        string[] memory retired = _parseRetiredIds(spec);
        InvariantRegistry.Entry[] memory reg = InvariantRegistry.entries();
        assertGt(retired.length, 0, "no retired heading parsed: the tombstone gate ran nothing");
        for (uint256 i = 0; i < reg.length; i++) {
            bool isRetired = _arrayHas(retired, reg[i].id);
            bool isTomb = reg[i].status == InvariantRegistry.Status.TOMBSTONE;
            assertEq(
                isTomb,
                isRetired,
                string.concat(
                    reg[i].id, ": TOMBSTONE status must match a struck-through Retired heading"
                )
            );
        }
        assertEq(InvariantRegistry.get("ACL-4").remediationIssue, 0);
        assertTrue(InvariantRegistry.get("ACL-4").status == InvariantRegistry.Status.TOMBSTONE);
        assertTrue(InvariantRegistry.get("ACL-8").status == InvariantRegistry.Status.TOMBSTONE);
        // Each active heading maps once: no ID is listed twice in the spec or the registry.
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 specCount;
            uint256 regCount;
            for (uint256 j = 0; j < ids.length; j++) {
                if (keccak256(bytes(ids[i])) == keccak256(bytes(ids[j]))) specCount++;
            }
            for (uint256 j = 0; j < reg.length; j++) {
                if (keccak256(bytes(ids[i])) == keccak256(bytes(reg[j].id))) regCount++;
            }
            assertEq(specCount, 1, string.concat(ids[i], " is a heading twice"));
            assertEq(regCount, 1, string.concat(ids[i], " does not map to exactly one entry"));
        }
        // SYS-2: retired non-registry ID.
        assertFalse(_arrayHas(ids, "SYS-2"), "SYS-2 must keep the non-heading form");
        assertFalse(_registryHas(reg, "SYS-2"), "SYS-2 must stay out of the registry");
        // SYS-1 and ACL-9 are registered and have headings.
        assertTrue(_arrayHas(ids, "SYS-1") && _registryHas(reg, "SYS-1"), "SYS-1 not mapped");
        assertTrue(_arrayHas(ids, "ACL-9") && _registryHas(reg, "ACL-9"), "ACL-9 not mapped");
    }

    /// @notice Negative fixture: the retired-heading parser reads the strike-through marker.
    function test_negativeFixture_retiredHeadingParsed() public pure {
        string memory fake = string.concat(
            "> **`ZZZ-1` - ~~old rule~~ Retired 2026-01-01.**\n",
            "> **`ZZZ-2` - an active rule.**\n"
        );
        string[] memory r = _parseRetiredIds(fake);
        assertEq(r.length, 1);
        assertEq(r[0], "ZZZ-1");
    }

    /// @dev IDs whose heading line contains a `~~` strike-through and the word Retired.
    function _parseRetiredIds(string memory spec) internal pure returns (string[] memory out) {
        bytes memory b = bytes(spec);
        bytes memory mark = HEADING;
        string[] memory tmp = new string[](b.length / 8 + 1);
        uint256 n;
        for (uint256 i = 0; i + mark.length <= b.length; i++) {
            if (!_matchesAt(b, mark, i)) continue;
            uint256 s = i + mark.length;
            uint256 j = s;
            while (j < b.length && b[j] != bytes1("`")) j++;
            bytes memory idb = new bytes(j - s);
            for (uint256 k = 0; k < idb.length; k++) {
                idb[k] = b[s + k];
            }
            uint256 e = j;
            while (e < b.length && b[e] != bytes1("\n")) e++;
            bool strike;
            bool word;
            for (uint256 k = j; k + 1 < e; k++) {
                if (b[k] == bytes1("~") && b[k + 1] == bytes1("~")) strike = true;
                if (b[k] == bytes1("R") && _matchesAt(b, bytes("Retired"), k)) word = true;
            }
            if (_isInvariantId(idb) && strike && word) tmp[n++] = string(idb);
            i = e;
        }
        out = new string[](n);
        for (uint256 k = 0; k < n; k++) {
            out[k] = tmp[k];
        }
    }

    // ───────────────────────── negative fixture (Test-plan 2) ─────────────────

    /// @notice Proves the coverage gate actually bites: an ID that exists in a
    ///         (simulated) spec but NOT in the registry must be reported as
    ///         unmapped. We feed the parser a synthetic spec fragment containing a
    ///         never-registered ID and assert the registry does not cover it — the
    ///         exact failure mode test_specAndRegistryAreInBijection would raise.
    function test_negativeFixture_unmappedSpecIdIsDetected() public pure {
        string memory fakeSpec = "> **`ZZZ-99` - a brand-new invariant nobody mapped yet.**\n";
        string[] memory ids = _parseSpecIds(fakeSpec);
        // The parser extracts the new ID...
        assertEq(ids.length, 1, "parser failed to extract the synthetic ID");
        assertEq(ids[0], "ZZZ-99", "parser extracted the wrong ID");
        // ...and the registry does NOT contain it, which is precisely what the
        // real bijection test would flag as a CI failure.
        InvariantRegistry.Entry[] memory reg = InvariantRegistry.entries();
        assertFalse(
            _registryHas(reg, "ZZZ-99"),
            "negative fixture broken: ZZZ-99 must be absent from the registry"
        );
    }

    // ───────────────────────────── parsing helpers ───────────────────────────

    /// @dev Extract every invariant ID that starts a `> **\`ID\`` heading line.
    ///      Scans for the HEADING marker and reads the run of characters up to the
    ///      closing backtick. Returns IDs in document order (no dedup — duplicates
    ///      would be a spec bug the cardinality check then surfaces).
    function _parseSpecIds(string memory spec) internal pure returns (string[] memory ids) {
        bytes memory b = bytes(spec);
        bytes memory mark = HEADING;
        // First pass: count valid invariant-ID headings (skip the `ID` placeholder).
        uint256 count;
        for (uint256 i = 0; i + mark.length <= b.length;) {
            if (_matchesAt(b, mark, i)) {
                uint256 start = i + mark.length;
                uint256 j = start;
                while (j < b.length && b[j] != bytes1("`")) {
                    j++;
                }
                bytes memory idb = new bytes(j - start);
                for (uint256 k = 0; k < idb.length; k++) {
                    idb[k] = b[start + k];
                }
                if (_isInvariantId(idb)) count++;
                i = j;
            } else {
                i++;
            }
        }
        ids = new string[](count);
        uint256 out;
        for (uint256 i = 0; i + mark.length <= b.length;) {
            if (_matchesAt(b, mark, i)) {
                uint256 start = i + mark.length; // first char of the ID
                uint256 j = start;
                while (j < b.length && b[j] != bytes1("`")) {
                    j++;
                }
                bytes memory idb = new bytes(j - start);
                for (uint256 k = 0; k < idb.length; k++) {
                    idb[k] = b[start + k];
                }
                // Only accept real invariant IDs of the shape `LETTERS-DIGITS`
                // (e.g. INV-1, ORA-7). This skips the literal `ID` placeholder in
                // the spec's "How to read an entry" format example, which is the
                // one `> **\`...\`` heading that is not an actual invariant.
                if (_isInvariantId(idb)) {
                    ids[out++] = string(idb);
                }
                i = j; // skip past the parsed ID
            } else {
                i++;
            }
        }
    }

    /// @dev True for IDs of the shape LETTERS "-" DIGITS (e.g. "INV-1", "ORA-7").
    ///      Rejects the spec's literal `ID` placeholder and any other non-ID
    ///      backtick heading.
    function _isInvariantId(bytes memory id) internal pure returns (bool) {
        // Find a hyphen with at least one letter before it and at least one digit
        // (and only digits) after it.
        uint256 dash = type(uint256).max;
        for (uint256 i = 0; i < id.length; i++) {
            if (id[i] == bytes1("-")) {
                dash = i;
                break;
            }
        }
        if (dash == type(uint256).max || dash == 0 || dash + 1 >= id.length) return false;
        // Before the dash: all uppercase letters.
        for (uint256 i = 0; i < dash; i++) {
            if (id[i] < bytes1("A") || id[i] > bytes1("Z")) return false;
        }
        // After the dash: all digits.
        for (uint256 i = dash + 1; i < id.length; i++) {
            if (id[i] < bytes1("0") || id[i] > bytes1("9")) return false;
        }
        return true;
    }

    function _matchesAt(bytes memory hay, bytes memory needle, uint256 at)
        internal
        pure
        returns (bool)
    {
        if (at + needle.length > hay.length) return false;
        for (uint256 k = 0; k < needle.length; k++) {
            if (hay[at + k] != needle[k]) return false;
        }
        return true;
    }

    function _registryHas(InvariantRegistry.Entry[] memory reg, string memory id)
        internal
        pure
        returns (bool)
    {
        bytes32 want = keccak256(bytes(id));
        for (uint256 i = 0; i < reg.length; i++) {
            if (keccak256(bytes(reg[i].id)) == want) return true;
        }
        return false;
    }

    function _arrayHas(string[] memory arr, string memory id) internal pure returns (bool) {
        bytes32 want = keccak256(bytes(id));
        for (uint256 i = 0; i < arr.length; i++) {
            if (keccak256(bytes(arr[i])) == want) return true;
        }
        return false;
    }
}
