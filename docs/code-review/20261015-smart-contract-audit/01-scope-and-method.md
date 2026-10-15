# Scope and method

## Review target and scope

- Pin the exact repository, branch, commit, dirty-tree state, compiler versions, optimizer settings, linked libraries, and deployment configurations before reviewing.
- Review Solidity contracts, linked libraries, deployment and upgrade scripts, storage-layout artifacts, and contract-facing configuration needed to establish deployed behavior. Trace important calls into adapters, clients, indexers, and release tooling when they affect an on-chain invariant or authority boundary; record those seams without expanding into a general off-chain review.
- Enumerate every production contract and proxy in the target release, including vaults, basket vaults, router, gateway, registry, policies, receipt/governance contracts, adapters, oracles, tokens, timelocks, and emergency controls. Confirm which components are deployed, retired, planned, or test-only.
- Inventory every public/external entrypoint, fallback/receive path, privileged setter, external call, and linked library. Map how assets and authority can flow across contracts, including direct calls that bypass the expected client or gateway.
- List chains, addresses, implementations, roles, caps, fee/slippage settings, oracle and keeper parameters, and deployment assumptions. Separate source-level conclusions from live-chain verification.
- Treat third-party protocol internals as out of scope unless a specific integration assumption is necessary to establish a finding; state that assumption and its evidence.
## Threat model and review method

- Identify assets and claims: USDC and other underlying tokens, vault shares, adapter positions, basket assets, exclusion-recovery claims, receipts, and any signed or replay-protected operation.
- Map trusted and less-trusted actors: depositor, share owner, agent, committee member, keeper, ADMIN, EMERGENCY, Safe, proposer/canceller/executor, relayer, upgrade authority, oracle/recorder, and external venue. Record role grants and actual deployment holders separately from intended policy.
- For each boundary, trace caller identity, authorization, calldata and signatures, state transitions, external calls, token movement, emitted events, and failure behavior. Challenge assumptions about atomicity, ordering, freshness, and who can compose calls.
- Perform a manual function-by-function pass over in-scope production code and a focused review of every change since the last reviewed commit. Use static tools to generate candidates and coverage leads, then verify their claims in source and reachable execution paths.
- Turn `docs/prd.md` §12, `docs/architecture.md` §8, `docs/technical/security-model.md`, and every stable ID in `docs/technical/smart-contract-invariants.md` into a traceability matrix: invariant, implementing code, test or proof, counterexample attempted, and remaining gap. Include negative invariants and the actual custody and governance boundaries.
- Use adversarial scenarios and minimized Foundry reproductions for material claims. Include negative tests for fixes and meaningful stateful/fuzz tests for accounting, share supply, role changes, and boundary conditions. Distinguish source inspection, local reproduction, fork evidence, and live deployment evidence.
- Attempt to refute every candidate: establish prerequisites, attacker capability, impact, reachability through deployed entrypoints, mitigations, and whether an administrator action is required. Assign severity only after this analysis; deduplicate by root cause while preserving cross-contract impact.
- Run the repository-required build, tests, static analysis, storage-layout checks, and deployment/config validation. Record exact commands and results, skipped checks, failures, and environmental limits. Inspect `vm.skip`, expected-failure labels, vacuous assertions, narrow selectors, and missing harness actions before crediting formal or invariant coverage. Passing regression tests do not alone establish that a finding is fixed.
