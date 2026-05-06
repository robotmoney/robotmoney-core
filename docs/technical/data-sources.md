# Robot Money — External Data Sources

> Scope: a complete inventory of every external data dependency in `@robotmoney/cli` and the `robotmoney-cli` skill — what is read, from where, how, and what happens when it is unavailable. Organised by source type: on-chain RPC reads, off-chain APIs, user/local state, and derived values. Gaps and underspecified dependencies are called out explicitly. Source references are to files in `packages/cli/src/` unless otherwise noted.

---

## 1. On-chain RPC reads (Base mainnet, chain id 8453)

All on-chain reads go through viem's public client. The RPC endpoint is resolved at call time: `--rpc-url` flag → `RPC_URL` env → fallback pool of five free Base endpoints (see §5). Reads are parallelised with `Promise.all` wherever there are no data dependencies between calls.

### 1.1 RobotMoneyVault (`lib/addresses.ts` → `ADDRESSES.base.vault`)

| Function | Returns | Used by |
|---|---|---|
| `asset()` | USDC address | `get-vault` |
| `totalAssets()` | Total USDC under management | `get-vault`, `get-apy` |
| `totalSupply()` | Total rmUSDC shares outstanding | `get-vault` |
| `balanceOf(user)` | User's rmUSDC share count | `get-balance`, `execute-*` (post-tx confirmation) |
| `convertToAssets(shares)` | Gross USDC value of shares (pre-fee) | `get-balance` |
| `previewRedeem(shares)` | Net USDC after exit fee | `get-balance` |
| `previewDeposit(assets)` | Shares that would be minted | `prepare-deposit` simulation |
| `maxDeposit(receiver)` | Cap headroom | `prepare-deposit` simulation |
| `maxRedeem(owner)` | Maximum redeemable shares | `prepare-redeem` |
| `paused()` | Operational pause state | `get-vault`, simulation error decoding |
| `shutdown()` | Permanent shutdown state | `get-vault`, simulation error decoding |
| `tvlCap()` | Maximum TVL in USDC | `get-vault` |
| `perDepositCap()` | Maximum single deposit in USDC | `get-vault` |
| `exitFeeBps()` | Exit fee in basis points | `get-vault` |
| `feeRecipient()` | Fee recipient address | `get-vault` |
| `adapterCount()` | Number of registered adapters | `get-vault`, `get-apy` |
| `getAdapterInfo(i)` | `(address, capBps, active, currentBalance, targetBps)` per adapter | `get-vault`, `get-apy` |

**Failure mode:** viem retries on the fallback pool. A persistent failure surfaces as a `COMMAND_FAILED` JSON error and non-zero exit.

### 1.2 USDC ERC-20 (`ADDRESSES.base.usdc` — Circle FiatTokenV2_2 proxy)

| Function | Returns | Used by |
|---|---|---|
| `symbol()` | `"USDC"` | `get-vault` metadata |
| `decimals()` | `6` | `get-vault` metadata |
| `balanceOf(user)` | User's USDC wallet balance | `lib/gas.ts` (internal, **not yet in any command output** — see §6.1) |
| `allowance(user, vault)` | USDC approval to vault | `prepare-deposit` (decides whether to include approve tx) |
| `allowance(user, Permit2)` | USDC approval to Permit2 | `lib/basket/leg-builders.ts` (basket buy path) |

**Special dependency — storage slot 10:** `lib/storage-slots.ts` derives the `allowed` mapping slot for the USDC FiatTokenV2_2 proxy implementation (`USDC_ALLOWANCE_MAPPING_SLOT = 10`). This slot is injected into `eth_call`'s `stateOverride` to simulate a deposit as if USDC were already approved, producing a correct gas estimate on first deposit. **This is an external assumption about Circle's proxy implementation.** If Circle upgrades the proxy and moves the mapping slot, simulation gas estimates will silently revert to the inaccurate pre-approval figure. There is no runtime verification that slot 10 remains correct.

### 1.3 Permit2 (`lib/basket/constants.ts` → `PERMIT2`)

| Function | Returns | Used by |
|---|---|---|
| `allowance(user, USDC, UniversalRouter)` | `(amount, expiration, nonce)` | `lib/basket/leg-builders.ts` — decides whether Permit2→UR approval tx is needed |

For basket sells, also:
- `allowance(user, <tokenAddress>, UniversalRouter)` for each basket token being sold.

Permit2 approvals are checked at prepare/execute time. If `amount < basketAllocation` or `expiration < now`, a `Permit2.approve(token, UR, MAX_U160, now+1year)` tx is prepended to the sequence.

### 1.4 Uniswap V3 QuoterV2 (`lib/basket/constants.ts` → `V3_QUOTER_V2`)

| Function | Returns | Used by |
|---|---|---|
| `quoteExactInput(path, amountIn)` | `(amountOut, sqrtPriceAfter[], ticksCrossed[], gasEstimate)` | `lib/basket/quoter.ts` — buy quotes for VIRTUAL, BNKR, JUNO, ZFI, GIZA; sell quotes for all 6 |

Called via `client.simulateContract` (nonpayable mutation simulated as a read). Returns a spot-price quote at current pool depth. **This is not a TWAP or oracle price** — it reflects instantaneous liquidity and can be gamed by MEV bots between quote and execution. The 5-minute `validUntil` window and 3% slippage tolerance are the only mitigations.

### 1.5 Uniswap V4 Quoter (`lib/basket/constants.ts` → `V4_QUOTER`)

| Function | Returns | Used by |
|---|---|---|
| `quoteExactInputSingle(poolKey, zeroForOne, exactAmount, hookData)` | `(amountOut, gasEstimate)` | `lib/basket/quoter.ts` — buy/sell quote for ROBOT (Doppler dynamic-fee hook) |

The ROBOT pool uses a V4 pool with a Doppler hook (`0xbB7784A4d481184283Ed89619A3e3ed143e1Adc0`) and `fee = 0x800000` (dynamic fee flag). The hook can set the effective fee up to 80% during volatility — this is why the default slippage is 3% rather than a tighter V3-appropriate value. The quote reflects the hook's current fee but not future fee changes between quote time and execution.

### 1.6 Aave V3 Pool (`ADDRESSES.base.aavePool`)

| Function | Returns | Used by |
|---|---|---|
| `getReserveData(USDC)` | Struct including `currentLiquidityRate` (ray, 1e27 scale) | `get-apy` — Aave adapter APY |

`currentLiquidityRate / 1e27` gives the annualised supply APY. Called with `.catch(() => null)`; if it fails, Aave is excluded from the blended APY and a warning is emitted.

### 1.7 Compound V3 Comet (`ADDRESSES.base.compoundComet` — cUSDCv3)

| Function | Returns | Used by |
|---|---|---|
| `getUtilization()` | Current utilisation ratio (1e18 scale) | `get-apy` |
| `getSupplyRate(utilization)` | Supply rate per second (1e18 scale) | `get-apy` — multiplied by seconds/year |

Both are called with `.catch(() => null)`; if either fails, Compound is excluded from the blended APY and a warning is emitted.

### 1.8 Basket token ERC-20s (6 tokens, `lib/basket/constants.ts` → `BASKET`)

| Function | Returns | Used by |
|---|---|---|
| `balanceOf(user)` per token | Token balance (native decimals) | `get-basket-holdings` |

Six parallel `balanceOf` calls. If `--no-pricing` is passed, quoter calls are skipped; balances are still read. Pricing uses the sell-side quoter (§1.4 / §1.5) to get a USDC value per token balance.

### 1.9 ETH balance and gas price

| Call | Returns | Used by |
|---|---|---|
| `client.getBalance({ address: user })` | User's ETH balance in wei | `lib/gas.ts` — pre-flight check in all `prepare-*` and `execute-*` |
| `client.getGasPrice()` | Current gas price in wei | `lib/gas.ts` — multiplied by estimated gas, padded 20% |

Gas price is padded by 20% (`gasPrice * 12n / 10n`) to account for in-flight price increases between estimate and broadcast. The pre-flight check warns when `ethBalance < 2x estimatedCost` and hard-errors when `ethBalance < 1x estimatedCost`.

**Note:** `client.getGasPrice()` returns a legacy gas price. For EIP-1559 transactions, the actual cost depends on `baseFeePerGas` + `maxPriorityFeePerGas`. Viem handles EIP-1559 automatically on broadcast, but the pre-flight check uses the simpler `getGasPrice()` estimate. Under high network congestion the actual fee can exceed the estimate; the 20% pad provides some buffer.

### 1.10 Gas estimation (`eth_estimateGas`)

All transactions in a sequence are estimated in a single up-front pass before any broadcast (`lib/execute.ts` — `signAndSendSequence`). Dependent transactions (`i > 0`) that fail estimation due to missing prior-tx state fall back to conservative ceilings provided by leg builders (1.5M gas for basket buys; 0.4M base + 0.4M per token for sells). State overrides are applied per-tx during estimation to handle allowance dependencies.

### 1.11 Simulation (`eth_call` with stateOverride)

`lib/simulate.ts` runs each unsigned transaction as an `eth_call` before including it in `prepare-*` output. For the vault deposit tx, `USDC_ALLOWANCE_MAPPING_SLOT` (slot 10) is injected to pre-approve the allowance in the simulated state, producing correct gas estimates and revert decoding on first deposit. See §1.2 for the storage-slot assumption risk.

---

## 2. Off-chain APIs

### 2.1 Morpho GraphQL API (`lib/morpho-apy.ts`)

| Endpoint | Purpose | Auth |
|---|---|---|
| `https://api.morpho.org/graphql` (primary) | `netApy` for Gauntlet USDC Prime vault | None |
| `https://blue.morpho.org/graphql` (fallback) | Same | None |

Query: `vaultByAddress(address, chainId)` → `state.netApy`.

The `netApy` field is Morpho's own calculated net APY after their protocol fees — it is **not** the gross supply rate. This is the most accurate single figure for the Morpho adapter's yield contribution.

**Failure handling:** 8-second timeout per endpoint. Primary tried first; if it returns null or times out, fallback is tried. If both fail, `netApy: null` is returned with a warning string, and the Morpho adapter is excluded from the blended APY calculation.

**Underspecified:** The Morpho API response contains no `updatedAt` or staleness timestamp. There is no way for the CLI to know whether the returned `netApy` reflects the current block or is several hours stale. Under market stress when APYs move rapidly, this staleness is material.

### 2.2 Delegated strategy APIs (ZYFAI, Giza)

**Status: not implemented in the CLI.** The website's allocation page tracks delegated USDC positions (~$4,500 each in ZYFAI and Giza as of 2026-04-14), but no CLI command reads from these sources. The API endpoints, auth mechanisms, response schemas, and freshness characteristics are undocumented in this repo.

This is a data-source gap that blocks `get-allocation` (see `docs/issues/issue-get-allocation-missing.md`). Until these are defined and implemented, the CLI cannot provide a complete portfolio view.

**Open questions:**
- Are positions readable on-chain (preferred — no third-party dependency) or only via proprietary APIs?
- What is the update frequency of balances and APY for each strategy?
- Is authentication required?

### 2.3 GeckoTerminal (website only, not in CLI)

The website's performance page fetches live price data from GeckoTerminal. The CLI does not use GeckoTerminal — it prices basket tokens via Uniswap on-chain quoters (§1.4, §1.5). These are different data sources with different characteristics: GeckoTerminal aggregates trades and shows market price; Uniswap quoters show the marginal fill price at a specific depth. For small basket allocations (5% of a $100–$5,000 deposit) the difference is immaterial; for larger positions it could diverge.

---

## 3. User and local state

### 3.1 OWS keystore (`~/.ows/wallets/` or `--storage-path`)

Read by `execute-*` and `create-wallet` via `@open-wallet-standard/core`. The keystore directory contains one file per wallet. `resolveWallet` in `lib/wallet.ts`:

1. If `--wallet <name>` is given: load that named wallet.
2. If no name given: list the directory; auto-pick if exactly one wallet exists; error with the list if multiple exist.
3. `owsCreateWallet` writes a new keystore entry.

**Underspecified:** OWS policy configuration (per-tx caps, allowlists, co-sign thresholds) is not read, set, or verified by any CLI command. See `docs/issues/issue-ows-policy-unenforced.md`.

### 3.2 Environment variables

| Variable | Read by | Default |
|---|---|---|
| `OWS_PASSPHRASE` | `lib/wallet.ts` `resolvePassphrase()` | Interactive TTY prompt |
| `RPC_URL` | `lib/rpc.ts` `resolveRpcUrl()` | Fallback pool |

Resolution ladders: `--passphrase` flag → `OWS_PASSPHRASE` env → interactive prompt. `--rpc-url` flag → `RPC_URL` env → pool.

### 3.3 Interactive TTY

`resolvePassphrase` prompts interactively if neither `--passphrase` nor `OWS_PASSPHRASE` is set. In non-interactive environments (CI, cron jobs, headless harnesses) this hangs indefinitely. Operators running autonomous deployments must supply the passphrase via env var or flag.

### 3.4 Harness-managed state (not owned by the CLI)

The following state is referenced in the user stories but is entirely the harness's responsibility — the CLI has no read or write path for any of it:

| State | Story | Where it lives |
|---|---|---|
| Working reserve amount (e.g. $1,000) | §4.1 | Harness config / env var |
| Postgres ops log (tx hashes, timestamps) | §4.1 | Harness database |
| Weekly NAV snapshot for diff computation | §4.1, §4.3 | Harness DB / Claude Code memory file |
| Local SQLite deposit ledger | §4.2 | Device filesystem |
| MQTT heartbeat target | §4.2 | Device config |
| Claude Code project memory file | §4.3 | `~/.claude/projects/<project>/memory/` |
| Cost basis per deposit | §4.1, §4.3 | **Nowhere** — underspecified gap (see §6.4) |

---

## 4. Derived / computed values

These are not external data sources but are computed from the above and are worth listing because they have their own accuracy assumptions.

| Value | Formula | Accuracy notes |
|---|---|---|
| Share price | `totalAssets × 1e6 / totalSupply` | Accurate at read time; no harvest lag (yield accrues live in adapters) |
| Blended APY | Mean of active adapter APYs, equal weight | Gross APY — management fee not subtracted (see §6.2) |
| Basket USDC allocation per leg | `depositAmount × 0.05 / 6` (default) | Uniform split; no governance-driven weighting yet |
| Slippage min amount out | `quotedAmountOut × (10000 − slippageBps) / 10000` | Applied uniformly across V3 and V4; V4 dynamic fee is not pre-known |
| Quote validity deadline | `block.timestamp + 300s` (5 minutes, `QUOTE_VALIDITY_MINUTES`) | Embedded as UniversalRouter `execute()` deadline |
| Permit2 approval expiration | `now + 1 year` | Max U160 amount with 1-year expiry on each Permit2 approval |
| Gas cost estimate | `estimateGas × getGasPrice × 1.2` | Legacy gas price padded 20%; EIP-1559 baseFee spikes not fully captured |

---

## 5. RPC fallback pool

`lib/rpc.ts` defines a pool of five free, no-auth Base mainnet endpoints:

```
https://base.drpc.org          (primary — OWS broadcast also falls back to this one)
https://base-rpc.publicnode.com
https://base.llamarpc.com
https://base.meowrpc.com
https://1rpc.io/base
```

viem's `fallback()` transport rotates through the pool with `retryCount: 2` per endpoint on 429, 5xx, or timeout. Individual endpoint timeout is 10 seconds.

**Underspecified / risks:**
- **No SLA.** All five are community-run free endpoints. Any of them can go offline, rate-limit aggressively, or return stale data without notice.
- **No authentication.** Requests are anonymous. Some endpoints may start requiring API keys.
- **OWS broadcast uses a single URL.** `resolveBroadcastRpcUrl` picks `BASE_RPC_POOL[0]` (`base.drpc.org`) as the OWS broadcast target because OWS's `signAndSend` takes a concrete URL. If drpc.org is down, broadcast fails even if read-path RPC is working.
- **No endpoint health monitoring.** The CLI does not pre-check endpoint health; it discovers failures at request time. For time-sensitive operations (execute-deposit during a market move), a slow primary endpoint adds latency.

---

## 6. Underspecified gaps

### 6.1 Wallet USDC and ETH balance not in command output

`USDC.balanceOf(user)` and `client.getBalance(user)` are both called internally (`lib/gas.ts`) but never emitted in command output. Story §4.1's sweep-trigger logic (`if usdcBalance > reserve + minDeposit`) has no CLI data to work with. See `docs/issues/issue-get-balance-wallet-context.md`.

### 6.2 Management fee and swap-fee share have no on-chain read path

`get-vault` returns `exitFeeBps` but not the management fee (2% annual) or the swap-fee share. Both are advertised on the website and required by PRD §5.4. Whether they are readable on-chain is unknown — `docs/technical/smart-contracts.md` §5.4 lists three plausible accrual implementations, none confirmed. `get-apy` therefore returns gross APY without management-fee drag. See `docs/issues/issue-get-vault-fees-incomplete.md`.

### 6.3 Governance and basket composition have no on-chain read path

Bucket weights, bucket-B/C constituent lists, active proposals, and vote history are not readable via any current CLI command. The basket is hardcoded in `lib/basket/constants.ts`. When governance votes change bucket composition, the CLI will continue buying the old basket until a new release is published. See `docs/issues/issue-get-governance-missing.md`.

### 6.4 User cost basis is never recorded

Stories §4.1 and §4.3 compute rolling returns against a "cumulative cost basis." The CLI emits USDC amounts at deposit/redeem time in `execute-*` output but has no mechanism to store them — there is no local ledger, no append-only log, no structured history. Each `execute-deposit` is a stateless call; the harness must record cost basis itself. This is not documented in SKILL.md or the reference files, meaning an LLM-operated harness has no guidance on how to track it.

### 6.5 Morpho APY staleness is undetectable

The Morpho GraphQL API returns `netApy` with no timestamp or cache-age header. The CLI cannot distinguish a freshly computed APY from one that is hours stale. Under high-volatility conditions, a stale APY could materially misrepresent the current yield to an agent making allocation decisions.

### 6.6 USDC storage slot assumption is silent

The `stateOverride` simulation depends on USDC's `allowed` mapping being at storage slot 10 of the Circle FiatTokenV2_2 implementation. This is verified at a point in time (see `lib/storage-slots.ts` comments) but is not re-verified at runtime. A Circle proxy upgrade that moves this slot would silently break first-deposit gas estimates with no CLI error — the simulation would revert on the synthetic allowance and the CLI would report a misleadingly small gas figure.

### 6.7 V4 dynamic fee is not pre-known for slippage calculation

The ROBOT pool's Doppler hook can set an effective fee up to 80% during high volatility. The V4 quoter returns an `amountOut` that reflects the hook's *current* fee, but the fee can change between quote time and execution. The 3% uniform slippage tolerance is a compromise: too tight for an 80%-fee spike, too loose for normal V3 conditions. There is no per-pool slippage tuning in the current interface.

### 6.8 Skill reference docs describe an incorrect RPC fallback

`plugins/robotmoney-cli/skills/robotmoney-cli/references/read.md` documents the `--rpc-url` flag as:

> "falls back to `RPC_URL` env, then `https://base.llamarpc.com`"

The actual code (`lib/rpc.ts`) uses a five-endpoint pool: `base.drpc.org` (primary), `base-rpc.publicnode.com`, `base.llamarpc.com`, `base.meowrpc.com`, `1rpc.io/base`. `llamarpc.com` is the third entry, not the sole fallback. An agent or operator debugging an RPC failure and relying on `read.md` would look for the wrong endpoint. This is a skill-file fix (out of scope for `docs/`) but is noted here as a data-provenance inaccuracy in the published reference. See `plugins/robotmoney-cli/skills/robotmoney-cli/references/read.md` line 8.

### 6.9 Delegated strategy data sources are entirely undefined

No endpoint URL, auth scheme, response schema, or freshness model is documented for the ZYFAI and Giza delegated-strategy APIs. `get-allocation` (when built) must specify these before implementation. On-chain reads should be preferred over proprietary APIs wherever available. See `docs/issues/issue-get-allocation-missing.md`.

---

## 7. Data-source summary table

| Data | Source type | Read by | Failure handling | Gap |
|---|---|---|---|---|
| Vault state (TVL, caps, fees, adapters) | On-chain RPC | `get-vault`, `prepare-*`, `execute-*` | viem fallback pool | Management fee + swap-fee share missing (§6.2) |
| User vault position (shares, NAV) | On-chain RPC | `get-balance` | viem fallback pool | `usdcBalance`, `ethBalance` missing (§6.1) |
| USDC wallet balance | On-chain RPC | `lib/gas.ts` (internal only) | n/a | Not in command output (§6.1) |
| USDC allowances | On-chain RPC | `prepare-deposit`, basket leg builders | viem fallback pool | — |
| Permit2 allowances | On-chain RPC | Basket leg builders | viem fallback pool | — |
| Basket token balances | On-chain RPC | `get-basket-holdings` | viem fallback pool | — |
| Basket buy/sell quotes | On-chain RPC (Uniswap quoters) | `prepare-*`, `execute-*` | Command aborts | Spot price only; V4 dynamic fee (§6.7) |
| Aave APY | On-chain RPC | `get-apy` | Excluded + warning | — |
| Compound APY | On-chain RPC | `get-apy` | Excluded + warning | — |
| Morpho APY | Off-chain GraphQL (2 endpoints) | `get-apy` | Excluded + warning | No staleness signal (§6.5) |
| ETH balance + gas price | On-chain RPC | `lib/gas.ts` | Command aborts | Legacy gas price only (§1.9) |
| Gas estimates | On-chain RPC (`eth_estimateGas`) | `lib/execute.ts` | Conservative fallback for dependent txs | — |
| Simulation results | On-chain RPC (`eth_call` + stateOverride) | `prepare-*` | Error decoded + surfaced | Slot 10 assumption (§6.6) |
| Delegated strategy positions | Off-chain API (ZYFAI, Giza) | **Not implemented** | n/a | Entirely undefined (§6.9) |
| Governance / basket composition | On-chain (future) / hardcoded (now) | **Not implemented** | n/a | Hardcoded; no read path (§6.3) |
| OWS wallet + key | Local keystore (`~/.ows/wallets/`) | `execute-*`, `create-wallet` | Named error | Policy not set/checked (§6; see issue) |
| OWS passphrase | Env var / flag / TTY | `execute-*` | Hangs in non-TTY | TTY hang in headless environments (§3.3) |
| User cost basis | **Nowhere** | Not implemented | n/a | Undocumented harness responsibility (§6.4) |

---

## 8. References

- RPC pool and transport: [`../../packages/cli/src/lib/rpc.ts`](../../packages/cli/src/lib/rpc.ts)
- Address constants: [`../../packages/cli/src/lib/addresses.ts`](../../packages/cli/src/lib/addresses.ts)
- Basket constants (hardcoded routes, quoter addresses): [`../../packages/cli/src/lib/basket/constants.ts`](../../packages/cli/src/lib/basket/constants.ts)
- Basket quoter (V3 + V4): [`../../packages/cli/src/lib/basket/quoter.ts`](../../packages/cli/src/lib/basket/quoter.ts)
- Morpho APY fetch: [`../../packages/cli/src/lib/morpho-apy.ts`](../../packages/cli/src/lib/morpho-apy.ts)
- Gas pre-flight check: [`../../packages/cli/src/lib/gas.ts`](../../packages/cli/src/lib/gas.ts)
- Simulation + stateOverride: [`../../packages/cli/src/lib/simulate.ts`](../../packages/cli/src/lib/simulate.ts)
- Storage slot derivation: [`../../packages/cli/src/lib/storage-slots.ts`](../../packages/cli/src/lib/storage-slots.ts)
- Smart contract analysis (fee accrual, governance gaps): [`smart-contracts.md`](smart-contracts.md)
- Open issues: [`../issues/`](../issues/)
