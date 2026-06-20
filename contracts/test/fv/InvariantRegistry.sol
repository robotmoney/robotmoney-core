// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (textual source of truth
//            for every invariant ID + its FV strategy)
//            docs/code-review/external-audit-verification-20260619.md (finding
//            register; every 🔴 invariant links to the finding that violates it)
//
// FORMAL-VERIFICATION REGISTRY (issue #964 — contract-security-remediation-2 scout)
// ───────────────────────────────────────────────────────────────────────────────
// This is the *executable* mirror of the invariants spec. Every invariant ID in
// docs/technical/smart-contract-invariants.md appears here exactly once, tagged
// with:
//
//   - status:    HOLDS (the spec marks it ✅/🟢/🟡/⚪ — has, or will get, a passing
//                test) or RED (the spec marks it 🔴 — currently breakable; the FV
//                test for it is skipped/expected-fail until the linked remediation
//                issue lands).
//   - strategy:  the declared FV strategy (informational; mirrors the spec).
//   - remediationIssue: for RED entries, the contract-security-remediation-2
//                downstream issue (#965–#971) whose fix must flip the entry green.
//                Zero for HOLDS entries.
//
// Two tests consume this registry:
//   - CoverageMap.t.sol asserts a 1:1 mapping between the IDs parsed out of the
//     spec markdown and the IDs declared here (CI fails if any spec ID is
//     unmapped, or any registry ID is absent from the spec).
//   - FvInvariants.t.sol drives one named test per ID; RED entries `vm.skip` with
//     a reason that names their remediationIssue, so the suite is green today and
//     each remediation issue knows exactly which test it must un-skip.
//
// MAINTENANCE: append-only, mirroring the spec's stable-ID discipline. When a
// remediation lands and the spec flips an ID 🔴 → ✅, change that entry's status
// here from RED to HOLDS and zero its remediationIssue in the same PR.
pragma solidity ^0.8.24;

library InvariantRegistry {
    enum Status {
        HOLDS, // spec ✅/🟢/🟡/⚪ — a passing (or trivially-passing) FV test exists
        RED // spec 🔴 — currently breakable; FV test skipped until remediation lands
    }

    struct Entry {
        string id; // stable invariant ID, e.g. "INV-1"
        Status status; // HOLDS or RED
        string strategy; // declared FV strategy (mirrors the spec)
        uint256 remediationIssue; // downstream remediation issue for RED entries; 0 otherwise
    }

    /// @dev The full catalogue. Order mirrors the spec's section order. NEVER
    ///      reorder-and-renumber; append-only like the spec's IDs.
    function entries() internal pure returns (Entry[] memory e) {
        e = new Entry[](57);
        uint256 i;

        // ── 1. Custody & solvency (INV-1/2/3, CUST) ──────────────────────────
        e[i++] = Entry("INV-1", Status.HOLDS, "static-guard", 0);
        e[i++] = Entry("INV-2", Status.HOLDS, "stateful-invariant", 0);
        e[i++] = Entry("INV-3", Status.HOLDS, "deploy-assertion", 0);
        e[i++] = Entry("CUST-4", Status.HOLDS, "stateful-invariant", 0);
        e[i++] = Entry("CUST-5", Status.HOLDS, "fuzz", 0);
        e[i++] = Entry("CUST-6", Status.HOLDS, "stateful-invariant", 0);

        // ── 2. Share & supply accounting (SUP) ───────────────────────────────
        e[i++] = Entry("SUP-1", Status.HOLDS, "stateful-invariant", 0);
        e[i++] = Entry("SUP-2", Status.HOLDS, "symbolic", 0);
        e[i++] = Entry("SUP-3", Status.RED, "fuzz", 969); // NC-6 / F-16
        e[i++] = Entry("SUP-4", Status.HOLDS, "symbolic", 0);
        e[i++] = Entry("SUP-5", Status.HOLDS, "stateful-invariant", 0); // NC-1 fixed (#966)
        e[i++] = Entry("SUP-6", Status.HOLDS, "static-guard", 0);

        // ── 3. Oracle & pricing (ORA) ────────────────────────────────────────
        e[i++] = Entry("ORA-1", Status.HOLDS, "static-guard", 0);
        e[i++] = Entry("ORA-2", Status.HOLDS, "stateful-invariant", 0);
        e[i++] = Entry("ORA-3", Status.HOLDS, "deploy-assertion", 0); // F-09 fixed (#966)
        e[i++] = Entry("ORA-4", Status.HOLDS, "stateful-invariant", 0); // ⚪ aspirational
        e[i++] = Entry("ORA-5", Status.HOLDS, "fuzz", 0);
        e[i++] = Entry("ORA-6", Status.HOLDS, "deploy-assertion", 0); // 🟡 trusted
        e[i++] = Entry("ORA-7", Status.HOLDS, "fuzz", 0); // F-09/F-11/F-16 — independent floor (#966)

        // ── 4. Access control & roles (ACL) ──────────────────────────────────
        e[i++] = Entry("ACL-1", Status.HOLDS, "deploy-assertion", 0); // F-01 remediated (#965)
        e[i++] = Entry("ACL-2", Status.HOLDS, "symbolic", 0);
        e[i++] = Entry("ACL-3", Status.HOLDS, "symbolic", 0); // F-06 fixed (#966)
        e[i++] = Entry("ACL-4", Status.HOLDS, "symbolic", 0);
        e[i++] = Entry("ACL-5", Status.HOLDS, "static-guard", 0); // F-08 fixed (#966)
        e[i++] = Entry("ACL-6", Status.HOLDS, "stateful-invariant", 0);
        e[i++] = Entry("ACL-7", Status.RED, "deploy-assertion", 970); // NC-10

        // ── 5. Lifecycle & state machine (LIFE) ──────────────────────────────
        e[i++] = Entry("LIFE-1", Status.HOLDS, "stateful-invariant", 0); // F-04 fixed (#968)
        e[i++] = Entry("LIFE-2", Status.HOLDS, "static-guard", 0);
        e[i++] = Entry("LIFE-3", Status.HOLDS, "stateful-invariant", 0); // F-06/NC-3 fixed (#966)
        e[i++] = Entry("LIFE-4", Status.HOLDS, "symbolic", 0); // F-06 + NC-3 fixed (#966)
        e[i++] = Entry("LIFE-5", Status.RED, "stateful-invariant", 967); // F-03
        e[i++] = Entry("LIFE-6", Status.RED, "fuzz", 970); // NC-8

        // ── 6. Router / portfolio (RTR) ──────────────────────────────────────
        e[i++] = Entry("RTR-1", Status.HOLDS, "stateful-invariant", 0);
        e[i++] = Entry("RTR-2", Status.RED, "stateful-invariant", 967); // F-03
        e[i++] = Entry("RTR-3", Status.RED, "symbolic", 967); // NC-5
        e[i++] = Entry("RTR-4", Status.HOLDS, "symbolic", 0); // F-05 fixed (#968)
        e[i++] = Entry("RTR-5", Status.HOLDS, "fuzz", 0); // F-13 / NC-4 fixed (#968)
        e[i++] = Entry("RTR-6", Status.RED, "fuzz", 971); // F-12

        // ── 7. Gateway / agent / idempotency (GW) ────────────────────────────
        e[i++] = Entry("GW-1", Status.HOLDS, "stateful-invariant", 0);
        e[i++] = Entry("GW-2", Status.RED, "symbolic", 970); // NC-9 / F-15
        e[i++] = Entry("GW-3", Status.HOLDS, "stateful-invariant", 0);
        e[i++] = Entry("GW-4", Status.HOLDS, "stateful-invariant", 0); // 🟡 partial
        e[i++] = Entry("GW-5", Status.RED, "static-guard", 969); // F-11
        e[i++] = Entry("GW-6", Status.HOLDS, "symbolic", 0);

        // ── 8. Governance / timelock (GOV) ───────────────────────────────────
        e[i++] = Entry("GOV-1", Status.HOLDS, "deploy-assertion", 0);
        e[i++] = Entry("GOV-2", Status.HOLDS, "symbolic", 0);
        e[i++] = Entry("GOV-3", Status.HOLDS, "stateful-invariant", 0);
        e[i++] = Entry("GOV-4", Status.HOLDS, "symbolic", 0); // F-05 / RTR-4 fixed (#968)
        e[i++] = Entry("GOV-5", Status.HOLDS, "static-guard", 0); // 🟡 trusted / operational

        // ── 9. Adapters (ADP) ────────────────────────────────────────────────
        e[i++] = Entry("ADP-1", Status.HOLDS, "static-guard", 0);
        e[i++] = Entry("ADP-2", Status.HOLDS, "static-guard", 0); // NC-2 fixed (#966); F-14 residual
        e[i++] = Entry("ADP-3", Status.HOLDS, "stateful-invariant", 0);
        e[i++] = Entry("ADP-4", Status.HOLDS, "static-guard", 0);
        e[i++] = Entry("ADP-5", Status.HOLDS, "static-guard", 0); // 🟡 partial

        // ── 10. Fees (FEE) ───────────────────────────────────────────────────
        e[i++] = Entry("FEE-1", Status.HOLDS, "fuzz", 0);
        e[i++] = Entry("FEE-2", Status.RED, "fuzz", 971); // NC-11
        e[i++] = Entry("FEE-3", Status.HOLDS, "static-guard", 0);

        require(i == e.length, "InvariantRegistry: length mismatch");
    }

    /// @dev Look up a single entry by ID; reverts if absent.
    function get(string memory id) internal pure returns (Entry memory) {
        Entry[] memory e = entries();
        bytes32 want = keccak256(bytes(id));
        for (uint256 k = 0; k < e.length; k++) {
            if (keccak256(bytes(e[k].id)) == want) return e[k];
        }
        revert(string.concat("InvariantRegistry: unknown id ", id));
    }
}
