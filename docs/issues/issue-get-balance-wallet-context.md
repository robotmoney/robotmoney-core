# Issue — `get-balance` returns vault-only data; wallet USDC and ETH balances are missing

> Summary: PRD story §4.1 calls `get-balance` to decide whether and how much to sweep: the expected output is `{ usdcBalance, ethBalance, rmUsdcBalance, navUsdc }`. The current command returns only the vault position (shares, gross/net NAV, exit fee). The wallet's USDC balance — the thing about to be swept — and its ETH balance — the gas-headroom signal — are absent. Without `usdcBalance` the agent cannot compute the sweep amount; without `ethBalance` it cannot pre-check gas before triggering a deposit. A secondary bug: the PRD story code blocks show a `--json` flag that does not exist; Commander will reject it with "unknown option `--json`", causing the command to fail when an agent follows the story literally.

## 1. Severity

**High.** Story §4.1's sweep trigger is `if usdcBalance > reserve + minDeposit` — this comparison is impossible without `usdcBalance` in the output. The `--json` flag bug means any agent that copies the story's command verbatim will get a hard CLI failure before it even reaches the vault.

## 2. Background

Story §4.1 (Moltbook / zero-human SaaS) describes a nightly cron that:
1. Calls `get-balance --user-address $WALLET --json` and parses `{ usdcBalance, ethBalance, rmUsdcBalance, navUsdc }`.
2. Computes `usdcBalance - reserve` as the deposit amount.
3. Calls `execute-deposit --amount $((usdcBalance - reserve))`.

Without step 1 returning `usdcBalance`, step 3 has no input. Without `ethBalance`, the harness cannot implement its own pre-flight gas check before calling `execute-deposit` (which does its own check internally, but by then it's inside the signing flow — surfacing the issue earlier is better UX for an autonomous operator).

The `navUsdc` field (net vault NAV in USDC, i.e. the USDC the user would receive after exit fee on a full redeem) is what story §4.1 and §4.3 store in their weekly NAV snapshot for rolling-return computation. The current output has `netValueUsdc` for this concept but the stories use `navUsdc` — a naming mismatch that will cause silent parse failures.

## 3. Evidence

`packages/cli/src/commands/get-balance.ts` reads three vault contract functions and emits:

```json
{
  "user": "0x...",
  "shares": "99.123456",
  "sharesRaw": "99123456",
  "grossValueUsdc": "100.00",
  "grossValueUsdcRaw": "100000000",
  "netValueUsdc": "99.75",
  "netValueUsdcRaw": "99750000",
  "exitFeeUsdc": "0.25",
  "exitFeeUsdcRaw": "250000"
}
```

No USDC token balance. No ETH balance. No `navUsdc` key.

`packages/cli/src/lib/gas.ts` already fetches `ethBalance` via `client.getBalance({ address: user })` for the pre-flight gas check — the data is available in the codebase but never surfaced in command output.

`packages/cli/src/index.ts`: no `--json` flag registered on any command. `--pretty` is the human-readable variant; compact JSON is the default output mode. Commander will reject `--json` as an unknown option on any command that doesn't define it.

## 4. User impact

| Story | What breaks |
|---|---|
| §4.1 Moltbook sweep | Agent cannot compute deposit amount; `--json` flag causes hard CLI error. |
| §4.2 OpenClaw device | Beacon payload expects `sharesReceived` (delta, not balance); only total balance is available. |
| §4.3 Claude Code | Weekly snapshot stores `navUsdc`; current output key is `netValueUsdc` — silent mismatch. |

## 5. Proposed resolution

**5.1 Extend `get-balance` output**

Add to the emitted JSON:

```json
{
  "user": "0x...",
  "usdcBalance": "523.41",
  "usdcBalanceRaw": "523410000",
  "ethBalance": "0.003142",
  "ethBalanceRaw": "3142000000000000",
  "shares": "99.123456",
  "sharesRaw": "99123456",
  "grossValueUsdc": "100.00",
  "grossValueUsdcRaw": "100000000",
  "navUsdc": "99.75",
  "navUsdcRaw": "99750000",
  "exitFeeUsdc": "0.25",
  "exitFeeUsdcRaw": "250000"
}
```

Changes:
- Add `usdcBalance` / `usdcBalanceRaw` via `USDC.balanceOf(userAddress)`.
- Add `ethBalance` / `ethBalanceRaw` via `client.getBalance({ address: userAddress })`. Factor the existing `gas.ts` balance fetch into a shared utility rather than duplicating.
- Add `navUsdc` / `navUsdcRaw` as the primary field name (the USDC value receivable on a full redeem net of exit fee). Keep `netValueUsdc` as a deprecated alias for one semver cycle to avoid breaking existing callers.

The three new reads (`USDC.balanceOf`, `client.getBalance`, already-present vault reads) should be parallelised with `Promise.all` — no extra round trips.

**5.2 Fix `--json` flag in PRD stories**

Remove `--json` from all command examples in `docs/prd.md`. The CLI always emits JSON; `--pretty` is the opt-in for human-readable output. Stories should either drop the flag entirely (correct for agent use) or use `--pretty` where showing formatted output in an example.

## 6. Acceptance criteria

- `get-balance --user-address <addr> --chain base` emits `usdcBalance`, `ethBalance`, `navUsdc` fields in the JSON output.
- All three new values round-trip correctly: `usdcBalance` matches `USDC.balanceOf(addr)` / 1e6, `ethBalance` matches `client.getBalance(addr)` / 1e18.
- `navUsdc` equals `previewRedeem(balanceOf(addr))` / 1e6 (net of exit fee).
- `netValueUsdc` remains present as a deprecated alias.
- `--json` flag removed from all code examples in `docs/prd.md`; no other docs or skill files reference it.
- Unit test: mock `USDC.balanceOf`, `getBalance`, vault reads; assert all new output fields are present and correctly formatted.
- No additional RPC round trips beyond what `Promise.all` can parallelise with the existing vault reads.

## 7. Open questions

- **Naming consistency.** `grossValueUsdc` vs. `netValueUsdc` vs. `navUsdc` — should we do a full output rename to align on `navUsdc` / `grossUsdc` terminology, or keep the old names for backward compat? Semver says a rename is a breaking change; an alias-then-deprecate cycle is safer but doubles the schema noise.
- **Basket holdings in `get-balance`?** Story §4.3 calls `get-allocation` to get the full picture. Should `get-balance` remain vault-only + wallet-assets, or should it optionally include basket holdings? Probably keep it scoped and let `get-allocation` be the unified view — see `issue-get-allocation-missing.md`.
- **USDC address cross-chain.** Currently hardcoded per chain in `lib/addresses.ts`. If/when multi-chain lands, ensure `get-balance` reads from the correct chain's USDC address.

## 8. References

- Current implementation: [`../../packages/cli/src/commands/get-balance.ts`](../../packages/cli/src/commands/get-balance.ts)
- ETH balance fetch: [`../../packages/cli/src/lib/gas.ts`](../../packages/cli/src/lib/gas.ts)
- PRD stories: [`../prd.md`](../prd.md) §4.1, §4.2, §4.3
- Related: [`issue-get-allocation-missing.md`](issue-get-allocation-missing.md)
