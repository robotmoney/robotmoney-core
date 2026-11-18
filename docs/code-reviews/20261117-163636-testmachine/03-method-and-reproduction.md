# Method and reproduction evidence

## Scope and setup

- Reviewed source: `d4a43e6d21efed208816698d2b32f0decea45451` (the `release-0.9.0` review pin; the branch later advanced to `da7594306` with fund upgrade-library tooling changes only).
- Verification branch: `audit/reproduce-findings-0.9.0`, worktree
  `~/tmp/superfield-worktrees/robotmoney-core/audit-repro-findings-090`.
- Principal checkout (`dev`) was left clean and untouched.
- Submodules initialised and `forge build` completed; `forge` 1.8.3, solc 0.8.24.
- No production source modified — analysis only. The raw scan snapshot is
  [05-raw-scan.md](05-raw-scan.md); the canonical summary is
  [docs/code-review/20261117-review-testmachine-verification.md](../../code-review/20261117-review-testmachine-verification.md).

## Method

1. Read every cited contract at this commit and confirm the quoted snippet exists
   (audit line numbers drift by a few lines due to library extraction).
2. Trace the complete call path, including internal helpers, access control,
   `nonReentrant`, delegatecall context, and try/catch scope.
3. Check NatSpec, `docs/`, config, and deploy tooling for the intended behaviour
   and for any prior acceptance of the same issue.
4. Check existing tests — especially `SecurityReview*.t.sol` — for an in-repo PoC
   that pins or refutes the behaviour.
5. Grade each finding REJECTED / REPRODUCED / PARTIAL with concrete `file:line`
   evidence, and a short exploit sketch where reproduced.

Two refutations required special care:
- **#23** hinges on Solidity `try/catch` semantics: a revert inside the success
  block is *not* caught. The repo's own test pins the opposite outcome to the claim.
- **#21** hinges on the difference between the onboarding cardinality guard (901
  slots) and the deployed recorder ring (7,201 slots) — the audit conflates them.

## Executed tests (all passing)

```
forge test --match-test \
  'test_AZ_BSK5_reabsorbRemovedAsset_revertsSlippageExceeded|\
test_applyReceipt_sameRecordedAtRefused|\
test_assessment_transientTickPersistsForFullWindowWithoutHonestRecord|\
test_LIFE6_reabsorbSurvivesDegradedPool|\
test_illiquidAdapterEmergencyDrainKeepsExitersAndStayersAtParity|\
test_sellAnchor_youngRecorderUsesItsWholeHistory' -vv
```

Result: 9 tests across 8 suites, 0 failed, 0 skipped. These directly cover:

| Test | Finding | Effect |
| --- | --- | --- |
| `BasketVault.t.sol::test_AZ_BSK5_reabsorbRemovedAsset_revertsSlippageExceeded` | #23 | refutes quarantine-on-floor claim |
| `BasketVault.t.sol::test_LIFE6_reabsorbSurvivesDegradedPool` | #1 | pins degraded-oracle fallback |
| `SecurityReviewRevisionAssessment.t.sol::test_assessment_transientTickPersistsForFullWindowWithoutHonestRecord` | #19 | pins transient-tick mechanic |
| `RobotMoneyVault.t.sol::test_illiquidAdapterEmergencyDrainKeepsExitersAndStayersAtParity` (same test also executed through the `SecurityReviewPoc.t.sol` and `SecurityReviewRecheckVaultPoc.t.sol` suites) | #6 | pins Morpho/illiquid-adapter redemption failure |
| `RouterGovernanceApplyReceipt.t.sol::test_applyReceipt_sameRecordedAtRefused` | #17 | pins same-block receipt refusal |
| `RecorderSellAnchor.t.sol::test_sellAnchor_youngRecorderUsesItsWholeHistory` | #21 | refutes shortened-anchor premise |

## Limitations

- Upstream MetaMorpho, Aave, and Compound sources are not vendored in `lib/`, so
  the liquidity premises in #6, #9, and #10 rest on protocol knowledge, corroborated
  by the repo's own prototype adapter comments. The on-chain behaviour of this
  repo's adapters (the subject of the findings) was verified directly.
- Several reproduced findings are already accepted upstream (#12, #15, #18, #19);
  they are recorded as reproduced because the behaviour is real, not because it is
  a new, unmitigated risk.
- No new PoC test file was added; the verification relies on the repository's own
  tests plus direct source tracing.
