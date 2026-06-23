// Source-grep guard for issue #1036 (AC §3): no unguarded `leg.vault` member
// access may remain in RouterDepositTab.tsx. The original crash was
// `leg.vault.toLowerCase()` (no optional chaining) in the vaultListChanged check
// — when a preview leg's `vault` was undefined in the live router-deposit path
// the component threw and the deposit UI never settled (e2e 300s timeout).
//
// This static assertion fails if any future edit reintroduces a non-optional
// `leg.vault.<member>` access in the component, so the crash cannot recur there.
// Runs in the vitest `node` project (filesystem access).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../../src/components/RouterDepositTab.tsx", import.meta.url));

describe("RouterDepositTab — no unguarded leg.vault access (issue #1036)", () => {
  const src = readFileSync(SOURCE, "utf8");

  it("contains no unguarded `leg.vault.toLowerCase()` call", () => {
    // The dot before toLowerCase must not follow `leg.vault` directly — only
    // `leg.vault?.toLowerCase()` (optional chaining) is permitted.
    expect(src).not.toMatch(/leg\.vault\.toLowerCase/);
  });

  it("contains no unguarded `leg.vault.<member>` access at all", () => {
    // Any `leg.vault.` (non-optional) member access is forbidden; matches like
    // `leg.vault?.x` and bare `leg.vault` (no trailing member) are allowed.
    expect(src).not.toMatch(/leg\.vault\.[A-Za-z_]/);
  });
});
