# ADR — OpenClaw E2E Demo Runbook: fork choice, agent task scope, artifact set, failure toggles

> Scope: dev-scout decision record for Phase 7 (OpenClaw E2E Demo on a Recent Public-Chain Fork) of `docs/implementation-plan.md` §13. Resolves the four operational choices that gate the demo: which recent fork to use and how its block is pinned, the bounded OpenClaw task definition (verbatim prompt + success criteria), the exact captured-artifact set and how each artifact is captured, and the per-failure-case toggle commands for the five named failure cases (unauthorized agent, insufficient allowance, paused gateway, fee cap, code-hash mismatch).
>
> Closes the open question gate in `docs/implementation-plan.md` §13. **No demo execution and no artifact capture happens here** — that is the demo impl issue (#61). This ADR is a deterministic script the impl issue can run.

---

## 1. Status

Accepted. Authored 2026-05-07 against `docs/implementation-plan.md` (commit on branch `feat/62-dev-scout-demo-runbook-fork-choice-agent-task-sc`). No prior ADR exists for Phase 7. This ADR depends on, and reuses operational primitives from, `docs/technical/fork-e2e-decisions.md` (Phase 2 — fork target, pinning, isolation) and `docs/walkthroughs/openclaw-config.md` (Phase 4 — OpenClaw harness install + long-running task config). Where Phase 7 needs the same primitive, this ADR cites the source rather than re-deciding.

## 2. Context

`docs/implementation-plan.md` §13 prescribes an end-to-end demo run of OpenClaw plus `rmpc` against a forked Ethereum-compatible chain. The §13 prose names the goal, the high-level setup, the required behaviors, the artifacts list, and the five failure cases — but it deliberately leaves four operational details unresolved:

1. **Fork choice + block pin.** §13 says "a recent fork" and "pinned block metadata recorded" without specifying chain, RPC backend, or how the pin is captured.
2. **Bounded agent task definition.** §13 quotes a one-sentence example task ("Monitor vault status, verify the agent is authorized, deposit a capped amount of USDC when safe, then report tx hash and resulting position.") but does not commit to a verbatim prompt, success criteria, timeout, or stop conditions.
3. **Artifact set shape.** §13 lists six artifact names (runbook, fork config, OpenClaw config, skill package, command trace + JSON outputs, final report) but does not say what file path each one writes to, what format it has, or which command captures it.
4. **Five failure cases — toggle commands.** §13 names the five failure conditions (unauthorized agent, insufficient allowance, paused gateway, fee cap, code-hash mismatch) but gives no commands to toggle each one in isolation.

A binding constraint already lives in user memory and applies across the project: **no fast-feedback optimization**. The project trades demo-iteration speed for realism. Every decision below is anchored to that constraint plus the §13 acceptance criteria (reproducible from clean checkout, no explorer/dapp dependency, each failure case demonstrable by toggling one condition at a time).

## 3. Decisions

### 3.1 Fork pin — **Base mainnet (chain id 8453), pinned via `RMPC_FORK_BLOCK` per the Phase 2 ADR**

- **Decision:** the demo runs against the same Base-mainnet fork target chosen for Phase 2 forked smart-contract E2E (`docs/technical/fork-e2e-decisions.md` §3.1). RPC URL is consumed from `RMPC_FORK_RPC_URL`. Block pin is captured in `RMPC_FORK_BLOCK` (decimal block number) and recorded in the `final-report.json` artifact (§3.3) on every demo run.
- **Pin capture mechanism:** the demo orchestrator script (the impl issue, not this ADR) reads `eth_blockNumber` from the RPC at start of run, subtracts a 100-block reorg-safety lag (matches the Phase 2 ADR's "at least 100 blocks behind tip"), and writes the resulting integer to both the env (`RMPC_FORK_BLOCK`) and to the artifact set as `fork-config.json:fork_block`. This is the same pattern Phase 2 uses for its CI fork pin; the Phase 7 demo just captures rather than commits the value.
- **Fork backend:** `anvil --fork-url $RMPC_FORK_RPC_URL --fork-block-number $RMPC_FORK_BLOCK`. This matches Phase 2 ADR §3.6: Anvil-as-fork-backend, not Anvil-as-flavor. Anvil is the only backend that simultaneously supports fork-block pinning, account impersonation (needed for §3.5 funding), and on-the-fly state mutations (needed for §3.4 failure toggles).
- **Constraint cited:** §13 acceptance criterion "demo can be reproduced from a clean checkout with documented prerequisites" plus the no-fast-feedback constraint (we accept the cost of a real archive RPC call rather than caching state locally).
- **Rejected alternatives:**
  - *Different chain.* Robot Money has no non-Base deployment (`docs/technical/smart-contracts.md` §2). Rejected for the same reason as Phase 2 ADR §3.1.
  - *Hardhat fork backend.* No advantage over Anvil for this use; Phase 2 has standardized on Anvil; introducing a second fork backend doubles the operational surface.
  - *Hard-coded block number in this ADR.* The demo is a moving target; pinning a single block in the ADR would force ADR edits at every refresh. Capture-at-run with the value recorded in the artifact set is the smaller change.

### 3.2 Bounded agent task — **verbatim OpenClaw prompt + locked success criteria + 10-minute hard timeout**

- **Verbatim prompt** (this is the canonical text; the demo orchestrator must pass it byte-for-byte to OpenClaw):

  ```
  You are running on a Base-mainnet fork as an authorized Robot Money
  agent. Your task is bounded and read-then-write:

  1. Read vault state via rmpc get-vault and report the current
     totalAssets and paused flag.
  2. Read your own agent authorization via rmpc get-agent --agent
     $AGENT_ADDRESS. If not authorized, stop and produce a refusal
     report; do not attempt a deposit.
  3. Read your forked-USDC balance and gateway allowance via
     rmpc get-balance and rmpc get-allowance. If the balance is below
     $DEPOSIT_AMOUNT or the allowance is below $DEPOSIT_AMOUNT, stop
     and produce a refusal report.
  4. Run rmpc self-check. If it fails, stop and produce a refusal
     report.
  5. If and only if all reads above pass, call rmpc deposit
     --amount $DEPOSIT_AMOUNT --order-id $ORDER_ID --fee-cap $FEE_CAP_WEI.
     Capture the returned tx hash and deposit id.
  6. Wait for the tx to mine, then call rmpc get-deposit --deposit-id <id>
     and rmpc get-tx --tx-hash <hash> and rmpc get-vault one more time.
  7. Produce a final report (final-report.json) with: agent address,
     pinned block, vault totalAssets before and after, deposit id,
     tx hash, gas used, and a one-line outcome ("deposited" or
     "refused: <reason>").

  Rules:
  - Never use any explorer API. All reads go through rmpc get-* against
    the fork RPC.
  - Never call rmpc deposit unless steps 1-4 all passed.
  - If any step fails, stop the loop and emit the refusal report.
    Do not retry, do not escalate, do not call any other tool.
  - You must complete or refuse within 10 minutes wall-clock; the
    harness will SIGTERM at that point.
  ```

- **Locked success criteria** (the demo orchestrator script asserts each of these against the captured artifact set):
  1. OpenClaw exited with status 0 within the 10-minute hard timeout.
  2. The command trace (`command-trace.jsonl`) contains, in order, at least one each of: `rmpc get-vault`, `rmpc get-agent`, `rmpc get-balance`, `rmpc get-allowance`, `rmpc self-check`. (Exact ordering enforced for the read prefix; subsequent ordering is free.)
  3. Either: (a) `rmpc deposit` is present in the trace AND the resulting tx hash appears in `final-report.json:tx_hash` AND the on-chain `totalAssets` increased by `$DEPOSIT_AMOUNT` (modulo gas fees within `$FEE_CAP_WEI`), OR (b) `rmpc deposit` is absent from the trace AND `final-report.json:outcome` starts with `refused:`.
  4. No `rmpc` invocation references the explorer API, the dapp, or any non-RPC URL.
- **Constraint cited:** §13 required behaviors 1–6 (skill loading, direct chain reads, refusal handling, guarded deposit, state capture, long-running completion) and acceptance criterion "agent never uses explorer APIs for safety-critical reads".
- **Rejected alternatives:**
  - *Free-form natural-language task.* Defeats the "deterministic script" goal of this scout; impl issue would have to invent a prompt and the failure-case toggles (§3.4) would not have a stable surface to toggle against.
  - *Multi-cycle agent loop.* Out of scope. §13 says "long enough to detect final status", not "indefinite". A single deposit cycle is sufficient to demonstrate the loop.
  - *Embedding the prompt in code.* Prompt lives in this ADR (text artifact) and is read from disk by the demo orchestrator, so changes to the prompt are reviewable in PR diff and the artifact set captures the exact bytes that were sent.

### 3.3 Captured artifact set — **fixed file paths and formats, captured by the demo orchestrator**

The §13 artifact list is normalized to the following exact set. All paths are relative to a single per-run directory `testing/demo-runbook/runs/<timestamp>/`. The demo orchestrator script (impl issue) creates the directory and writes each artifact; this ADR fixes the names, formats, and capture mechanism.

| Artifact | Path | Format | Captured by |
|---|---|---|---|
| Runbook | `runbook.md` | Markdown copy of this ADR | `cp docs/technical/demo-runbook.md $RUN_DIR/runbook.md` at start of run |
| Fork config + pinned block | `fork-config.json` | `{"chain_id": 8453, "rpc_label": "<sanitized>", "fork_block": <int>, "anvil_pid": <int>}` | written by orchestrator after `anvil` boot |
| OpenClaw config | `openclaw-config.json` | the exact JSON OpenClaw was launched with | written by orchestrator (`echo "$CONFIG_JSON" > openclaw-config.json`) before launch |
| Skill package | `skill-package.tar.gz` | tarball of the skill dir as installed | `tar czf $RUN_DIR/skill-package.tar.gz -C <skill_dir> .` at start of run |
| Command trace | `command-trace.jsonl` | one JSON line per `rmpc` invocation: `{"ts": "...", "argv": [...], "exit": <int>, "stdout": "...", "stderr": "..."}` | OpenClaw harness wrapper writes this; same wrapper as `testing/openclaw-config/openclaw_harness.sh` already provides |
| JSON outputs | `outputs/<seq>-<rmpc-subcommand>.json` | raw JSON output of each `rmpc get-*` call | wrapper script tees stdout into `outputs/` |
| Final report | `final-report.json` | `{"agent": "0x...", "fork_block": <int>, "vault_totalAssets_before": <decimal>, "vault_totalAssets_after": <decimal>, "deposit_id": <int|null>, "tx_hash": "0x...|null", "gas_used": <int|null>, "outcome": "deposited|refused: <reason>"}` | written by OpenClaw at end of task per §3.2 prompt step 7 |

- **Constraint cited:** §13 artifact list (six items) plus the no-fast-feedback constraint (we capture full stdout/stderr of every rmpc call rather than only the parsed JSON). Capturing both forms makes failures legible without re-running.
- **Rejected alternatives:**
  - *Single combined log file.* Loses the ability to diff a single rmpc subcommand's output across runs. Rejected.
  - *Capturing only failures.* Defeats the "reproducible from clean checkout" criterion; we cannot tell what shape a successful run has if we only kept failed runs.

### 3.4 Per-failure-case toggle commands — **one toggle per case, applied at fork-backend layer, reverted by fork restart**

Each of the five failure cases listed in §13 acceptance criteria gets a single toggle command. Toggles are applied via `cast` against the running Anvil fork after the demo orchestrator has booted Anvil but before launching OpenClaw. Each toggle is reverted by tearing down the fork and rebooting (§3.5 of the Phase 2 ADR — fork-restart per test). All `cast` invocations target `$RMPC_FORK_RPC_URL` (the local Anvil RPC, not the upstream archive). Five named failure cases:

1. **Unauthorized agent.** Agent address is generated fresh by the demo and never authorized. The toggle is to *skip* the authorization step in the orchestrator setup. Concretely: the orchestrator sets `RMPC_DEMO_SKIP_AUTHORIZE=1`, which causes the setup phase to omit the `cast send $GATEWAY "authorizeAgent(address,bytes32,uint256,uint256,uint256)" $AGENT $POLICY_HASH $CAP $WINDOW $EXPIRY` call. Expected agent behavior per §3.2 prompt step 2: refuse with `outcome: refused: not authorized`.

2. **Insufficient allowance.** Agent has authorization but its forked-USDC ERC-20 allowance to the gateway is set below `$DEPOSIT_AMOUNT`. Toggle command:
   ```
   cast rpc anvil_impersonateAccount $AGENT_ADDRESS --rpc-url $RMPC_FORK_RPC_URL
   cast send $USDC "approve(address,uint256)" $GATEWAY 0 \
     --from $AGENT_ADDRESS --unlocked --rpc-url $RMPC_FORK_RPC_URL
   cast rpc anvil_stopImpersonatingAccount $AGENT_ADDRESS --rpc-url $RMPC_FORK_RPC_URL
   ```
   Expected agent behavior per §3.2 prompt step 3: refuse with `outcome: refused: allowance below deposit amount`.

3. **Paused gateway.** The admin pauses the gateway after authorization. Toggle command:
   ```
   cast rpc anvil_impersonateAccount $ADMIN_ADDRESS --rpc-url $RMPC_FORK_RPC_URL
   cast send $GATEWAY "pause()" \
     --from $ADMIN_ADDRESS --unlocked --rpc-url $RMPC_FORK_RPC_URL
   cast rpc anvil_stopImpersonatingAccount $ADMIN_ADDRESS --rpc-url $RMPC_FORK_RPC_URL
   ```
   Expected agent behavior per §3.2 prompt step 1 (vault paused flag visible in get-vault) and §3.2 prompt step 4 (`rmpc self-check` includes a pause check): refuse with `outcome: refused: gateway paused`.

4. **Fee cap exceeded.** The agent's policy cap is set below the per-block gas-price ceiling implied by the deposit's gas estimate, so `rmpc deposit --fee-cap $FEE_CAP_WEI` aborts before broadcast. Toggle command:
   ```
   # Re-authorize the agent with a deliberately-low fee cap.
   cast rpc anvil_impersonateAccount $ADMIN_ADDRESS --rpc-url $RMPC_FORK_RPC_URL
   cast send $GATEWAY "authorizeAgent(address,bytes32,uint256,uint256,uint256)" \
     $AGENT_ADDRESS $POLICY_HASH 1 $WINDOW $EXPIRY \
     --from $ADMIN_ADDRESS --unlocked --rpc-url $RMPC_FORK_RPC_URL
   cast rpc anvil_stopImpersonatingAccount $ADMIN_ADDRESS --rpc-url $RMPC_FORK_RPC_URL
   ```
   The cap value `1` is the per-deposit USDC cap; the agent's `rmpc deposit` two-pass gas estimate (per `f9b6fda fix(cli): two-pass gas estimate so execute-* no longer aborts mid-sequence`) catches the cap breach before broadcast. Expected agent behavior: refuse with `outcome: refused: deposit exceeds policy cap`.

5. **Code-hash mismatch.** The gateway's deployed bytecode differs from the hash baked into the skill package's deployment manifest. Toggle command:
   ```
   # Replace the gateway's runtime code at the forked address.
   cast rpc anvil_setCode $GATEWAY 0x6080604052600080fdfe \
     --rpc-url $RMPC_FORK_RPC_URL
   ```
   The `0x6080604052600080fdfe` payload is a minimal `revert()` stub; any non-empty bytecode that hashes to a different `keccak256` than the manifest's pinned hash satisfies the mismatch condition. Expected agent behavior per §3.2 prompt step 4 (`rmpc self-check` includes a code-hash check against the skill manifest): refuse with `outcome: refused: gateway code hash mismatch`.

- **Constraint cited:** §13 acceptance criterion "Failure cases are demonstrable by toggling one condition at a time". Each toggle above changes exactly one orthogonal condition; combined with fork-restart-per-case (§3.1), each demo run is independent.
- **Rejected alternatives:**
  - *Toggles encoded in `rmpc` config.* Defeats the goal: the policy must be enforced *by the agent*, not bypassed by the harness. Toggles must mutate the *world*, not the agent's view of it.
  - *Single `cast` script with an env switch.* Each case has different impersonations and different reverts; one script per case is more legible than a switch statement.
  - *Toggling at the agent prompt level (e.g., "pretend the gateway is paused").* Tests the prompt, not the system. Rejected.

## 4. Impact on `docs/implementation-plan.md` §13

The decisions above are consistent with §13 as written. **No §13 acceptance criterion changes.** The §13 prose can be left unchanged; this ADR provides the missing operational detail (verbatim prompt, artifact paths, toggle commands, fork pin capture) that §13 deliberately left out. A single cross-link from §13 to this ADR is added as the convenience pointer.

## 5. Open follow-ups (not in scope of this scout)

- **Demo orchestrator script.** This ADR defines the script's contract (env vars, file paths, toggle commands); the script itself is the demo impl issue (#61).
- **Whale funding map.** §3.4 case 2 needs a known forked-USDC whale on Base for impersonation. Capture this in the orchestrator's fixture module when it is built; do not hard-code in this ADR.
- **Skill package deployment manifest.** §3.4 case 5 assumes the skill package contains a manifest with pinned `keccak256` of the gateway runtime code. Track the manifest format separately; this ADR only assumes its existence.

## 6. References

- `docs/implementation-plan.md` §13 — Phase 7 — OpenClaw E2E Demo on a Recent Public-Chain Fork (constraints this ADR resolves).
- `docs/technical/fork-e2e-decisions.md` — Phase 2 ADR (Base-mainnet fork target, Anvil backend, pinning convention reused here).
- `docs/walkthroughs/openclaw-config.md` — Phase 4 OpenClaw harness install + long-running task config (the harness wrapper that captures `command-trace.jsonl` per §3.3).
- Issue #61 — `demo: OpenClaw e2e on recent public-chain fork` (the impl issue that runs this script).
- Issue #62 — this scout.
- User memory: "No fast-feedback optimization in test harness" (binding constraint cited throughout).
