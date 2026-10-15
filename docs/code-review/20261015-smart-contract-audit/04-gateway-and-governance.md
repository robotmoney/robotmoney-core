# Gateway and governance

## 5. Gateway, agents, committee, and signatures

- Bind all claimed identities to `msg.sender` or verified signatures. Review registration, consent/reveal, authorization ownership, role separation, caller-supplied recipients, and policy changes.
- Check operation identifiers and replay protection across direct vault and router routes, operation-kind domains, deadlines, idempotency, cancellation, and rolling-window caps at reset boundaries.
- Review CEI and reentrancy around token transfer, share mint/burn, external calls, and gateway state. Check rollback behavior on downstream failure.
- Verify committee signal attribution, freshness, latest-vote semantics, membership, aggregation, and whether any signal can reach an authoritative governance or allocation path. Confirm retired voting surfaces are absent and receipt-based replacements enforce the intended authority.
## 6. Roles, emergency powers, governance, and timelocks

- Build a role matrix from constructors, initializers, deployment scripts, grants, revocations, and live holders. Check admin floors, role-admin relationships, accidental self-escalation, and handover completion.
- Review pause/unpause, shutdown, force removal, loss write-off, sweep/rescue, caps, fees, adapter configuration, router weights, policy changes, upgrades, and freeze powers. Evaluate each action's delay, proposer/canceller/executor roles, batching, and possible call ordering.
- Verify emergency actions preserve user exits where required and do not silently reprice recoverable assets. Resolve the intended authority boundary for writing off healthy or illiquid positions and attribute later recoveries.
- Check quorum/voting units, snapshots, threshold and delay bounds, one-voter control, proposal replay, receipt release/application semantics, and all alternate governance paths.
- Examine `ProposerFloorTimelock`, Safe module/threshold assumptions, proposer and canceller loss, open executor behavior, and emergency-key compromise or loss through the entire schedule-to-execute lifecycle.
- Exercise operational recovery procedures through the actual Safe/timelock topology where possible; do not infer deployed safety from role names or example sheets.
