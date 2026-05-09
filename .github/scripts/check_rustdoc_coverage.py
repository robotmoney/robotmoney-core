#!/usr/bin/env python3
"""Parse cargo doc output and report documentation coverage issues.

Reads rustdoc.log (captured from cargo doc --no-deps --all-features) and:
- Counts broken intra-doc links (unresolved cross-references in docstrings)
- Counts missing-documentation warnings (requires #[warn(missing_docs)])
- Exits non-zero only if missing-documentation warnings exceed the threshold.

Broken intra-doc links are reported as informational — they exist in pre-existing
code and are a separate cleanup task from coverage enforcement.
"""

import re
import sys

MISSING_DOCS_THRESHOLD = 0  # fail if any pub items lack docs (once #[warn(missing_docs)] is on)


def main():
    if len(sys.argv) < 2:
        print("usage: check_rustdoc_coverage.py <rustdoc.log>", file=sys.stderr)
        sys.exit(1)

    log_path = sys.argv[1]
    with open(log_path) as f:
        lines = f.readlines()

    broken_links = []
    missing_docs = []

    for line in lines:
        stripped = line.strip()
        if re.search(r"warning:.*unresolved link to", stripped):
            broken_links.append(stripped)
        elif re.search(r"warning: missing documentation for", stripped):
            missing_docs.append(stripped)

    if broken_links:
        print(f"[rustdoc] {len(broken_links)} broken intra-doc link(s) (informational):")
        for item in broken_links:
            print(f"  {item}")

    if missing_docs:
        print(f"[rustdoc] {len(missing_docs)} missing-documentation warning(s):")
        for item in missing_docs:
            print(f"  {item}")
    else:
        print("[rustdoc] no missing-documentation warnings")

    if len(missing_docs) > MISSING_DOCS_THRESHOLD:
        print(f"[rustdoc] FAIL: {len(missing_docs)} missing-docs warnings exceed threshold {MISSING_DOCS_THRESHOLD}")
        sys.exit(1)

    print("[rustdoc] coverage check passed")


if __name__ == "__main__":
    main()
