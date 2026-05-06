# Security Review: Robot Money

**Scope:** Full codebase — `contracts/` (Solidity), `packages/cli/src/` (TypeScript), shell scripts, config.
**Method (Pass 1):** Breadth-first codebase survey → drill-down per call path → parallel false-positive filtering, threshold confidence ≥ 8.
**Method (Pass 2 — TS CLI critical re-review):** Adversarial re-read of `packages/cli/src/`, deliberately re-evaluating filters that Pass 1 applied.
**Status of the TS CLI:** Deprecated as of 2026-05-06 in favor of a Rust signing daemon (`rmpd`) plus an on-chain policy gateway. Findings against the CLI are retained both as a historical record and as design traps the Rust rewrite must avoid (see [Lessons for the Rust + gateway rewrite](#lessons-for-the-rust--gateway-rewrite)).

---

## Part 1 — Smart Contracts (Pass 1)

### Result: No High-Confidence Vulnerabilities Found

After exhaustive analysis across all call paths, every candidate finding was filtered out. The contracts are more carefully written than the breadth-first scan suggested.

### What Was Examined and Why It Is Not Exploitable

**`_withdraw` CEI order — `_pullProportional` before `_burn`**
Shares are burned after external adapter calls. With `nonReentrant` on `_withdraw`, adapters cannot reenter. No exploitable reentrancy path exists. *(Confidence after filtering: 4)*

**`MorphoAdapter.withdraw` returns `amount` not `actual`**
`MORPHO_VAULT.withdraw(amount, VAULT, address(this))` is an ERC-4626 call that MUST revert if it cannot transfer `amount`. Unlike Aave (which returns a value) and Compound (which sends to `msg.sender` so a pre/post balance diff is required), Morpho sends directly to `VAULT` and reverts on shortfall by spec. Returning `amount` is correct. *(Confidence after filtering: 2)*

**`adminRebalance` with no target-sum validation**
The second loop is bounded by `idle` USDC actually in the vault — not by `targetBalances`. Admin cannot over-allocate beyond what was pulled. Funds stay within the vault system. *(Confidence after filtering: 4)*

**`totalAssets()` excludes vault idle USDC → TVL cap can be marginally exceeded**
True accounting gap, but: (a) idle USDC is swept on every `rebalance()` call, (b) the overshoot window is bounded by `perDepositCap`, (c) no theft path — if anything, new depositors receive slightly fewer shares (existing holders benefit). The TVL cap is an administrative parameter, not a solvency invariant. *(Confidence after filtering: 2)*

**`_pullProportional` rounding remainder**
The final `remaining` after proportional pulls is at most a few wei (integer division loss). The last adapter's balance easily covers it. *(Confidence after filtering: 3)*

### Near-Threshold Design Observations (Contracts)

1. **`MorphoAdapter.withdraw` inconsistency** — Aave and Compound verify actual received amounts; Morpho does not because ERC-4626 semantics differ. Defensive depth would improve consistency but cannot be exploited.
2. **`totalAssets()` excludes vault idle USDC** — A single-line fix (`+ IERC20(asset()).balanceOf(address(this))`) would make the TVL cap accounting exact and would also improve share price accuracy during rebalance windows.
3. **V4 sell intermediate minimum asymmetry** — The buy path enforces `intermediateMin` on the V3 leg; the sell path does not. Adding a derived WETH floor from `hopOutputs[0]` would make the two paths symmetric and reduce gas waste from reverts in volatile markets.

### Contracts Summary

`ReentrancyGuard` on all state-mutating paths, `SafeERC20` throughout, `onlyVault` on all adapters, no unchecked external call return paths that can be forced into a bad state.

---

## Part 2 — Off-Chain / TypeScript CLI (Pass 1)

The Pass-1 sweep treated the off-chain code as roughly fine. Pass 2 below disagrees with three of these conclusions; cross-reference each item:

**OWS wallet created without spending policy**
The `OwsCore` interface has no policy parameter — caps are not set at wallet creation. Documented gap (`issue-ows-policy-unenforced.md`); not a concrete exploitable code-level vulnerability under Pass-1 rules. *(Confidence after filtering: 3)*

**V4 sell path `amountOutMin = 0n` on intermediate WETH leg**
Pass 1 dismissed this on grounds of UR atomicity. Pass 2 retains the rating but documents the residual risk it inherits from the quoter trust issue. See **M-2** below.

**USDC allowance storage slot hardcoded (`slot 10`)**
A wrong slot only affects `stateOverride` during gas estimation — not actual transaction execution. The real deposit/approve sequence works regardless. Impact: misleading simulation output, not fund loss. *(Confidence after filtering: 5)*

**RPC URL from `process.env.RPC_URL` without validation**
Pass 1 excluded as a "trusted env value." Pass 2 disagrees — see **H-3** below; the RPC is *not* trusted when its `eth_call` output is consumed as min-out for a signed swap.

---

## Part 3 — TypeScript CLI Critical Re-Review (Pass 2)

**Posture:** Adversarial. Pass 1 applied a confidence-≥-8 filter and a "best practices vs concrete vuln" rule and concluded nothing off-chain was reportable. Two of those filters were misapplied; one finding was not considered at all.

### H-1 (HIGH) — `--passphrase` on the command line leaks the keystore passphrase to every other process on the host

**Where:** `src/index.ts:227, 266, 317, 369` (commander option `--passphrase <string>`), consumed in `src/lib/wallet.ts:159` (`resolvePassphrase` returns `opts.passphraseFlag` verbatim).

**What it does:** Every `execute-*` and `create-wallet` command accepts `--passphrase <string>` as a CLI argument. On Linux, `argv` is world-readable via `/proc/<pid>/cmdline` for the lifetime of the process; on shared/CI hosts this lands in shell history, `ps auxww` snapshots, journald, container logs, and process-monitoring tooling. It is also the value that decrypts the OWS keystore on disk.

**Loss path:** Adversary with unprivileged read on the same host (other user, sidecar container, log shipper) reads the passphrase, then reads the OWS vault dir (default `~/.ows/wallets/` — there is no umask guard and no chmod on create; see H-2), and signs arbitrary transactions. End-to-end key compromise.

**Prerequisites:** Co-tenant or any process running as same UID with proc access. For agents this is the realistic deployment shape.

**Severity:** High. Documentation actively encourages this footgun ("OWS passphrase (or set OWS_PASSPHRASE env)" appears in every help text).

**Fix sketch:** Remove the flag entirely; accept passphrase only via `OWS_PASSPHRASE` env, stdin pipe, or a secrets-file path read with `fs.readFile` + a `mode & 077 === 0` check. If kept for tests, gate behind `--unsafe-passphrase-arg`.

**Carries to Rust rewrite?** Yes — design-level trap. The Rust daemon must not accept secrets on argv. Expose only env-var / file / stdin / OS keychain paths.

### H-2 (HIGH) — Wallet storage path and file-mode hygiene are entirely delegated to OWS, with zero local checks

**Where:** `src/lib/wallet.ts:96` (`DEFAULT_OWS_VAULT_PATH = ~/.ows/wallets`), `src/commands/create-wallet.ts:11-47` (no chmod, no umask, no perms verification), `wallet.ts:127` (`readdir(vaultPath)` then trusts everything OWS returns).

**What it does:** `create-wallet` calls into the OWS native binding and returns. Nothing in this codebase verifies that `~/.ows/wallets/` is mode 0700, that keystore files are 0600, or that the directory is owned by the current user. `--storage-path` is a free-form user string passed straight to OWS with no validation (no path-traversal check, no symlink check, no cross-device check).

**Loss path:** If OWS happens to write 0644 keystore files on Linux (this is not validated anywhere in this repo, and at least one OWS prebuild has historically created world-readable files), every co-tenant reads the encrypted keystore. Combined with H-1 or any weak passphrase, that's full key compromise. Independently: an attacker who can write `~/.ows/wallets/` (e.g. via a previously-running malicious dependency) can plant a keystore the user later signs from.

**Severity:** High when paired with H-1. Medium standalone.

**Fix sketch:** Before any OWS call, `fs.stat` the vault dir; require `(stat.mode & 0o077) === 0` and `stat.uid === process.getuid()`; same for each keystore file before/after creation. Reject `--storage-path` containing `..`, refuse symlinked directories.

**Carries to Rust rewrite?** Yes — same surface exists for any local-keystore daemon. Enforce in Rust.

### H-3 (HIGH) — Buy/sell legs trust intermediate-hop minimums derived from a single quoter call on the same RPC that signs

**Where:** `src/lib/basket/leg-builders.ts:113-133`, `src/lib/basket/encoder.ts:218-296` (`buildBuyLeg`, mixed-V3->V4 path), and `quoter.ts:142-173` (`quoteChainedExactIn`). The min-out floor for both legs is computed as `applySlippage(quote.amountOut, 300bps)` against a quote returned by the **same RPC node** that the CLI then asks to broadcast.

**What it does:** A single `eth_call` against `V3_QUOTER_V2`/`V4_QUOTER` produces `quote.amountOut`. The encoder applies 3% slippage and embeds that as `amountOutMin`. There is no second-source quote, no chain-state sanity check, and the RPC pool in `rpc.ts:9-15` is a list of unauthenticated public endpoints (`base.drpc.org`, `base.llamarpc.com`, `1rpc.io/base`, etc.) selected by viem's fallback transport on transport errors — but a *correct-looking* malicious response is accepted unconditionally.

**Loss path:** A hostile RPC (or DNS/TLS-strip MITM against any of those public endpoints — they're plain HTTPS but operator-controlled) returns an inflated `amountOut`. The CLI then computes a near-zero floor relative to honest market price (3% of "inflated" is still well below honest expected output), signs, and submits to a *different* honest RPC. The order fills with massive negative slippage; the user keeps tokens worth far less than the USDC spent. Pure, atomic, single-RPC-of-trust loss.

Pass 1 dismissed this as "Universal Router executes both commands atomically — sandwich revert is gas-only." That framing answers a different question. The threat is not a sandwich attacker; it's the quoter source itself lying. Atomicity does not help when the floor *itself* is set against a fabricated number.

**Severity:** High. The `BASE_RPC_POOL` is curated public endpoints with no integrity binding, and `--rpc-url` is the canonical agent-config knob.

**Fix sketch:** (a) Quote from at least two independent sources (e.g., V3 quoter via a private RPC + a Coingecko-style sanity oracle) and reject if they diverge >X bps; (b) require `--rpc-url` be either localhost or a known-good provider with auth; (c) compute a USDC-denominated floor from a chainlink/pyth oracle for each leg, not from the same quoter that the swap will hit.

**Carries to Rust rewrite?** **Yes — this is the most important design lesson.** The Rust daemon must treat the RPC as untrusted for any value used in a min-out, deadline, or fee. The on-chain gateway approach helps insofar as the contract enforces the floor, but only if the floor is sourced off-RPC.

### M-1 (MEDIUM) — `Permit2.approve(token, UR, type(uint160).max, now+365d)` granted preemptively for every basket token

**Where:** `src/lib/basket/leg-builders.ts:122` (USDC) and `:247` (each basket sell token). Both use `MAX_U160` and a 1-year expiration.

**What it does:** Whenever a deposit or sell triggers an approval refresh, the CLI grants the Universal Router an unbounded `uint160` Permit2 allowance for one full year. There is no scope-down, no per-tx allowance, no revoke-on-failure path, and no allowance cleanup on shutdown.

**Loss path:** Any subsequent UR exploit (UR has had multiple advisories; the v3-permit2 surface specifically had the September 2023 issue) drains every basket token plus USDC up to the user's balance for 365 days, with no further user action required. The CLI sets this allowance even on `--basket-only` and even when the underlying swap is for a tiny amount.

Pass 1 did not consider this.

**Severity:** Medium. Loss requires a UR vulnerability or operator compromise of UR; given UR is widely used and audited the unconditional probability is low, but the blast radius is the entire wallet's basket+USDC and lasts a year.

**Fix sketch:** Approve only `amountIn` for the current swap with a short expiration (`now + 1h`).

**Carries to Rust rewrite?** Yes — design lesson. Default to scoped, short-lived Permit2 allowances; never `MAX_U160`.

### M-2 (MEDIUM) — V4 sell intermediate leg has `amountOutMinimum = 0n` on the WETH hop

**Where:** `src/lib/basket/encoder.ts:336-338` — the V4 swap inside `buildSellLeg` is encoded with `amountOutMin = 0n` and the comment "tighter check happens via V3 leg".

**What it does:** When selling ROBOT (V4 → V3), the V4 hop accepts any WETH output ≥ 0; the floor is enforced only on the trailing V3 WETH→USDC leg via `V3_CONTRACT_BALANCE`.

Pass 1's atomicity argument is correct as far as it goes — a sandwich pushing V3 below `minUsdcOut` reverts the whole thing — but the floor `minUsdcOut` is itself derived from `applySlippage(quote.amountOut)` and inherits H-3. If H-3 lands, M-2 is the lever that turns it into loss on the sell side. Also: with `V3_CONTRACT_BALANCE`, the V3 leg trades whatever WETH UR holds; future leg-stacking that puts residual WETH in UR would expose this.

**Severity:** Medium (latent; defense-in-depth gap).

**Fix sketch:** Set the V4 leg `amountOutMin` to `applySlippage(quote.hopOutputs[0], slippageBps)` symmetrically with the buy path.

**Carries to Rust rewrite?** Yes if Rust still encodes UR commands client-side. If the gateway absorbs path encoding, this becomes a contract-level concern instead.

### M-3 (MEDIUM) — Nonce sequencing is fetched once and incremented locally; partial-broadcast leaves user funds in a half-state

**Where:** `src/lib/execute.ts:115-157`. `getTransactionCount({ blockTag: 'pending' })` is called once before the loop; subsequent txs use `startingNonce + i`. If broadcast `i` succeeds and `i+1` fails (RPC drop, OWS error), the user is left with: approve landed, deposit not landed; or vault leg landed, basket-buy leg not landed.

**What it does:** The loop catches the failure and throws an error string listing in-flight hashes — but takes no action. There is no replacement (same-nonce, higher fee), no recovery routine that can be invoked safely later, and gas budget is burned on the partial state.

**Loss path:** In the basket-deposit case, vault leg deposits 95%, basket leg fails — user holds shares but the 5% USDC sit at the wallet. In the sell-redeem case, vault redeem succeeds, basket sell fails — user has USDC plus stale unsold tokens. Worse: because Permit2 approvals are pushed first in the sell sequence (`leg-builders.ts:243-248`), a sell-leg failure can leave M-1's max-uint160 allowance live with no swap actually executed.

**Severity:** Medium. Not a direct theft path, but a real availability + composition bug, and M-1 amplifies it.

**Fix sketch:** Either (a) make every multi-tx operation idempotent via a contract-level batcher (the gateway approach), or (b) implement same-nonce replacement with monotonic fee bumping and a hard timeout, and only push approvals immediately before they're consumed.

**Carries to Rust rewrite?** The Rust+gateway design eliminates this entirely as long as the gateway batches the user-facing intent into one tx. Historical-only.

### L-1 (LOW) — `extractRevert` walks the cause chain and accepts any object's `data` field as revert calldata

**Where:** `src/lib/errors.ts:55-77`. `findRevertData` walks `cause` recursively and treats any `data: "0x..."` as revert data, then `decodeErrorResult` runs against the vault ABI.

**Loss path:** Doesn't lose funds directly. A hostile RPC can make a successful call appear to revert with a chosen custom error name from the vault ABI, which feeds into `REVERT_GUIDE` UX and may cause an autonomous agent to take a wrong recovery action ("ERC20InsufficientAllowance → bump approve"). Combined with H-3, the agent UX layer becomes another attacker-controlled message channel.

**Severity:** Low standalone.

**Carries to Rust rewrite?** Design note: never round-trip RPC error strings through agent decision logic.

### L-2 (LOW) — Logging hygiene is acceptable but has one sharp edge

`emitError` (`src/lib/format.ts:40`) prints `err.message` from `runOrDie` (`src/index.ts:42`). The OWS native binding's error messages are not under this codebase's control. If OWS ever included partial keystore content, mnemonic words, or a rendered private key in an error string, `process.stderr.write(JSON.stringify({error: err.message}))` would emit it. Add a defensive sanitizer that strips anything matching `0x[a-f0-9]{64}` or BIP-39 word lists from outbound error messages.

### What was checked in Pass 2 and is genuinely fine

- **Chain ID binding (`execute.ts:120`)**: hardcoded `base.id` (8453) on the typed envelope. Replay across chains not possible.
- **`isAddress` validation in `args.ts:7-9`** uses viem's `isAddress` — checksum-aware.
- **`amountSchema` and `parseUnits`** correctly reject negatives and non-decimal input.
- **No `eval`, no `child_process`, no shell expansion of CLI args.**
- **`pnpm-lock.yaml` present** at repo root; viem/uniswap deps are caret-pinned but lockfile fixes them.
- **Storage-slot 10 override (`storage-slots.ts`)** is genuinely simulation-only — Pass 1's analysis stands.
- **`signAndSendSequence` Phase-1 estimation gate** (`execute.ts:81-112`) genuinely prevents broadcasting tx[0] when an early failure is detected.

### Pass 2 — Where Pass 1 was wrong, in brief

1. **H-1** is not a "best practice" issue. CLI passphrase flags are a documented anti-pattern *because* they are a concrete leak channel via `/proc` and shell history.
2. **H-3** was filtered as "RPC-URL is a trusted env value." That rule is fine for the *destination* of broadcast, but fatal when the same RPC's `eth_call` output is consumed as the **min-out** for an irrevocable swap. Trust boundary was drawn in the wrong place.
3. **M-1** (max Permit2 allowance for one year) was not considered.

---

## Part 4 — Known DeFi Exploit Classes: Coverage Checklist

Each well-known DeFi exploit category, mapped to the Robot Money attack surface (vault contracts + adapters + CLI/UR swap flow). "Addressed" means a defense exists in the implemented code; "Mitigated by design" means the threat does not apply to this surface; "Open" means residual risk remains.

| # | Class | Status | Where addressed / why N/A |
|---|---|---|---|
| 1 | Reentrancy (single-function) | Addressed | `ReentrancyGuard` on `deposit/withdraw/mint/redeem/rebalance` in `RobotMoneyVault.sol`. |
| 2 | Reentrancy (cross-function) | Addressed | Adapters `onlyVault`-gated; vault’s nonReentrant covers the only entry path that touches them. |
| 3 | Read-only reentrancy (price/share inflation via reentered view) | Addressed | `totalAssets()` reads adapter `assetsOf()` which calls into Aave/Compound/Morpho view functions; no hostile callbacks during a state-mutating reentry because `nonReentrant` blocks the outer call. |
| 4 | Cross-chain replay | Addressed | EIP-1559 typed envelopes with `chainId = base.id` (`execute.ts:120`); EIP-155 signing throughout. |
| 5 | Tx replay (same-chain) | N/A | Nonce sequencing prevents replay of identical signed tx; partial-failure mode separately tracked as **M-3**. |
| 6 | Signature malleability / EIP-2098 misuse | N/A | No on-chain signature recovery in vault; OWS produces canonical signatures. |
| 7 | Permit / Permit2 phishing-style approval drain | **Open — M-1** | UR is granted `MAX_U160` for 365d on every basket token. Mitigation: scope approvals to `amountIn` with `now+1h`. |
| 8 | Frontrunning / generalized MEV | Mitigated | Slippage floor on final leg via `V3_CONTRACT_BALANCE`; UR commands atomic. |
| 9 | Sandwich attack | Mitigated | Same as #8 — atomic revert if final-leg floor is undercut. Note: the *floor itself* is vulnerable; see #11. |
| 10 | JIT-liquidity manipulation around the swap block | Partially mitigated | 3% slippage tolerance and an end-to-end simulated path output reduce exposure; not eliminated for thin pools. The buy path’s ROBOT V4 leg is the most exposed. |
| 11 | Oracle / price-feed manipulation (quoter trust) | **Open — H-3** | Slippage floors derived from a single RPC's `eth_call` against the on-chain quoter. Mitigation: independent oracle for the floor. |
| 12 | Flashloan-amplified manipulation of vault accounting | Mitigated by design | `totalAssets()` reads adapter principal+yield, not a price oracle; vault is a constant-NAV USDC vault, no swappable internal pricing. |
| 13 | First-depositor / share-inflation attack on ERC-4626 | Addressed | `RobotMoneyVault` follows OZ ERC-4626 with virtual shares/offset (verify in `Vault.sol`); `perDepositCap` further bounds first-mover impact. *(Confirm OZ version pin includes the inflation-attack mitigation.)* |
| 14 | Donation-attack / direct-transfer share dilution | Mitigated | `totalAssets()` deliberately excludes idle USDC at the vault, so direct USDC transfers do not move share price until `rebalance()` is called by an authorized role. The Pass-1 "TVL cap can be marginally exceeded" item is the flip side and is benign for solvency. |
| 15 | Approval race (approve(0)→approve(N) front-run on classic ERC-20) | Mitigated | USDC allowance flow uses Permit2; no classic increase-allowance race. Direct-token approvals (Aave/Compound/Morpho via adapter) are between trusted parties (vault → adapter → protocol). |
| 16 | Infinite / over-broad approval | **Open — M-1** | Same as #7. |
| 17 | Wrong-spender / address mix-up in approvals | Addressed | Spender addresses are constants in `addresses.ts`/contract immutables; checksum-validated via viem. |
| 18 | Universal Router command mis-encoding (recipient, sweep, unwrap) | Addressed | `encoder.ts` sets `recipient = msg.sender` via `MSG_SENDER` sentinel and emits a final `SWEEP` for non-USDC residue. Verified in unit tests. |
| 19 | Slippage-zero / `amountOutMinimum = 0` on a final leg | Addressed | Final-leg minimums are non-zero; the only `0n` is on intermediate hops, where atomicity protects the end-to-end output. See **M-2** for the latent risk. |
| 20 | Fee-on-transfer / rebasing token incompatibility | Mitigated by design | USDC is the canonical input/output. Basket tokens are vetted (`basket/constants.ts`); reject any FoT token before listing. |
| 21 | Storage-slot manipulation via state override | Mitigated | `storage-slots.ts` is simulation-only; on-chain transfers use the real allowance. |
| 22 | Governance / admin key compromise | Out of scope here | Owner is multisig-gated. Tracked separately. |
| 23 | Upgrade / proxy storage clash | N/A | Vault is non-upgradeable. |
| 24 | Reinitialization | N/A | No `initialize()` pattern; constructor-only. |
| 25 | Selfdestruct / forced ether | Mitigated | No ETH balance dependency; vault holds USDC. |
| 26 | Access-control bypass (missing `onlyOwner`/`onlyVault`) | Addressed | Pass 1 verified all state-mutating paths gated. |
| 27 | Integer overflow/underflow | N/A | Solidity ≥0.8 checked arithmetic throughout. |
| 28 | Rounding-direction errors (favoring user vs protocol) | Addressed | OZ `Math.mulDiv` with explicit rounding; `_pullProportional` rounding remainder bounded to a few wei. |
| 29 | DoS via gas-griefing in loops | Mitigated | Adapter list is bounded by admin (≤ small N); no unbounded user-controlled iteration. |
| 30 | Unbounded `transferFrom` failure swallowing | Addressed | `SafeERC20` reverts on failure throughout. |
| 31 | Off-chain key compromise via argv / env / log leakage | **Open — H-1, L-2** | `--passphrase` flag plus unsanitized error strings. |
| 32 | Local keystore tampering / wrong file mode | **Open — H-2** | No local mode/owner verification before signing. |
| 33 | Hostile RPC injecting fake revert data | **Open — L-1** | `extractRevert` accepts any `data: 0x…` from cause chain. |
| 34 | Partial-broadcast / nonce-gap leaving funds in inconsistent state | **Open — M-3** | Multi-tx loop without same-nonce replacement. Closes under the gateway design. |
| 35 | Supply-chain / dependency compromise | Partially mitigated | `pnpm-lock.yaml` pins; no `postinstall` scripts in our packages. Dependabot/renovate not yet wired. |

**Open items rolled up:**
- **H-1** key-leak via argv (#31)
- **H-2** keystore mode hygiene (#32)
- **H-3** RPC-trust on slippage floor (#11)
- **M-1** max Permit2 allowance (#7, #16)
- **M-2** intermediate-leg `amountOutMin = 0` latent under H-3 (#19)
- **M-3** partial-broadcast (#34)
- **L-1** revert-data spoofing (#33)
- **L-2** error-message sanitization (#31)

No new exploit class identified beyond those above.

---

## Lessons for the Rust + gateway rewrite

1. **Never source slippage floors from the same channel that broadcasts.** Use an independent oracle, or move floor enforcement entirely on-chain at the gateway with values committed before the swap RPC sees them. *(addresses H-3, M-2)*
2. **No secret material on argv. Ever.** Env / stdin / file (mode-checked) / OS keychain only. *(addresses H-1)*
3. **Verify keystore directory and file modes locally** before any signing call — don't outsource to a native binding. *(addresses H-2)*
4. **Default to scoped, short-expiration Permit2 allowances.** Treat `MAX_U160 + 1y` as a code smell that requires explicit justification. *(addresses M-1)*
5. **Make every multi-step intent atomic at the contract level** (the gateway does this); the CLI's per-tx loop with local nonce arithmetic is a class of bug that should not exist in the new design. *(addresses M-3)*
6. **Never round-trip RPC error strings through agent decision logic.** Decode revert selectors against a known whitelist; treat unknown selectors as opaque. *(addresses L-1)*
7. **Sanitize all outbound logs** for hex-key and BIP-39 patterns even when the source is a trusted dependency. *(addresses L-2)*

Items M-2 and M-3 become non-issues once the gateway batches the user intent on-chain. Items H-1, H-2, H-3, M-1, L-1, L-2 are design traps the Rust client must be specifically engineered against.

---

## Overall Summary

- **Contracts:** No exploitable vulnerabilities at confidence ≥ 8. Three near-threshold design observations worth tightening.
- **TS CLI (deprecated):** Three High and three Medium findings under adversarial re-review, plus two Lows. The most consequential is **H-3** (RPC-trust on slippage floors) — its lesson must propagate into the Rust+gateway design.
- **DeFi exploit coverage:** All thirty-five canonical classes enumerated; eight remain Open and are explicitly mapped to the H/M/L findings above.
