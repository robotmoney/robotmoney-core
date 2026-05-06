# Test Framework Analysis

## An Appropriate Test Pyramid for an Agentic Blockchain Product

A CLI/SDK that lets AI agents move real money onchain has a different risk profile than a typical web app. The blast radius of a bug is unbounded (loss of funds), the environment is adversarial (MEV, malicious contracts), and the user is non-deterministic (an LLM). The pyramid should reflect that:

```
                 ┌─────────────────────┐
                 │  Agent / Eval Tier  │   ~5%   prompt + tool-use evals
                 │  (LLM-in-the-loop)  │         golden-output snapshots
                 └─────────────────────┘
              ┌─────────────────────────────┐
              │   E2E / Fork & Devnet Tier  │   ~15%  anvil fork of mainnet,
              │   (real chain semantics)    │         signed txs, real ABIs
              └─────────────────────────────┘
         ┌──────────────────────────────────────┐
         │   Integration Tier                   │   ~25%  CLI command flows,
         │   (CLI ↔ encoder ↔ mocked RPC)       │         multi-step sequences
         └──────────────────────────────────────┘
   ┌────────────────────────────────────────────────┐
   │   Unit Tier                                    │   ~55%  encoders, math,
   │   (pure functions, encoders, parsers, math)    │         parsers, formatters
   └────────────────────────────────────────────────┘
```

Layer responsibilities:

1. **Unit (~55%)** — Pure-function correctness. Calldata encoders, gas math, slippage math, address/amount parsers, BigInt formatters, ABI selectors. Fast, deterministic, no I/O. These are the only tests cheap enough to run on every keystroke.
2. **Integration (~25%)** — CLI command dispatch with a mocked RPC. Verify that `prepare-deposit` reads the right state, builds the right tx sequence, applies allowance conditionals, and emits stable JSON. No signing, no network.
3. **E2E / Fork (~15%)** — The non-negotiable layer for an onchain product. Anvil/foundry fork of the target chain at a pinned block. Real ABIs, real router, real vault, real signing path, real gas. Catches: ABI drift, address typos, slot collisions, router upgrades, oracle quirks, gas-estimation reality vs. mocked constants. Should run in CI on a schedule (and on release), not necessarily every PR.
4. **Agent / Eval Tier (~5%)** — The thing most blockchain SDKs skip and most agent SDKs skip. Run the actual model against the actual tool surface with frozen prompts, score: did it pick the right tool, with the right args, refuse the right footguns (e.g., depositing more than balance, ignoring caps, redeeming to a wrong recipient)? Snapshot tool-use traces. Detects regressions that pure code tests can't see — a refactor that renames a flag or weakens a description silently breaks the agent.

Cross-cutting requirements that don't sit on one tier:

- **Property/fuzz tests** for any encoder or amount-math function (Permit2 amounts, basket weight rounding, dust handling).
- **Differential tests** comparing the SDK's encoded calldata against a reference implementation (the live router, viem's own encoder, or foundry).
- **Negative-path tests** as a first-class category: every `execute-*` should have an "aborts before any broadcast when leg N fails" test.
- **Static gates**: `tsc --noEmit`, ABI-vs-deployed-bytecode check, address-checksum check.

---

## Current State of `robotmoney-skills`

Stack: pnpm monorepo, TypeScript, Vitest 1.4 in `packages/cli`. CI is `.github/workflows/ci.yml` running `pnpm build && pnpm test` on push/PR; publish workflow re-runs tests before npm release with provenance. No coverage tooling, no typecheck step, no fork tests in CI.

Test surface in `packages/cli/test/` (≈1,287 LOC across 10 files): `execute.test.ts`, `simulate.test.ts`, `read-commands.test.ts`, `write-commands.test.ts`, `basket-encoder.test.ts`, `basket-holdings.test.ts`, `format.test.ts`, `gas.test.ts`, `morpho-apy.test.ts`, `storage-slots.test.ts`. Roughly 10 of ~30 source modules have direct tests.

### What's Good

- **Transaction-safety pattern is tested where it matters most.** `execute.test.ts` enforces the "estimate all legs before broadcasting any leg" invariant, including gas-estimate fallbacks and partial-failure aborts. This is the single highest-value test in the repo for an agent product — it's the property that prevents half-executed sequences.
- **Encoder coverage is genuinely deep.** `basket-encoder.test.ts` (231 LOC) validates UniversalRouter command codes, V3/V4 path serialization, Permit2 bounds, and dust allocation against real Base mainnet constants. This is the right shape for unit testing onchain calldata.
- **Simulate vs. execute separation is tested.** `simulate.test.ts` distinguishes "expected" failures (allowance not yet granted) from real ones, which is exactly the nuance a calling agent needs.
- **Mocking discipline is consistent.** A small `makeMockClient` factory, `vi.clearAllMocks()` in `beforeEach`, and stdout/stderr capture helpers make tests readable and isolated. CLI output is parsed as JSON and asserted structurally rather than string-matched.
- **Real production constants in tests.** Tests use the same `ADDRESSES` and `BASKET` tables as production rather than fixtures, so a typo in the address table fails an encoder test rather than a user transaction.
- **Fork harness exists.** `scripts/fork-test.ts` (427 LOC) drives an anvil fork end-to-end: fund, deposit, basket buy, redeem, basket sell, balance assertions. The capability is built; it just isn't wired into CI.

### Exists But Needs Improvement

- **Fork tests are out of CI.** `scripts/fork-test.ts` is the closest thing to ground truth in this repo, and it runs only when a human remembers to run it. Any ABI drift, router upgrade, or address mistake will land in npm before anyone notices. Promote at minimum a "smoke" subset (deposit → redeem) into a scheduled CI job; gate releases on the full run.
- **`execute-*` CLI commands are tested only at the helper layer.** `execute.test.ts` exercises `executeSequence` with mocked clients, but the `execute-deposit` / `execute-redeem` / `execute-withdraw` entrypoints — argument parsing, wallet load, exit codes, error rendering — have no direct tests. The earlier `execute-*` mid-sequence-abort regression (commit `f9b6fda`) is exactly the class of bug a command-level integration test would catch.
- **Gas estimation is tested with constants, not reality.** `gas.test.ts` and the gas branches in `execute.test.ts` use fixed return values (50k–2M). They verify the fallback logic but say nothing about whether the budgets are correct. Pair the unit tests with a fork-based assertion that real estimates fit under documented budgets.
- **RPC resilience is tested in exactly one place.** `morpho-apy.test.ts` covers GraphQL fallback. Every other code path assumes the RPC returns successfully. No tests for timeouts, 429s, reorged reads, or endpoint failover.
- **State-override tests verify plumbing, not correctness.** Tests confirm `overridesByIndex` is passed to `estimateGas`, but not that the overrides themselves (e.g., synthetic USDC allowance via storage slot) actually reproduce post-approval state. The `storage-slots.test.ts` math is unit-tested, but the round trip override → estimate → real result is not.
- **Read/write command tests are happy-path heavy.** `read-commands.test.ts` and `write-commands.test.ts` (~250 LOC each) exercise the success flows; cap-exceeded, zero-balance, missing-vault, paused-vault, and malformed-arg branches are thin.

### Gaps

- **No tests for `wallet.ts` / `create-wallet` / OWS signing.** The most security-critical surface in the codebase has zero direct coverage. Signing is mocked in every test that touches it. Key derivation, signature serialization, and the OWS handshake can break silently.
- **No tests for `rpc.ts`.** Client construction, URL resolution, chain-id verification, and fallback ordering are uncovered.
- **No tests for `abi.ts` or `addresses.ts`.** A wrong selector or a one-character address typo passes CI today. A trivial fork-based check (`getCode(address) !== "0x"`, ABI-decoded `symbol()` matches expectation) would close this.
- **No tests for `args.ts` / CLI argument parsing.** Flag validation is exercised only incidentally through command tests. Negative cases (unknown flag, missing required, conflicting flags, bad address format) are not asserted.
- **No tests for `leg-builders.ts`.** The basket-leg construction logic — overrides, weighted allocation, sell-percent vs. sell-tokens vs. sell-all — is complex and only indirectly tested via `basket-holdings.test.ts` flag combinations.
- **No agent / eval tier at all.** This is the largest conceptual gap for a product whose users are LLMs. There is no frozen-prompt suite that runs the model against the CLI's tool descriptions and scores tool selection, argument fidelity, or refusal behavior. A regression that weakens a tool description or removes a guardrail will not be caught by any existing test.
- **No property/fuzz tests.** Encoders and amount math are exactly the shape that benefit from fast-check or vitest property tests (Permit2 amount bounds, basket weight rounding to 100%, dust never exceeds N wei).
- **No differential tests.** SDK-encoded calldata is never compared against a reference (viem's encoder, the live router's accepted bytes, or foundry's `cast`). Encoder bugs that happen to round-trip through the SDK's own decoder will pass.
- **No coverage tooling and no typecheck in CI.** `pnpm test` runs Vitest only; there is no `tsc --noEmit`, no c8/istanbul threshold, no lint step in the test job. Type regressions and dead code are invisible to CI.
- **No nonce / concurrency tests.** Behavior under racing transactions, stuck nonces, or replacement fees is unspecified.
- **No multisig flow tests.** The `cf5fb8c` commit references a multisig handover; no tests assert the produced calldata is multisig-compatible.

### Plugin Integration Testing (the missing surface)

The `plugins/robotmoney-cli/` skill is the actual contract the agent reads. SKILL.md (156 LOC) plus three reference files — `read.md` (159), `write.md` (309), `basket.md` (195) — total ~819 lines of natural-language instructions telling an agent which CLI command to invoke, with which flags, in which order, with which guardrails. None of it is tested. None of it is validated against the CLI it documents. None of it is exercised inside the harnesses that actually consume it.

This is a distinct risk class from the CLI tests above. The CLI can be 100% green and the plugin can still be silently broken: a flag renamed in `args.ts`, a command split into two, a cap value updated in code but not in `write.md`, a reference file that drifts out of sync with the basket schema. The agent will dutifully call a stale flag and the user will see a transaction abort — or worse, a transaction succeed with the wrong parameters.

Plugin integration tests should answer four questions, in order of strictness:

1. **Static consistency** — every flag, command name, and address mentioned in SKILL.md / references actually exists in the CLI. Implementable today as a parser: extract `execute-deposit --amount`-style tokens from the markdown, diff against `cli --help` output and the exported command table. Runs in <1s, belongs in CI.
2. **Skill-load smoke** — the plugin loads cleanly in each target harness (no schema errors, no missing files, no broken references). Cheap, deterministic, no model calls.
3. **Tool-selection eval** — given a frozen prompt ("deposit 100 USDC and rebalance the basket to 60/40"), does the agent pick the right command sequence with the right args? Scored against a golden trace. Model calls cost money; keep the suite small (10–30 cases) and run on PRs that touch `plugins/` or `packages/cli/src/commands/`.
4. **End-to-end with fork** — the agent, running inside the harness, against a forked Base mainnet, with a funded test wallet, completes a real deposit/redeem/rebalance. The only test that catches the full chain of skill → agent → CLI → signer → RPC → contract. Slow and expensive; gate on releases, not PRs.

#### Adding plugin integration tests across multiple agent harnesses

The plugin format here is Claude's skill format (SKILL.md + references), but the same skill content needs to work in any agent harness a "zero-human company" might run on — Claude Code, Manifold/Moltbook, OpenClaw, Paperclip, or any future MCP-compatible runtime. Testing each harness separately is exponential; the goal is one suite of behavioral cases, run against many adapters.

The pattern that scales:

```
                    ┌─────────────────────────┐
                    │   Shared eval cases     │   prompts + golden traces
                    │   (YAML/JSON, harness-  │   ("deposit 100 → expect
                    │    agnostic)            │    execute-deposit --amount=100")
                    └────────────┬────────────┘
                                 │
            ┌────────────────────┼────────────────────┐
            ▼                    ▼                    ▼
   ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
   │ Claude adapter │   │ Moltbook adptr │   │ OpenClaw adptr │   …
   │ (skill API)    │   │ (their plugin  │   │ (MCP server)   │
   │                │   │  loader)       │   │                │
   └────────┬───────┘   └────────┬───────┘   └────────┬───────┘
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 ▼
                    ┌─────────────────────────┐
                    │  Same CLI binary +      │
                    │  same anvil fork        │
                    └─────────────────────────┘
```

Concrete pieces to build:

- **Harness-agnostic case format.** Each case is `{ prompt, expected_tool_calls[], forbidden_tool_calls[], expected_chain_state_delta }`. Cases live in `test/plugin-evals/` and are owned by this repo, not by any harness.
- **Thin adapter per harness.** Each adapter does three things: (a) load the plugin in the harness's native format (Claude skill, MCP server descriptor, whatever Moltbook/OpenClaw/Paperclip expose), (b) feed the prompt through the harness's agent loop, (c) emit a normalized trace `{ tool_name, args, order }` for the scorer. The MCP-compatible harnesses can share a single adapter — wrap the CLI as an MCP server (Robot Money already ships in a form close to this) and any MCP-speaking agent runtime drops in.
- **Scorer that distinguishes plumbing failures from judgment failures.** A failed case should tell you *why*: "harness couldn't load the skill" (plumbing — fix the adapter), "agent picked `prepare-deposit` instead of `execute-deposit`" (judgment — fix the skill prose), "agent picked the right command but wrong flag" (drift — fix the reference file).
- **Two run modes.** Smoke (3–5 cases per adapter, no model calls — replays canned model outputs to verify plumbing); full (the eval suite with real model calls, run nightly or on plugin/CLI changes only).
- **Cross-harness invariants.** A case that passes in Claude but fails in OpenClaw is a signal — usually the skill leans on Claude-specific conventions (how it parses code blocks, how it follows nested headers). Those failures are the most valuable output of the cross-harness suite; they tell you which parts of SKILL.md aren't portable.
- **Cost control.** Model-calling tests are billed per run; cap each case at a fixed turn budget and a fixed token budget, and short-circuit on first wrong tool call. Cache prompt prefixes where the harness supports it.
- **Wallet isolation.** Every harness adapter gets its own ephemeral key on a fresh anvil fork per case. Never share a wallet across cases — concurrent nonce contention will create flakes that look like agent failures.

For autonomous, no-human-in-the-loop deployments specifically (the "zero-human company" case), the eval tier is not optional — it is the only layer that catches "the agent technically did something, but it wasn't what the operator intended." A human operator catches a bad tool call by reading the confirmation prompt; an autonomous operator does not. The plugin eval suite is the substitute for that human review, and its coverage of refusal cases (over-cap deposits, redeem-to-unknown-address, rebalance during paused vault) matters more than its coverage of happy paths.

### Recommended Priorities

1. Add a static-consistency check for `plugins/robotmoney-cli/` — parse every flag and command name out of the markdown, fail CI if any don't exist in the CLI. Cheapest, catches the most common drift class.
2. Add a CI-gated fork smoke test (deposit → redeem on a pinned anvil fork). Highest ROI for onchain correctness.
3. Add direct tests for `wallet.ts` and `create-wallet` covering signing, key handling, and the OWS path. Security-critical surface should not be the least-tested.
4. Add command-level integration tests for every `execute-*` and `prepare-*` entrypoint, including failure exit codes.
5. Stand up the plugin eval suite with a Claude adapter first, harness-agnostic case format from day one, then add Moltbook / OpenClaw / Paperclip / generic-MCP adapters as needed. Even a 10-case suite is a step-change.
6. Add `tsc --noEmit`, `eslint`, and `prettier --check` to the CI test job; add coverage reporting (no threshold initially, just visibility).
7. Add ABI/address sanity checks against the pinned fork (`getCode`, `symbol()`, `decimals()`).
8. Backfill negative-path tests for read/write commands (caps, zero balance, paused, malformed args).
9. Property tests for encoders and amount math.
