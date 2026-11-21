# Deployment, linked code and upgrade authority

The expanded pass traced `verifyFundSystem`, `buildFundVerifySheet`, artifact masking, the legacy recursive library verifier, and role handover assertions. Findings below are false-attestation defects conditional on altered or misconfigured deployed state. They do not establish that an outsider can create that state through the reviewed deployment scripts.

## DEP-02 — P2: linked library code is not attested

At `publish-contracts/src/verify/fund.ts:69-82`, the implementation/proxy check calls `compareDeployedCode`. The comparison masks library-link addresses (`verify/codehash.ts:71-86,119-124`). No subsequent fund-system check reads or verifies the code at those linked addresses. Much of fund and queue business logic runs through linked libraries, so matching the masked implementation does not establish that executed logic matches the release.

A mislinked build or a deployment with altered library links can retain an identical masked implementation while using different linked logic. The normal library deployment path and deploy-time checks reduce the likelihood, but the independent verifier cannot detect this wrong state. The supported implementation-deployment verb already recursively checks library code before reuse and before recording a new candidate (`deploy-implementation.ts:207-215,248-255`; `upgrade-rows.ts:219-239`). The omission here is in independent fund verification, not that guarded upgrade verb. See chapter 08 for the executed counterexample. No such bad live deployment was found.

The existing vaults verifier already handles this case: `verify/upgradeability.ts:246-266` walks links from the deployed implementation, loads each library's code and artifact, and recurses into nested links. The fund verifier bypasses that protection.

**Executed evidence:** the actual `verifyFundSystem` was called with synthetic artifacts and a controlled ChainReader. Changing the linked library's returned code left all 114 checks green, and the verifier never requested that library's code. A wrong TVL cap made the same fixture fail. This proves the missing read/check, not deployability or exploitability of a malicious library on a live chain. The synthetic fixture uses simplified runtime artifacts and does not simulate an EVM proxy upgrade.

**Remedy:** extract deployed link addresses and recursively verify every reachable library against the intended release artifacts, with cycle/duplicate protection. Test an altered leaf library and altered nested library while keeping the implementation's masked bytes unchanged; both must fail verification.

## DEP-03 — P2: timelock role exclusivity is not checked

The verifier claims Safe-only proposer and canceller authority in `verify/fund.ts:1-4`. At lines 87-91 it proves Safe membership and deployer absence for selected roles, but never proves that another address lacks proposer/canceller or default-admin membership. Open executor membership is intentional and is not this finding.

A timelock with the expected Safe plus an additional proposer therefore passes. That address can schedule calls without the Safe, although the configured delay still applies. An extra canceller can obstruct scheduled operations; an extra default admin can change role membership. The healthy Safe/deployer checks do not establish exclusivity.

**Executed evidence:** adding an extra proposer to the synthetic ChainReader's role state left all 114 checks green. The code never queried that holder or reconstructed the full set. This is an assurance gap conditional on an erroneous role grant or altered state, not a demonstrated way for an unprivileged account to grant itself a role. Fresh/reused handover already enforces `proposerCount() == 1` and Safe membership (`CoreTimelockHandover.sol:156-186`). Thus the concrete supported trigger is a later authorized role change, not an extra proposer passing initial handover. Chapter 08 expands the same independent-readback gap to Safe modules/guard/fallback state.

**Remedy:** read `proposerCount() == 1` along with Safe membership, and check the intended Safe module/guard/fallback configuration. For other roles, reconstruct final role membership from grants/revocations over the complete deployment history, or use enumerable role reads where the implementation supports them. Compare exact permitted proposer/canceller/admin sets and fail closed if evidence is incomplete. Include extra-holder negative fixtures; checking only Safe presence is insufficient.

## DEP-01 revalidation

The same fixture returned an unexpected fourth `config()` value (fee recipient) and still passed all checks. A wrong TVL value failed, showing the fixture reaches the configuration comparison. The per-asset omission was confirmed by code search; it was not separately mutated in the synthetic reproduction. The report retains [DEP-01](02-deploy4-verification.md) as a configuration-readback defect.

## Executed existing tests

From `publish-contracts/`:

`bun test tests/fund-system.test.ts tests/evidence-fund.test.ts tests/deploy-implementation.test.ts`

Result: **37 pass, 0 fail, 436 assertions**. These tests passing does not cover the newly reproduced omissions. Frozen package dependencies were installed locally; no tracked dependency file or product source changed.
