<!-- Canonical: research note (no decision, no status, no vendor commitment) on the
     Base/Coinbase B20 tokenized equities launched 2026-08-24, evaluated against the
     rmRWA vault stack. Decision rationale for the stack it is measured against lives in
     docs/adr/ADR-0006-despxa-rwa-vault-design.md (deSPXA asset, Chronicle NAV oracle,
     secondary-swap-only entry/exit, issuer freeze risk) and
     docs/adr/ADR-0010-unified-vault-architecture.md (one Vault, IPositionAdapter themes).
     (See also: docs/technical/unified-vault-spec.md §4.3/§4.3a/§4.4 — AssetPositionAdapter,
      residual vault-side price sanity check, oracle/emergency semantics;
      docs/technical/adapter-architecture.md — current IStrategyAdapter layer;
      docs/technical/prior-art-vault.md — comparison-document conventions;
      docs/technical/research-questions.md — the sibling open-analysis register;
      docs/prd.md §11.4 — rmRWA product surface.)
     Nothing here is a recommendation. Every claim carries a source or the token UNVERIFIED. -->

# Base / Coinbase B20 Tokenized Stocks — Research Note

> **What this is.** A fact-finding note, not a decision record. It establishes what is
> verifiable about the Coinbase tokenized equities launched on Base on 2026-08-24, and
> what integrating them would cost against the vault stack this repository already
> ships. It selects no design, endorses no vendor, and creates no obligation.
>
> **Verification convention.** A claim with a link was read from that source. A claim
> marked `UNVERIFIED` could not be settled from a public primary source and is either
> attributed to the issuer as a claim or left open in [§8](#8-open-questions). Contract
> and feed addresses are reproduced only from official documentation or a chain
> explorer read; none are inferred.
>
> **Repository line numbers** (`path:NN`) were read against this branch's base on
> `dev` (`10128971`, 2026-08-26) and are given so a claim about this codebase can be checked rather
> than taken on trust. Line numbers drift; the file and symbol names next to them
> are the durable anchor.
>
> **On-chain reads in this note were taken on 2026-08-25.** Supply and holder counts are
> point-in-time and will be stale by the time you read them; addresses and verification
> status are the durable part.

---

## 1. Asset inventory

Four US single-name equities launched on Base on 2026-08-24, issued as **B20** tokens —
an ERC-20 extension described in the Base integration docs
([docs.base.org](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base)).
The public announcement is at
[blog.base.org/tokenized-stocks](https://blog.base.org/tokenized-stocks) (that host
returns HTTP 403 to automated fetchers; an
[Arweave mirror](https://3t4q4ogpaqeei7gqd7j4zudwln527j7ci4gvhncvx4a6h435ssga.arweave.net/3PkOOM8ECER80B_TzNB2W3uvp-JHDVO0Vb8B4_N9lIw)
carries the same body).

### 1.1 Tokens

| Ticker | Underlying | Base address | Decimals | Supply (2026-08-25) | Holders | Source verified on BaseScan? |
| --- | --- | --- | --- | --- | --- | --- |
| `NVDAc` | NVIDIA Corporation | [`0xb20000000000000000000078ee7ce2fE4908108C`](https://basescan.org/token/0xb20000000000000000000078ee7ce2fE4908108C) | 8 | 10,178.5902 | 2,646 | **No** |
| `AAPLc` | Apple Inc. | [`0xb200000000000000000000C2e324d24d7eEcd1fb`](https://basescan.org/token/0xb200000000000000000000C2e324d24d7eEcd1fb) | 8 | 4,165.7299 | not read | **No** |
| `GOOGLc` | Alphabet Inc. | [`0xb2000000000000000000002D0BA3164cc74f58B7`](https://basescan.org/token/0xb2000000000000000000002D0BA3164cc74f58B7) | 8 | 4,336.6138 | 1,896 | **No** |
| `METAc` | Meta Platforms Inc. | [`0xb2000000000000000000008bC8786B856E61707C`](https://basescan.org/token/0xb2000000000000000000008bC8786B856E61707C) | 8 | 2,271.8851 | 1,051 | **No** |

Addresses are published in the
[Base integration docs](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base)
and each was independently confirmed on BaseScan to resolve to the named issuer and
ticker. **Decimals is 8, not 18** — read from the token pages, and materially different
from deSPXA's 18. See [§6](#6-stack-mapping) for why that single number breaks a
hardcoded scaling constant in this repo.

**None of the four token contracts has verified source on BaseScan** as of 2026-08-25.
Every statement in [§2](#2-the-b20-standard) and [§3](#3-transfer-restrictions-and-compliance)
about token behaviour is therefore read from issuer documentation, not from deployed
bytecode. That is the single most important caveat in this note.

### 1.2 Supporting contracts

| Role | Address | Verified source? | What was read |
| --- | --- | --- | --- |
| Coinbase `OracleRegistry` | [`0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD`](https://basescan.org/address/0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD#code) | **Yes** (solc 0.8.30) | `getOracleParams(address) → (uint256 multiplier, bool paused)`; `setOraclePaused(address,bool)`; OpenZeppelin `AccessControl` with `DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE`; event `OraclePausedSet(address indexed token, bool paused)` |
| Chainlink NVDA feed | [`0x04689a41629776563E6822F76f2e57D148d28513`](https://basescan.org/address/0x04689a41629776563E6822F76f2e57D148d28513) | **Yes** | `EACAggregatorProxy` (solc 0.6.6) — the standard Chainlink V3 aggregator proxy shape |

The `OracleRegistry` is the one piece of this system whose source can actually be read.
It is worth dwelling on: the per-token `multiplier` that [§2](#2-the-b20-standard) turns
on, and the `paused` flag that [§4](#4-pricing-and-oracle-behaviour) turns on, are both
stored there behind a role-gated setter, and both are readable by anyone.

### 1.3 Issuer, custodian, wrapper

- **Issuer:** Coinbase Onchain SPV Ltd, incorporated in Abu Dhabi Global Market (ADGM)
  on 2026-06-17, a subsidiary of Onchain Marketplace Holdings Limited, itself owned by
  Coinbase Global
  ([The Defiant](https://thedefiant.io/news/defi/coinbase-launches-tokenized-stocks-on-base)).
- **Custodian:** Alpaca Securities LLC, an SEC-registered broker-dealer, buying and
  custodying the underlying shares in segregated accounts per the NVDA prospectus filed
  with the ADGM FSRA (same source).
- **Backing and bankruptcy remoteness:** the issuer describes the tokens as "real shares,
  held 1:1 by a regulated custodian" in a "bankruptcy-remote structure supervised by
  Abu Dhabi Global Market's (ADGM) regulatory authority"
  ([blog.base.org](https://blog.base.org/tokenized-stocks)). This is an **issuer claim
  about an off-chain legal structure**. It is not observable on-chain and this note does
  not corroborate it: `UNVERIFIED`. The prospectus filed with the FSRA is the document
  that would settle it, and it was not read for this note.
- **Creation / redemption fees:** 1 bp on creation, 5 bps on redemption
  ([The Defiant](https://thedefiant.io/news/defi/coinbase-launches-tokenized-stocks-on-base)).
  Both are Authorized-Participant flows — see [§3](#3-transfer-restrictions-and-compliance).
- **Expanded issuer list:** the primary source now enumerates **nine names beyond the
  four launch tickers** — `AMZNc`, `COINc`, `CRCLc`, `INTCc`, `MSFTc`, `MSTRc`, `SNDKc`,
  `SPCXc`, `TSLAc` — thirteen in all, each with a contract address in the same `0xb2…`
  vanity range and a Chainlink feed
  ([docs.base.org tokenized-stocks](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base),
  read 2026-08-25). The issuance mechanism is the same B20 path through the same SPV, and
  per-asset depth for anything outside the four launch tickers stays out of scope for this
  note — the names are recorded here, not analysed. Which *further* names come after these
  thirteen, and on what schedule, remains `UNVERIFIED`.

---

## 2. The B20 standard

Source for this section unless otherwise noted:
[docs.base.org tokenized-stocks](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base).
Read from documentation, not from deployed source ([§1.1](#11-tokens)).

### 2.1 Interface surface

On top of plain ERC-20 (`name`, `symbol`, `decimals`, `approve`, `transfer`,
`transferFrom`), B20 documents:

| Function | Purpose |
| --- | --- |
| `multiplier()` | current redemption ratio, WAD-scaled (18 dp) |
| `WAD_PRECISION()` | returns `1e18` |
| `scaledBalanceOf(account)` | raw balance × multiplier ÷ `WAD_PRECISION` |
| `toScaledBalance(raw)` / `toRawBalance(scaled)` | unit conversion helpers |
| `updateUIMultiplier()` | schedule a future-dated multiplier change (documented as ERC-8056) |
| `updateMultiplier()` | instant multiplier change; documented as a "deprecated emergency failsafe" |
| `cancelUIMultiplierUpdate()` | clear a pending scheduled change |
| `isAuthorized(policyID, account)` | policy/compliance check ([§3](#3-transfer-restrictions-and-compliance)) |
| `pause()` | function-level pauses |
| `transferWithMemo` / `transferFromWithMemo` | memo attachment |
| `extraMetadata(key)`, `contractURI()`, `updateName()`, `updateSymbol()` | mutable on-chain metadata (ERC-7572) |

Events: `B20Created`, `MultiplierUpdated`, `Announcement` / `EndAnnouncement`, `Memo`,
and standard ERC-20 `Transfer`.

Authority: `updateMultiplier` is documented as `OPERATOR_ROLE` and executes immediately.
The docs are explicit that **"the B20 standard has no built-in timelock"** and that the
`Announcement` / `EndAnnouncement` events are "public notice, not an enforced delay" —
any delay is applied by the issuer at its own governance layer. `UNVERIFIED` what
governance the issuer actually applies to `OPERATOR_ROLE` on the four launch tokens,
because the token source is unverified and the role holders cannot be enumerated.

### 2.2 The multiplier is not a rebase — and that matters

The announcement's phrasing is that "dividends and splits are handled by an onchain
multiplier, so balances never change and DeFi positions don't break"
([blog.base.org](https://blog.base.org/tokenized-stocks)). Read literally against the
interface above, this is the **opposite** of a rebasing token: `balanceOf` returns raw
units and is untouched by a corporate action. What changes is how many underlying shares
one raw unit represents, and — critically — what one raw unit is worth:

```
Scaled shares = raw B20 balance × multiplier ÷ WAD_PRECISION
Token price   = underlying equity market price × multiplier
```

So a corporate action moves value into a vault **through the price feed, not through the
balance**. This is the single most consequential fact for ERC-4626 accounting, and it is
easy to get backwards: a naive reading of "rebasing" would send you hunting for balance
drift that never happens, while the actual hazard sits in the oracle read.

### 2.3 Can a multiplier update move vault NAV between blocks with no transfer?

**Yes, on the dividend path.** Trace the existing NAV chain in this repo and substitute a
Chainlink B20 feed for Chronicle:

`BasketVault.totalAssets()` (`contracts/vaults/BasketVault.sol:486`) →
`DeSpxaAssetPositionAdapter.totalAssets()`
(`contracts/adapters/DeSpxaAssetPositionAdapter.sol:303-308`) →
`IERC20(TOKEN).balanceOf(address(this))` × `SWAP_ADAPTER.twapPrice(...)` →
`ChronicleOracleAdapter.twapPrice()` (`contracts/adapters/ChronicleOracleAdapter.sol:204`)
→ `ORACLE.latestAnswer()`.

`balanceOf` is constant across a multiplier update. `latestAnswer()` is not: on a
dividend the multiplier steps up (the docs' worked example is `1.02`) with the underlying
equity price unchanged, so the token price — and therefore `totalAssets()` — steps up in
the block the feed publishes it. No `Transfer` event fires. No vault function is called.
Vault NAV moves.

**On the split path it is designed to be NAV-neutral**: the docs state the multiplier and
the underlying price move inversely, so there is "no price discontinuity". That neutrality
is enforced entirely off-chain. The multiplier lives in the `OracleRegistry`
([§1.2](#12-supporting-contracts)); the equity price comes from Chainlink's node set; the
only thing binding them is the documented fail-safe that the feed "resumes only after
Coinbase confirms the underlying price and multiplier both reflect the new values". If
that synchronization ever slipped, a 4:1 split would mis-mark NAV by 4× for the duration
of the slip. Nothing on-chain prevents it and nothing on-chain detects it.

`UNVERIFIED` whether the multiplier can ever step **down**. Dividends step it up and
splits step it up against an inversely-moving price; no downward case is documented. But
`updateMultiplier()` is an instant, untimelocked `OPERATOR_ROLE` write, so a downward step
is reachable by the issuer at will, and a vault must be built as if it can happen.

### 2.4 Consequences for ERC-4626 share accounting and previews

`BasketVault` derives every ERC-4626 quantity from `totalAssets()`, so a NAV step
propagates everywhere at once:

- **`previewDeposit`** discounts the deposit by `maxSlippageBps` and converts to shares
  (`contracts/vaults/BasketVault.sol:736`, `maxSlippageBps` at
  `contracts/vaults/BasketVault.sol:179`, documented as "a floor, not an exact quote"). A
  preview taken before the step and executed after it mints **fewer** shares than
  previewed. That is not a loss — the shares are worth more — but any client, test, or
  acceptance criterion that asserts preview equals realized will fail intermittently, at
  a cadence set by the dividend calendar rather than by anything in the codebase.
- **`previewRedeem`** (`contracts/vaults/BasketVault.sol:716`) returns
  `TWAP NAV × (1 − maxSlippageBps) × (1 − exitFeeBps)` (`exitFeeBps` at
  `contracts/vaults/BasketVault.sol:177`). An
  upward step leaves realized proceeds above the previewed floor, which is the benign
  direction. A downward step ([§2.3](#23-can-a-multiplier-update-move-vault-nav-between-blocks-with-no-transfer))
  would put realized proceeds **below** a floor the user was shown, which is the
  direction that matters.
- **`AssetPositionAdapter` NAV reporting** needs no code change to *observe* the step —
  `totalAssets()` already re-reads the oracle on every call. The problem is that nothing
  distinguishes a legitimate 2% dividend step from a 2% oracle malfunction. Both are
  "NAV jumped with no trade".
- **The NAV-deviation guard never reads the mark.** The chain
  `BasketVault.navDeviationGuardBps` (`contracts/vaults/BasketVault.sol:213`) →
  `BasketViews.checkNavDeviation` (`contracts/lib/BasketViews.sol:82`) →
  `TwapTickMath.requireWithinDeviation` (`contracts/lib/TwapTickMath.sol:99`) is named as though it cross-checked NAV against a
  market price. It does not. `TwapTickMath.deviationBps`
  (`contracts/lib/TwapTickMath.sol:74-91`) prices one probe amount **twice against the
  same pool** — once at that pool's `slot0()` spot tick, once at its `observe()`
  arithmetic-mean tick over `effectiveTwapWindow` — and returns `|spot − twap| / twap` in
  basis points. `priceFromTick` is linear in the probe amount, so the probe divides out of
  the ratio entirely; the helper's own NatSpec documents the probe as an amount priced
  both ways where "decimals cancel in the ratio". The three
  `AssetPositionAdapter`s make that explicit by passing a hardcoded
  `NAV_DEVIATION_PROBE = 1e18` into the same helper, commented as being "used only for the
  ORA-4 spot-vs-TWAP divergence ratio"
  (`contracts/adapters/UniswapV3AssetPositionAdapter.sol:73`, passed at line 210;
  `contracts/adapters/AerodromeAssetPositionAdapter.sol:79`). The probe is a magnitude
  device, not a price input. `BasketViews.checkNavDeviation` merely happens to source its
  probe from `vault.assetTokenValue(i, 1e6)` (`contracts/lib/BasketViews.sol:92`) — itself a TWAP quote — and no oracle or NAV
  value survives into the comparison.
- **So the guard is blind to a multiplier-driven NAV step.** For an oracle-priced position
  — deSPXA today, a Chainlink-priced B20 tomorrow — this is a pool-internal spot-vs-TWAP
  sanity check on a single venue. A multiplier update moves the reported mark without
  touching either side of that comparison, so **a corporate action does not trip this
  guard through the oracle at all**. What a corporate action *would* eventually move is
  the pool's own spot against its own TWAP window (30 minutes by default), if and when
  traders reprice the pool after the multiplier lands — a weaker, slower and
  venue-dependent claim than "deposits halt on a routine corporate action", and one that
  rests on pool behaviour this note has not observed. The guard's ceiling is
  `MAX_NAV_DEVIATION_BPS = 2_000` (20%, `contracts/vaults/BasketVault.sol:219`); it is
  entry-side only (invoked once on the deposit path at
  `contracts/vaults/BasketVault.sol:565`, plus each adapter's own entry leg) and is
  disabled at `0` by default.
- **The successor guard has the same shape.** `docs/technical/unified-vault-spec.md`
  §4.3a commits the unified vault to a residual, adapter-independent **aggregate NAV
  growth-rate limiter** (`maxNavGrowthRateBps`) on the deposit path, precisely because a
  self-pricing adapter checking its own deviation is not a second opinion. A legitimate
  dividend step is exactly the signature that limiter is built to reject. Any B20
  integration inherits an unresolved calibration problem: distinguish "scheduled
  corporate action" from "mis-scaled mark" without a second oracle. This note does not
  solve it; see [§8](#8-open-questions).
- **Market hours compound it.** Because the feed does not publish outside
  [market hours](#4-pricing-and-oracle-behaviour), a corporate action processed while the
  market is closed lands as a *single* step at the next open, stacked on top of whatever
  the overnight equity move was. The two are indistinguishable to every guard above.

### 2.5 Cached and indexed balances

The explorer keeps two derived numbers, and the multiplier hits exactly one of them:

- **`wallet_positions`** stores a per-event resulting balance snapshot in raw share units
  (`services/explorer-indexer/src/db.rs`, IDX-3). Raw units are multiplier-invariant, so
  these stay correct. Nothing to do.
- **`vault_snapshots`** stores `total_assets` / `total_supply` read from the vault, written
  on vault events plus a `SNAPSHOT_HEARTBEAT_BLOCKS = 7200` block heartbeat
  (`services/explorer-indexer/src/lib.rs:52`) — roughly four hours at Base block times.
  `clients/explorer-api/src/model.rs::VaultPosition.usdc_value`
  (`clients/explorer-api/src/model.rs:397-399`) is computed from that
  snapshot as `shares * total_assets / total_supply`. **A multiplier update emits no vault
  event**, so the displayed USD value lags real NAV by up to one heartbeat with no
  triggering signal — the indexer has no reason to know anything happened.
- **A stale feed makes it worse.** When `totalAssets()` reverts `StalePriceFeed`,
  `snapshot_vault_or_skip` (`services/explorer-indexer/src/indexer.rs:405`) logs and skips by
  design (issue #878), leaving the previous row in place. Over a weekend the explorer
  keeps serving Friday's TVL, distinguishable only by the `Freshness` envelope and the
  snapshot's `block_number`.

A B20 integration would need either a `MultiplierUpdated` watcher driving a re-snapshot,
or an explicit staleness marker on `usdc_value`. Neither exists today.

---

## 3. Transfer restrictions and compliance

**Read this section's caveat first.** The acceptance criterion for this note was to read
restrictions from deployed contract source rather than marketing copy. That was attempted
and **failed**: none of the four token contracts has verified source on BaseScan as of
2026-08-25 ([§1.1](#11-tokens)). What follows is therefore documentation and issuer
claims, labelled as such. The only compliance-adjacent contract whose source could be
read is the `OracleRegistry` ([§1.2](#12-supporting-contracts)), which governs pricing,
not transfers.

### 3.1 What the documentation describes

Per [docs.base.org](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base):

| Control | Documented behaviour |
| --- | --- |
| Allowlist / blocklist | managed through `isAuthorized(policyID, account)`; blocked transfers **revert on-chain** |
| `approve()` | explicitly **not** policy-gated — "checking whether a quantity of funds is approved to be transferred does not guarantee that the funds aren't blocked by a policy" |
| Pause | **function-level** pauses are available; integrators are told to monitor them to track transfer availability |
| Supply cap | optional cap bounding total supply against over-minting |
| Mint / redeem | restricted to Authorized Participants; KYC happens only in those flows |
| Secondary market | "holding and trading on the secondary market is permissionless" |

### 3.2 The "no whitelisted wallets" claim

The announcement says holders get "standard tokens: hold, transfer, and trade, with no
whitelisted wallets and no platform lock-in"
([blog.base.org](https://blog.base.org/tokenized-stocks)). The integration docs
simultaneously describe a policy engine that **supports** allowlists and blocklists.

These reconcile only if the policy set is currently empty or permissive for the four
launch tokens. Whether it is, who holds the authority to change it, and how quickly a
change takes effect are all `UNVERIFIED` — the contract source is unpublished, so the
policy IDs and their configured membership cannot be enumerated, and the role holders
cannot be read. The honest framing: **the issuer states there are no whitelisted wallets
today; the documented interface reserves the ability to introduce them, with no
on-chain timelock ([§2.1](#21-interface-surface))**.

### 3.3 What each control would do to a vault position

The shape is already familiar to this repository. `contracts/vaults/RwaVault.sol` and
`contracts/adapters/DeSpxaAssetPositionAdapter.sol` both carry the deSPXA issuer
freeze-control disclosure from ADR-0006 §4, and the analysis transfers almost unchanged:

- **A blocklist entry naming the adapter address, or a transfer pause**, makes `deploy`
  and `withdraw` revert at the ERC-20 layer, because both route a swap. Deposits and
  redemptions halt for every holder simultaneously.
- **`totalAssets()` keeps working.** `DeSpxaAssetPositionAdapter.totalAssets()` is a
  `balanceOf` read plus a view-only oracle read and never attempts a transfer, so a
  freeze cannot brick NAV summation. This is the "excluded-not-confiscated" posture the
  adapter's NatSpec already documents. Shares are retained; nothing is seized.
- **The genuinely new wrinkle is granularity.** deSPXA's freeze is binary. B20 documents
  *function-level* pauses, which admits states deSPXA never produced — for instance
  `transfer` paused while `transferFrom` is not. A vault whose entry leg survives and
  whose exit leg does not is strictly worse than a clean two-sided halt, because it keeps
  accepting deposits into a position nobody can leave. `UNVERIFIED` which functions are
  individually pausable and whether any deployed configuration currently splits them;
  this is the highest-value item in [§8](#8-open-questions).
- **`approve()` is not policy-gated**, so an adapter's `forceApprove` succeeds and the
  subsequent `swap` reverts. Failure surfaces one call later than a reader might expect —
  worth knowing when reading a revert trace, though it changes no outcome.

### 3.4 What the non-US eligibility restriction does and does not mean

Both official sources state the tokens are "only available to persons in eligible
jurisdictions outside of the U.S."
([docs.base.org](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base),
[base.org/stocks](https://www.base.org/stocks)).

Plainly, for a permissionless contract:

- It is a **distribution restriction on the issuer's own onboarding and on the
  Authorized-Participant mint/redeem path**, not an on-chain transfer gate. A smart
  contract has no jurisdiction and passes no eligibility check.
- An ERC-4626 vault holding B20 tokens therefore inherits **no on-chain restriction**.
  The secondary transfer is documented as permissionless and, per [§3.2](#32-the-no-whitelisted-wallets-claim),
  no allowlist is claimed to be active.
- What it does raise is a **product** question about who a vault's depositors are and how
  the product is marketed — which is a legal question, not an engineering one.
  Determining RobotMoney's own position on it is explicitly out of scope for this note,
  and nothing here should be read as legal advice or as an assertion of a compliance
  posture.

---

## 4. Pricing and oracle behaviour

Chainlink was named the official oracle infrastructure for Coinbase tokenized stocks on
2026-08-24
([PRNewswire](https://www.prnewswire.com/news-releases/coinbase-selects-chainlink-to-bring-new-tokenized-stocks-to-millions-of-defi-users-302858414.html)).
Chainlink publishes the feed family as "Base Tokenized Equities (Coinbase B20)"
([docs.chain.link](https://docs.chain.link/data-feeds/tokenized-equity-feeds/coinbase)).

**This section is the central open risk in the note.** Everything else is a cost estimate;
this is a structural mismatch between what a 24/5 equity feed does and what the
fail-closed freshness rules in this repository assume.

### 4.1 The feed surface

| Ticker | Chainlink aggregator on Base |
| --- | --- |
| Coinbase NVDA | [`0x04689a41629776563E6822F76f2e57D148d28513`](https://basescan.org/address/0x04689a41629776563E6822F76f2e57D148d28513) |
| Coinbase AAPL | `0x787f13dEa48Db0897CbCDD985de77809D837F988` |
| Coinbase GOOGL | `0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2` |
| Coinbase META | `0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D` |

Addresses from
[docs.base.org](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base).
The NVDA address was confirmed on BaseScan to be a verified `EACAggregatorProxy` — the
standard Chainlink V3 aggregator shape, so `latestRoundData()` / `updatedAt` are
available as expected. The **ticker-to-address binding for the other three was not
independently confirmed on-chain**: `UNVERIFIED`. Do not pin any of these into
`config/dex-pools.json` or a constructor without reading `description()` on-chain first —
ADR-0006 §5 already makes exactly this demand of deSPXA's addresses, and the demand
applies with equal force here.

Characteristics, per the Base and Chainlink docs:

- **8 decimals** on the answer. Same as the token; both differ from Chronicle's 18.
- **Total-return values**, not raw equity prices: the answer already folds in the
  multiplier and corporate-action adjustments (`Token Price = Underlying Equity Market
  Price × Multiplier`, [§2.2](#22-the-multiplier-is-not-a-rebase--and-that-matters)).
- The feed **reads the multiplier and the pause flag from the Coinbase `OracleRegistry`**
  ([§1.2](#12-supporting-contracts)).
- **During market hours:** updates on 0.5% price deviation or at least every 24 hours
  (heartbeat).

### 4.2 What the feed does when the market is closed

Verbatim from
[docs.chain.link](https://docs.chain.link/data-feeds/tokenized-equity-feeds/coinbase):

> "When underlying equity markets are closed (weekends, holidays, thin overnight windows),
> the feed holds the last close even though the contract remains callable via
> `latestRoundData()`. **These feeds do not have heartbeats during off-hours.**"

And for corporate actions:

> "Paused mode (`paused == true`): The feed stops publishing new prices and holds the last
> known good value."

Base's integration docs add that during a pause the "token remains transferable onchain"
while mint/redeem pauses off-chain, that `updatedAt` "stops advancing while the contract
stays callable", and warn integrators: **"Always read `updatedAt` and apply staleness
bounds before relying on the price; never settle or liquidate against a frozen feed."**

The schedule is **24/5** — regular, pre-market, post-market and overnight sessions
(Chainlink), while the tokens themselves trade **24/7**: "Trade tokenized stocks any hour
of any day, including weekends and US market holidays"
([base.org/stocks](https://www.base.org/stocks)). Press coverage names the resulting gap
directly: the tokens "can trade around the clock, including weekends and market holidays,
but Chainlink classifies the feeds as 24/5", so "a weekend decentralized-exchange price
can therefore move while the oracle remains fixed"
([FinanceFeeds](https://financefeeds.com/coinbase-uses-chainlink-to-price-four-stock-tokens-as-aave-lending-waits-for-v4/)).

`UNVERIFIED`: the exact session boundaries (the precise Friday-close and Sunday-open
timestamps of the 24/5 window), and the maximum duration Coinbase holds `paused == true`
through a corporate action. Both are needed to size any staleness bound and neither is
published in a form this note could read.

### 4.3 Against `ChronicleOracleAdapter` and the fail-closed freshness rules

The repo's existing rules, all fail-closed by deliberate design:

| Rule | Where | Value |
| --- | --- | --- |
| `_checkOracleFreshness()` reverts `StalePriceFeed` when `block.timestamp > updatedAt + heartbeat` | `contracts/vaults/RwaVault.sol:235`, `contracts/adapters/DeSpxaAssetPositionAdapter.sol:345` | — |
| `DEFAULT_HEARTBEAT` | `RwaVault.sol:114`, `DeSpxaAssetPositionAdapter.sol:88` | **24 hours** |
| `MAX_HEARTBEAT` (admin ceiling, a `constant`) | `RwaVault.sol:109`, `DeSpxaAssetPositionAdapter.sol:84` | **48 hours** |
| `MIN_HEARTBEAT` | `DeSpxaAssetPositionAdapter.sol:79` | 1 hour |
| Applies to | `deploy`, `withdraw`, and `totalAssets()` when the position is non-empty (ORA-2) | — |
| Zero-balance short-circuit | `RwaVault._holdsPricedRwa()` (`contracts/vaults/RwaVault.sol:222`) / adapter SUP-5 (`DeSpxaAssetPositionAdapter.sol:305`) | skips the oracle when nothing is held |
| Price sanity band | `ChronicleOracleAdapter.MIN_NAV = 1e12`, `MAX_NAV = 1e24` (`contracts/adapters/ChronicleOracleAdapter.sol:64`, `:72`; enforced at `:220`) | reverts `BadNavPrice` outside |

Those constants were chosen for a Chronicle NAV push feed, which updates roughly daily
and has **no scheduled multi-day gap**. A 24/5 equity feed has one every single week.
Substituting a Chainlink B20 feed into this machinery, unchanged, gives:

1. **At the 24-hour default, the vault reverts for most of every weekend.** By Saturday
   evening `updatedAt` is more than 24 hours old, so `totalAssets()` reverts
   `StalePriceFeed` and, with it, every deposit, redemption and preview — because
   `BasketVault` prices all of them from `totalAssets()`. The failure is not local to one
   adapter.
2. **At the 48-hour ceiling, ordinary weekends sit right at the boundary and every
   three-day US market holiday exceeds it.** A Friday-close-to-Tuesday-open gap runs
   past 48 hours on the wall clock.
3. **No admin setting fixes this.** `MAX_HEARTBEAT` is a Solidity `constant` in both
   `RwaVault` (`contracts/vaults/RwaVault.sol:109`) and `DeSpxaAssetPositionAdapter`
   (`contracts/adapters/DeSpxaAssetPositionAdapter.sol:84`); widening it is a redeploy, not a
   governance action. Whether it *should* be widened is precisely the question this note
   declines to answer — a longer bound trades a weekly halt for a weekly window of
   trading against a mark up to three days old.
4. **The zero-balance short-circuit does not rescue it.** `_holdsPricedRwa()` only helps
   after the basket has been fully unwound to idle USDC. A funded vault holds a priced
   balance and takes the revert.

### 4.4 Against the emergency-unwind floors

`RwaVault.emergencyUnwind()` (`contracts/vaults/RwaVault.sol:277`) and
`emergencyUnwindWithOverride()` (`:285`) call `_guardEmergencyFreshness()` (`:270`),
which reverts on a stale feed **unless** `emergencyUnwindStaleOverride` (`:250`) has been
armed. That flag is `ADMIN_ROLE`-gated while the
unwind itself is `EMERGENCY_ROLE` — a deliberate two-key split (audit 2026-06-19 F-08) so
that one compromised hot key cannot both authorize stale pricing and dump the basket
against it.

With a 24/5 feed, that flag is no longer an exceptional measure. There is a standing
multi-day stale window every week, so **any weekend incident response requires arming the
stale override** — meaning selling into a live 24/7 DEX at a Friday-close mark. The whole
defence then collapses onto `EmergencyUnwindGuard.minUsdcOut` and `maxLossBps`
(`contracts/vaults/BasketVault.sol:155`), both of which are reference floors calibrated
against a mark that is, by construction, stale. `docs/technical/unified-vault-spec.md`
§4.4 already moves the stale-price override to an atomic `EMERGENCY_ROLE` arm-and-execute
(M-S5) so an incident is never blocked by ADMIN latency; that makes the weekend response
*faster* but does not make the mark *fresher*.

### 4.5 The Monday-open squeeze

Over a weekend the mark is frozen at Friday's close while the Aerodrome pool trades on
through real news, so by Monday the reported NAV and the executable price have drifted
apart on whatever moved the stock. The uncomfortable part is that **nothing in the built
stack measures that drift**: the deviation guard and the freshness guard bind at the same
moment, on two different quantities, and neither is a cross-check on the other.

`navDeviationGuardBps` measures something internal to the pool
([§2.4](#24-consequences-for-erc-4626-share-accounting-and-previews)): at the open, spot
moves faster than the pool's own mean tick over the TWAP window, so `|spot − twap|` spikes
on Monday-morning pool volatility — whether or not the feed has published, and regardless
of where the mark sits. The freshness guard measures the feed's age
([§4.3](#43-against-chronicleoracleadapter-and-the-fail-closed-freshness-rules)) and
nothing else. So with `navDeviationGuardBps` armed the deposit path can halt on ordinary
open-auction churn, while the stale mark it is assumed to be guarding against goes
unexamined; with it at `0`, the vault mints against Friday's mark once the feed's
staleness bound is satisfied, while the market has moved. Neither setting is a good
answer, and the mark-versus-market gap that actually matters at Monday's open is measured
by neither. What to do about that is a design decision, and this note does not make it —
see [§8](#8-open-questions) and [§9](#9-integration-options-and-trade-offs).

### 4.6 Live external-feed work already in flight

Open issues **#1185** (ADR) and **#1186** (implementation) are the repository's live
external-feed NAV seam: they record that the Uniswap V4 `AssetPositionAdapter` becomes
router-eligible priced by an **external Chronicle-style push feed with a
staleness/deviation guard** — explicitly reusing the deSPXA oracle pattern — rather than
an on-chain pool oracle. A Chainlink B20 feed is the same shape: a push feed read for NAV
behind a staleness bound. Whether any B20 work should land on that seam, on a separate
path, or nowhere at all is a design decision this note does not make
([§9](#9-integration-options-and-trade-offs)); what is recorded here is only that the seam
exists, is live, and has the shape a B20 feed would need. What B20 adds beyond what a
crypto-asset feed needs is the
**scheduled off-hours gap** ([§4.2](#42-what-the-feed-does-when-the-market-is-closed)) and
the **registry pause flag** ([§1.2](#12-supporting-contracts)) — two inputs #1185/#1186 do
not currently contemplate. Recording that gap is the point; proposing a competing design
is not.

---

## 5. Liquidity and entry/exit

### 5.1 Venues at launch

[base.org/stocks](https://www.base.org/stocks) lists a long integration roster; the ones
that matter for a hold-and-swap vault are **Aerodrome** (spot AMM liquidity), **0x**,
**1inch**, **KyberSwap** and **CoW Swap** (routing/aggregation), **Aave**, **Morpho** and
**Euler** (lending), and **Wasabi** (perpetuals and options).

Lending support is not uniformly live: Aave's deployment "remains in a governance and
risk-configuration process rather than a live stock-collateral market", while trading
through 1inch on Base is operational
([FinanceFeeds](https://financefeeds.com/coinbase-uses-chainlink-to-price-four-stock-tokens-as-aave-lending-waits-for-v4/)).

### 5.2 Observed depth

Aerodrome holds the deepest pool for each of the four tokens, measured late on
2026-08-24 ([The Defiant](https://thedefiant.io/news/defi/coinbase-launches-tokenized-stocks-on-base)):

| Token | Deepest pool | Liquidity |
| --- | --- | --- |
| `NVDAc` | Aerodrome | $957,307 |
| `AAPLc` / `GOOGLc` / `METAc` | Aerodrome | between ~$619,000 and ~$669,000 each |
| **All four combined** | — | ~$3.06M DEX liquidity against ~$4.55M total on-chain value |

For scale, `config/dex-pools.json` pins the deSPXA/USDC Uniswap V3 0.01% pool at roughly
$3.6M TVL. **Each individual B20 name has between a sixth and a quarter of the depth
behind the single asset rmRWA holds today, and the four together are slightly less than
that one pool.** These are day-one figures on a day-one product and should be re-measured
before they are relied on.

### 5.3 Is an ADR-0006-equivalent hold-and-swap model viable per asset?

**Structurally yes; at meaningful size, unproven.**

What transfers cleanly from ADR-0006:

- Primary mint/redeem is closed to a permissionless contract — AP-only and KYC-gated
  ([§3.1](#31-what-the-documentation-describes)) — exactly as deSPXA's ERC-7540 primary
  NAV path is. The conclusion is identical even though the mechanism differs: **secondary
  swap is the only available entry and exit.**
- The secondary transfer is permissionless, and the venue is an Aerodrome pool, which
  `ChronicleOracleAdapter` and `AerodromeAssetPositionAdapter` already know how to route
  through.

What does not transfer:

- **Per-swap sizing.** `RwaVault._DEFAULT_SLIPPAGE_BPS` (`contracts/vaults/RwaVault.sol:102`)
  is 50 bps (0.5%), deliberately
  tighter than the DEX-TWAP adapters because slippage is anchored to a NAV mark rather
  than a pool TWAP. Against a $619k–$957k pool that caps a single swap at a notional this
  note did **not** measure — the answer depends on the pool's curve and concentration,
  which were not read on-chain. `UNVERIFIED`, and listed in [§8](#8-open-questions). It
  should be measured, not estimated, before any sizing claim is made.
- **No aggregator seam exists.** `IBasketSwapAdapter` implementations route a single
  direct pool hop — `ChronicleOracleAdapter.swap` builds a one-element
  `IAerodromeRouter.Route[]` (`contracts/adapters/ChronicleOracleAdapter.sol:167-169`). The 0x / 1inch / CoW routing that makes these tokens liquid
  in practice is not reachable from the current adapter interface.
- **The floor is anchored to the wrong clock.** `DeSpxaAssetPositionAdapter.withdraw`
  (`contracts/adapters/DeSpxaAssetPositionAdapter.sol:248`) derives `internalFloor` from
  `SWAP_ADAPTER.twapPrice(...)` at `:277`, i.e. from the oracle mark.
  Outside [market hours](#42-what-the-feed-does-when-the-market-is-closed) that mark is
  frozen while the pool trades on. A min-out floor computed from Friday's close is not a
  floor against Saturday's market — in either direction.

---

## 6. Stack mapping

Each seam marked **reusable** (works as-is), **extend** (shape is right, values or
inputs change), or **replace** (the mechanism does not carry).

| Seam | File / symbol | Verdict | Why |
| --- | --- | --- | --- |
| Position-adapter interface | `contracts/interfaces/IPositionAdapter.sol`, ADR-0010 §4 | **reusable** | `deploy` / `withdraw` / `totalAssets` / `isExact` describe a swap-and-custody B20 position exactly as they describe deSPXA. `isExact()` stays `false`. |
| Chronicle position adapter | `contracts/adapters/DeSpxaAssetPositionAdapter.sol` | **extend** | The pattern is right — heartbeat gate, SUP-5 zero-balance short-circuit, freeze-safe `totalAssets`, `onlyVaultAdmin` config. The `IChronicleOracle` binding (`latestAnswer` / `latestTimestamp`) must become a Chainlink `latestRoundData()` read, and `MAX_HEARTBEAT` is the binding constraint ([§4.3](#43-against-chronicleoracleadapter-and-the-fail-closed-freshness-rules)). |
| Venue + pricing executor | `contracts/adapters/ChronicleOracleAdapter.sol` | **replace** (pricing) / **extend** (execution) | Aerodrome routing carries over unchanged. Pricing does not: `twapPrice` hardcodes an 18-decimal asset against 6-decimal USDC (`WAD * 1e12` one way, `baseAmount * 1e12` the other — `contracts/adapters/ChronicleOracleAdapter.sol:228` and `:232`). B20 is **8** decimals and the Chainlink answer is **8** decimals, so **both** scaling constants are wrong. `MIN_NAV`/`MAX_NAV` are WAD-band constants and would also need rebasing. This is the same hardcoded-`1e12` class `docs/technical/unified-vault-spec.md` §4.3a already flags as live (ORA-6/F-17). |
| RWA vault shell | `contracts/vaults/RwaVault.sol` | **extend** | `maxAssets()` is 1 (`contracts/vaults/RwaVault.sol:188`), so four tickers is four deployments unless that changes. `DEFAULT_HEARTBEAT` / `MAX_HEARTBEAT` are the market-hours pressure point. The ADR-0006 §4 freeze disclosure block needs restating for a function-level pause ([§3.3](#33-what-each-control-would-do-to-a-vault-position)). |
| NAV-deviation guard | `contracts/vaults/BasketVault.sol` (`navDeviationGuardBps`), `contracts/lib/BasketViews.sol`, `contracts/lib/TwapTickMath.sol` | **extend** | `requireWithinDeviation` needs an `IObservablePool` exposing V3-shaped `observe()`/`slot0()`. Whether Aerodrome's B20 pools expose that shape is `UNVERIFIED`. Note what this seam actually is: a pool-internal spot-vs-TWAP check that never reads the NAV mark, so extending it to B20 buys a single-venue sanity check, not a cross-check on an oracle-priced position ([§2.4](#24-consequences-for-erc-4626-share-accounting-and-previews)). |
| Emergency floors | `BasketVault.EmergencyUnwindGuard` (`minUsdcOut`, `maxLossBps`), `RwaVault.emergencyUnwindStaleOverride` | **extend** | Mechanism carries; the weekly standing stale window changes the override from exceptional to routine ([§4.4](#44-against-the-emergency-unwind-floors)). |
| Residual price sanity check | `docs/technical/unified-vault-spec.md` §4.3a (`maxNavGrowthRateBps`) | **extend** | Specified, not built. A dividend step is the signature it is designed to reject. |
| Address / pool config | `config/dex-pools.json` | **extend** | Purely additive: one `basket_assets` entry per ticker with `venue: "Aerodrome"`, `tokenDecimals: 8`, plus the feed address. The file's own rules apply — `pool_status: pending` until pinned from an on-chain read, and the genesis ingester (`testing/smoke-test/src/genesis_alloc.rs` via `fork-block.json::ingested_addresses`) must ingest every pool listed. The `pairs` price strip is `sqrtPriceX96`-based and excludes oracle-priced RWAs; B20 belongs outside it for the same reason deSPXA is. |
| Router eligibility | `contracts/VaultRegistry.sol` (`setRouterEligible`, `routerEligibleCount` at `contracts/VaultRegistry.sol:130`), ADR-0002 | **reusable**, with an interlock | Adding a B20 vault as a router leg is the existing `defaultWeights`-length interlock, not new code. But there is no "temporarily ineligible" status, and `UNVERIFIED` whether the router degrades or reverts when one leg's `totalAssets()` reverts — which a 24/5 feed guarantees weekly. |
| External-feed NAV seam | issues **#1185** / **#1186** | **extend** | The repository's live external-feed work, already scoped as an external push feed for NAV with a staleness/deviation guard — the same shape a Chainlink B20 feed would need. The scheduled off-hours gap and the registry pause flag are two inputs it does not currently contemplate. Whether B20 should land here is not decided in this note ([§4.6](#46-live-external-feed-work-already-in-flight), [§9](#9-integration-options-and-trade-offs)). |
| Explorer indexing | `services/explorer-indexer/src/{indexer,db,lib}.rs` (`vault_snapshots`, `SNAPSHOT_HEARTBEAT_BLOCKS`) | **extend** | Needs a `MultiplierUpdated` trigger or an explicit staleness marker ([§2.5](#25-cached-and-indexed-balances)). |
| Explorer API surface | `clients/explorer-api/src/model.rs` (`VaultPosition.usdc_value`) | **extend** | `usdc_value` can silently lag a corporate action; the wire contract is pinned by `check_explorer_positions_doc.py`, so any field change is a documented change. |
| dApp asset surface | `clients/dapp/src/lib/dexPools.ts`, the rmRWA risk-disclosure banner (ADR-0006 §4) | **extend** | Pool addresses are read from `config/dex-pools.json`, never hardcoded. The banner text would need a market-hours line — users need to know the vault is closed at weekends. |

---

## 7. deSPXA vs B20 comparison

| Dimension | deSPXA (rmRWA today) | B20 (`NVDAc` / `AAPLc` / `GOOGLc` / `METAc`) |
| --- | --- | --- |
| Exposure | Index — tokenized S&P 500 | Single-name US equity, one token per name |
| Issuer | Centrifuge / Janus Henderson / Anemoy (ADR-0006) | Coinbase Onchain SPV Ltd, ADGM, inc. 2026-06-17 |
| Custody | Fund structure via Centrifuge V3 | Alpaca Securities LLC, segregated accounts; "bankruptcy-remote" is an issuer claim (`UNVERIFIED`) |
| Standard | ERC-20 ShareToken + ERC-7540 async primary | B20 — ERC-20 + multiplier, memo, policy, metadata extensions |
| Decimals | 18 | **8** |
| Corporate actions | Reflected in NAV | **On-chain multiplier**; `balanceOf` unchanged, price moves ([§2.2](#22-the-multiplier-is-not-a-rebase--and-that-matters)) |
| Primary mint/redeem | ERC-7540, KYC-gated — a stated non-goal in ADR-0006 §1 | AP-only, KYC-gated; 1 bp create / 5 bps redeem — same conclusion, different mechanism |
| Secondary transfer | `FreelyTransferable` hook, permissionless | Documented permissionless; policy engine exists but current config `UNVERIFIED` |
| Restriction shape | Binary issuer freeze (ADR-0006 §4) | Allowlist / blocklist / **function-level** pause / supply cap — finer-grained, so worse states are reachable |
| Governance delay | Issuer-side | No built-in timelock; `Announcement` is notice only |
| Oracle vendor | Chronicle push NAV | Chainlink `EACAggregatorProxy`, official oracle |
| Oracle decimals | 18 (WAD) | 8 |
| Cadence | Push, ~daily, no scheduled gap | 0.5% deviation or 24 h heartbeat, **during market hours only** |
| Off-hours behaviour | Continuous NAV; staleness is a fault | **24/5 — no heartbeat off-hours**, holds last close; staleness is scheduled and weekly |
| Extra freeze source | — | `OracleRegistry.paused` during corporate actions, duration `UNVERIFIED` |
| Token trading hours | Continuous | **24/7**, against a 24/5 mark |
| Launch venue | Uniswap V3 0.01% pool, ~$3.6M TVL (`config/dex-pools.json`) | Aerodrome deepest, $619k–$957k per name, ~$3.06M across four |
| Entry / exit | Aerodrome-or-Uniswap secondary swap only | Secondary swap only — same shape |
| Repo status | Shipped: `RwaVault`, `ChronicleOracleAdapter`, `DeSpxaAssetPositionAdapter`, pinned config | Nothing. No contract, config, client or test references B20 |

The headline: **B20 is the easier asset on compliance and the harder asset on time.**
Its secondary market is cleaner than deSPXA's and its corporate-action handling is more
explicit — but deSPXA's oracle never stops, and B20's stops every Friday.

---

## 8. Open questions

Public sources could not settle these. Each is a prerequisite for a design decision, not
a design decision itself.

1. **Which B20 functions are individually pausable, and can `transfer` and `transferFrom`
   be paused independently?** A one-sided pause admits a vault that accepts deposits into
   a position nobody can exit ([§3.3](#33-what-each-control-would-do-to-a-vault-position)).
   Unanswerable without verified source. `UNVERIFIED`.
2. **Is any transfer policy currently configured on the four launch tokens, who can change
   it, and with what delay?** The issuer claims no whitelisted wallets; the interface
   reserves them and documents no timelock ([§3.2](#32-the-no-whitelisted-wallets-claim)).
3. **Will the token contracts' source ever be verified on BaseScan?** Everything in
   [§2](#2-the-b20-standard) and [§3](#3-transfer-restrictions-and-compliance) is
   documentation until it is. Re-check before any implementation issue is opened.
4. **What are the exact 24/5 session boundaries, and what is the longest observed
   corporate-action pause?** Both are needed to choose any staleness bound
   ([§4.2](#42-what-the-feed-does-when-the-market-is-closed)).
5. **Can the multiplier decrease?** No downward case is documented, but `updateMultiplier`
   is an instant untimelocked write ([§2.3](#23-can-a-multiplier-update-move-vault-nav-between-blocks-with-no-transfer)).
6. **How should a scheduled corporate-action NAV step be distinguished from a mis-scaled
   mark, without a second oracle?** Sharpened by
   [§2.4](#24-consequences-for-erc-4626-share-accounting-and-previews): **no built check
   compares the oracle mark against a second price source.** The live
   `navDeviationGuardBps` compares a pool's spot tick with that same pool's TWAP and never
   reads the mark, so the only check whose signature a legitimate dividend step matches is
   `maxNavGrowthRateBps` — which is specified, not built
   (`docs/technical/unified-vault-spec.md` §4.3a). Until it exists, a mis-scaled mark on an
   oracle-priced position is unguarded on the deposit path, and the question is what a
   second source would even be for an asset whose feed is dark 24/5.
7. **What notional does a 50 bps slippage cap permit against each Aerodrome B20 pool?**
   Requires reading the pool's curve and concentration on-chain; deliberately not
   estimated here ([§5.3](#53-is-an-adr-0006-equivalent-hold-and-swap-model-viable-per-asset)).
8. **Do Aerodrome's B20 pools expose the V3-shaped `observe()` / `slot0()` surface
   `TwapTickMath` requires?** If not, the NAV-deviation guard has no reference price for
   these assets at all.
9. **How does `PortfolioRouter` behave when one router-eligible leg's `totalAssets()`
   reverts?** A 24/5 feed makes this a weekly event, and `VaultRegistry` has no
   "temporarily ineligible" state ([§6](#6-stack-mapping)).
10. **Would `MAX_HEARTBEAT` need to change, and what would that cost?** It is a `constant`
    in two contracts, so any change is a redeploy — and a longer bound trades a weekly
    halt for a weekly window of trading against a multi-day-old mark
    ([§4.3](#43-against-chronicleoracleadapter-and-the-fail-closed-freshness-rules)).
11. **Is the ADGM/FSRA bankruptcy-remoteness claim corroborated by the filed prospectus?**
    Not read for this note (`UNVERIFIED`, [§1.3](#13-issuer-custodian-wrapper)).
12. **Which further tickers are planned beyond the thirteen now listed
    ([§1.3](#13-issuer-custodian-wrapper)), on what schedule?** `UNVERIFIED`; the issuance
    mechanism is unchanged, so only depth and calendar would differ.

---

## 9. Integration options and trade-offs

Four plausible shapes, described so a future decision has something to choose between.
**This note recommends none of them**, and nothing here commits the project to Coinbase,
Chainlink, Aerodrome, or to shipping anything at all. See
[base.org/stocks](https://www.base.org/stocks) for the product surface each option would
sit on.

**Option A — monitor only.** Add nothing; re-read this note when the token source is
verified or when depth grows.
*For:* zero cost, and three of the twelve items in [§8](#8-open-questions) resolve
themselves on the issuer's timetable rather than ours. Day-one depth ([§5.2](#52-observed-depth))
is thin enough that the sizing question may answer itself either way.
*Against:* no option value captured, and the external-feed seam (#1185/#1186) gets
designed without B20's off-hours gap as an input — which is the one thing this note found
that generalizes.

**Option B — one B20 vault per ticker, mirroring rmRWA.** A `RwaVault`-shaped deployment
per name, `maxAssets() == 1`, Chainlink-priced.
*For:* smallest conceptual delta; ADR-0006's hold-and-swap reasoning transfers almost
verbatim ([§5.3](#53-is-an-adr-0006-equivalent-hold-and-swap-model-viable-per-asset)); each
name's freeze and liquidity risk stays isolated.
*Against:* four deployments, four registry entries, four sets of router weights; every one
of them halts every weekend ([§4.3](#43-against-chronicleoracleadapter-and-the-fail-closed-freshness-rules));
single-name equity exposure is a different product from an index and may not fit
`docs/prd.md` §11.4 at all.

**Option C — one multi-name B20 basket vault.** All four in a single `BasketVault`.
*For:* one deployment, one router leg, diversified single-name risk; `BasketVault` already
does equal-weight multi-asset composition.
*Against:* all four feeds are 24/5, so nothing diversifies the market-hours halt — the
correlated risk is exactly the one that matters. Also multiplies the per-asset deviation
and pause surface, and each leg's swap is capped by the thinnest pool.

**Option D — fold B20 into the #1185/#1186 external-feed adapter.** Treat a Chainlink B20
feed as one more feed type on the generalized external-feed `AssetPositionAdapter`, with
off-hours and registry-pause handling added to its staleness/deviation guard.
*For:* one oracle path instead of two; the off-hours gap and pause flag become first-class
guard inputs rather than B20 special-cases; avoids a competing design landing beside a
seam already in flight ([§4.6](#46-live-external-feed-work-already-in-flight)).
*Against:* couples B20 to another issue's schedule and widens #1186's scope with
requirements a crypto-asset feed never needed; the guard-calibration problem in
[§8](#8-open-questions) item 6 has to be solved for the general case rather than deferred.

**Cutting across all four**, unresolved regardless of shape: the decimals mismatch in
`ChronicleOracleAdapter` ([§6](#6-stack-mapping)), the `MAX_HEARTBEAT` ceiling
([§8](#8-open-questions) item 10), and whether single-name equity exposure belongs in this
product at all — a product question, not an engineering one.

---

## 10. Sources

Primary:

1. Base announcement — <https://blog.base.org/tokenized-stocks> (returns HTTP 403 to
   automated fetchers; body read via the Arweave mirror at
   <https://3t4q4ogpaqeei7gqd7j4zudwln527j7ci4gvhncvx4a6h435ssga.arweave.net/3PkOOM8ECER80B_TzNB2W3uvp-JHDVO0Vb8B4_N9lIw>)
2. Base integration docs — <https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base>
3. Chainlink, Base Tokenized Equities (Coinbase B20) — <https://docs.chain.link/data-feeds/tokenized-equity-feeds/coinbase>
4. Base product page — <https://www.base.org/stocks>

On-chain reads (BaseScan, 2026-08-25):

5. `NVDAc` token — <https://basescan.org/token/0xb20000000000000000000078ee7ce2fE4908108C>
6. `AAPLc` token — <https://basescan.org/token/0xb200000000000000000000C2e324d24d7eEcd1fb>
7. `GOOGLc` token — <https://basescan.org/token/0xb2000000000000000000002D0BA3164cc74f58B7>
8. `METAc` token — <https://basescan.org/token/0xb2000000000000000000008bC8786B856E61707C>
9. Coinbase `OracleRegistry`, verified source — <https://basescan.org/address/0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD#code>
10. Chainlink NVDA aggregator proxy — <https://basescan.org/address/0x04689a41629776563E6822F76f2e57D148d28513>

Secondary reporting:

11. Coinbase selects Chainlink (press release) — <https://www.prnewswire.com/news-releases/coinbase-selects-chainlink-to-bring-new-tokenized-stocks-to-millions-of-defi-users-302858414.html>
12. The Defiant, launch coverage (liquidity figures, SPV, fees) — <https://thedefiant.io/news/defi/coinbase-launches-tokenized-stocks-on-base>
13. FinanceFeeds, 24/7 tokens against 24/5 feeds — <https://financefeeds.com/coinbase-uses-chainlink-to-price-four-stock-tokens-as-aave-lending-waits-for-v4/>
14. CoinDesk, launch coverage — <https://www.coindesk.com/business/2026/08/24/coinbase-debuts-tokenized-stocks-on-base-network-joining-race-to-bring-equities-on-blockchain>

Repository files read for the stack mapping: `docs/adr/ADR-0006-despxa-rwa-vault-design.md`,
`docs/adr/ADR-0010-unified-vault-architecture.md`, `docs/technical/unified-vault-spec.md`
(§4.3, §4.3a, §4.4), `docs/technical/adapter-architecture.md`,
`contracts/vaults/RwaVault.sol`, `contracts/vaults/BasketVault.sol`,
`contracts/adapters/DeSpxaAssetPositionAdapter.sol`,
`contracts/adapters/ChronicleOracleAdapter.sol`,
`contracts/adapters/UniswapV3AssetPositionAdapter.sol`, `contracts/lib/BasketViews.sol`,
`contracts/lib/TwapTickMath.sol`, `contracts/VaultRegistry.sol`, `config/dex-pools.json`,
`services/explorer-indexer/src/{indexer,db,lib}.rs`, `clients/explorer-api/src/model.rs`.
Issues **#1185** and **#1186** were read for the external-feed seam.
