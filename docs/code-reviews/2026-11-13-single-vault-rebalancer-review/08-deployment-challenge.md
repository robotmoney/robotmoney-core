# Third pass: deployment findings challenged against the full path

Source remains `176770892`. This pass checked whether the verifier omissions
also exist in the supported deployment and upgrade paths. They do not all do
so. The distinctions below narrow the existing findings; they do not claim a
bad live deployment or an unprivileged route to install one.

## DEP-01: retain the configuration readback finding, bound its trigger

`DeployFund.s.sol:118-131` passes the selected fee recipient to atomic proxy
initialization. Lines 147-158 add each expected asset and assert its returned
index; the venue addresses and basket definitions are constructed by that
script. A normal execution of that reviewed script therefore does not silently
permute the initial asset list merely because the later verifier omits it.

The defect remains in independent readback (`verify/fund.ts:126-135`): a later
authorized configuration change, or incorrectly supplied deployment input,
can leave state inconsistent with the intended sheet while verification stays
green. The verifier does not establish the stronger postcondition its label
advertises. Retain P2; avoid presenting omitted comparisons as proof that the
normal deployment script builds arbitrary configuration.

## DEP-02: retain for fund verification; correct the upgrade-path implication

The fund verifier masks links and does not inspect the reachable library code.
That remains DEP-02. However, the supported `deploy-implementation` verb does
perform recursive attestation:

- A reused implementation calls `runtimeCodeProblems` before reuse
  (`deploy-implementation.ts:207-215`).
- A newly deployed candidate calls it before the deployment entry is recorded
  (`deploy-implementation.ts:248-255`).
- That function recursively follows runtime link references and compares each
  library against its artifact (`upgrade-rows.ts:219-239`).

Thus a claim that this upgrade verb accepts an arbitrary wrong linked library
is unsupported. The initial library deployment also uses CREATE2-derived
library addresses (`DeployFundLibs.s.sol:29-36`), which is a material control
against casual substitution. Retain the independent fund-verifier finding,
with the supported candidate-deployment guard stated explicitly. A raw
Safe-authorized upgrade remains a different path from the guarded verb.

**Executed counterexample to an overbroad claim:** a small synthetic-artifact
probe called the real `runtimeCodeProblems` with a matching implementation
and one linked library. Matching leaf bytes returned `[]`; changing that leaf
from `0x600000` to `0x600100` returned a `linked Lib ... masked hash` error.
Both assertions passed. The probe is under
`$HOME/tmp/fund-review-third/library-control.ts`; it demonstrates the existing
recursive guard and does not execute an EVM deployment. No full suite was
rerun for this chapter.

## DEP-03: narrow fresh-deployment claims and broaden authority readback

The fresh or reused timelock deployment already requires
`proposerCount() == 1` and Safe proposer membership
(`CoreTimelockHandover.sol:156-186`). An extra proposer at this stage prevents
handover. The constructor-bound CREATE2 address also constrains which
implementation can occupy that predicted address. The previous generic
reference to deploy-time grants understated this protection.

A supported later sequence still demonstrates the verifier gap: the Safe
schedules a timelock self-call to `grantRole(PROPOSER_ROLE, other)`, waits the
delay, and executes it. `ProposerFloorTimelock.sol:16-25` expressly permits
adding a second proposer; its floor prevents removing the last proposer, not
adding another. After that authorized role change, `verify/fund.ts:87-91`
still proves only Safe presence and selected deployer absences. It incorrectly
continues to attest the stated Safe-only configuration. The extra proposer
must still respect the timelock delay. No account can obtain that role
unilaterally through this sequence.

The exact proposer-set fix can be simpler than reconstructing all events:
read `proposerCount() == 1` in addition to Safe membership. Canceller/admin
exclusivity still needs complete membership evidence or another appropriate
contract interface.

The same authority-readback gap also covers Safe configuration. Deployment
checks no enabled module, zero guard and the canonical fallback handler
(`CoreTimelockHandover.sol:139-148`); the fund verifier later checks only owners
and threshold (`verify/fund.ts:92-93`). If owners subsequently enable a module,
a module can submit Safe transactions through the Safe's module execution
path while the listed owners and threshold remain identical. The timelock
still sees the Safe as proposer. A guard can instead prevent transactions.
This is an authorized configuration-drift case and a missing check of the
originally required authority configuration, not a discovered way to enable
a module without authorization. Fold it into DEP-03 rather than counting it
as another independent attack. Retain P2 for false authority assurance.

## Upgrade and storage attacks checked without a new confirmed finding

A caller trying to upgrade or freeze through the implementation directly is
rejected by the active-proxy check (`GovernedUUPS.sol:241-244`). Through the
proxy, `GovernedUpgrade._authorize` requires the fixed upgrade timelock and
an unfrozen state (`GovernedUUPS.sol:167-171`). Initialization cannot replace
a previously set authority (`:89-92`). Freeze binds both the implementation
address and code hash (`:137-150`); an intervening different implementation
makes a queued freeze fail rather than silently freezing another target.

The fund candidate path checks the frozen state, append-only base layout,
and a separate V2 layout when selected (`deploy-implementation.ts:191-204`).
The reviewed `RebalancerV2` adds only a marker getter and no state
(`contracts/test/helpers/FundUpgradeV2.sol:8-23`). The helper compares storage,
struct and namespace prefixes and rejects removed linked libraries
(`upgrade-rows.ts:171-185`). These are meaningful defenses, although checked-in
layout snapshots still rely on the build/CI process to remain faithful to
compiled code. This static pass did not establish a stale-snapshot acceptance
on the supported release path and does not index that suspicion as a finding.

This chapter adds counterarguments and authority-readback coverage while
retaining DEP-01, DEP-02 and DEP-03 as bounded verification findings.
