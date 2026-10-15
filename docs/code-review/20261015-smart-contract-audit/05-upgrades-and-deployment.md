# Upgrades and deployment

## 7. Upgradeability, initialization, and storage safety

- Inventory every proxy, implementation, beacon or linked library and its upgrade/freeze authority. Verify initializer protection, reinitializers, implementation locking, proxy admin paths, and deploy-time ownership handoff.
- Compare storage layouts against the pinned deployed baseline, including inheritance, packing, mappings, structs, enums, and linked-library storage assumptions. Ensure the comparison cannot be rewritten by the change under review.
- Check upgrade authorization, build provenance, implementation code identity, atomic initialization, rollback/failure behavior, post-upgrade readback, and irreversible freeze semantics.
- Verify CREATE2/address derivation, initializer front-running, UUPS compatibility and upgrade entrypoints, implementation self-locking, and that the reviewed source plus pinned compiler settings reproduce the deployed implementation bytecode. Check the compiler version against its published known-bugs list.
- Verify proxy implementation pins and code-hash checks cover the logic users actually call, are checked at the relevant transaction boundary, and have a safe rotation/retirement process.
- Inspect migrations and reinitializers for lost roles, changed accounting, stale external references, unbounded work, and compatibility with existing positions and claims.
## 8. Tokens, external calls, and Solidity-specific hazards

- Check safe token transfers, fee-on-transfer/rebasing assumptions, approval lifecycle, non-standard return values, decimals, zero-address handling, and native-token paths if present.
- Review reentrancy, checks-effects-interactions, callbacks, delegatecall/library boundaries, `tx.origin`, `block.timestamp`/block-number assumptions, signatures and domain separators, unchecked arithmetic/casts, array indexing, and denial-of-service through loops or revert propagation.
- Check chain-ID/domain separation and cross-chain replay; signature malleability or encoding collisions where signatures are used; block-builder ordering and forced token/native-asset transfers; private-state or randomness assumptions if any feature relies on them.
- Bound gas and storage growth for user exits, emergency recovery, oracle observation, exclusions, adapter and asset arrays, and governance operations at realistic maximum history sizes. Establish a workable recovery path when an external dependency reverts or runs out of gas.
- Check events against state transitions and ensure emitted values identify actual assets, recipients, agents, vaults, and amounts. Confirm off-chain consumers cannot confuse direct and routed actions or infer authority from untrusted fields.
- Review compiler version, optimizer/via-IR settings, dependencies, known inherited behavior, and any assembly or custom storage code.
## 9. Deployment truth, invariants, and residual risk

- Compare production source, deployment scripts, stage sheets, manifests, addresses, roles, caps, oracle configuration, and runbooks. Identify any difference that changes a security conclusion.
- Verify production bytecode and configuration against the reviewed commit or build manifest on every target chain. If live deployment inspection is not possible, identify the exact checks required before a release decision.
- Reconcile prior audit/review dispositions with current code and tests. Keep historical findings as immutable baseline evidence; record current status, evidence, and any remaining assumptions separately.
- State what was not reviewed, what could not be reproduced, external protocol assumptions, live-chain checks not performed, and residual risks accepted by the owner.
