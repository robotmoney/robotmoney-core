# Prior Art: Vault Design Comparison

Robot Money vaults compared against four market products: Enzyme Finance,
Veda (BoringVault), Alvara Protocol, and Zyfi.

---

## 1. Products at a Glance

| | Robot Money | Enzyme Finance | Veda BoringVault | Alvara Protocol | Zyfi |
|---|---|---|---|---|---|
| **Purpose** | USDC treasury for human depositors and autonomous agents | On-chain asset management vaults for fund managers | Minimal, auditable yield vaults | Permissionless multi-asset basket funds | Gas abstraction / paymaster service on zkSync |
| **Chain** | Base (8453) | Ethereum + others | Ethereum-compatible | Ethereum, Avalanche, Base | zkSync Era |
| **Share token** | ERC-4626 rmUSDC (vault-specific receipt) | ERC-20 per fund | ERC-20 (share-locked after deposit) | ERC-20 LP (tradeable on DEXs) | None — sponsorship, not investment |
| **Deposit asset** | USDC (all vaults) | Any ERC-20 denomination | Any ERC-20 | Any ERC-20 basket | ETH (dev sponsorship) + any ERC-20 (user fee) |
| **Exposure** | USDC yield (stable vault); wETH/cbBTC/wSOL (protocol vault); agent tokens (agent vault) | Matches denomination asset or held basket | Matches deposit asset | Multi-asset basket | N/A |
| **Contract standard** | ERC-4626 + OZ AccessControl v5 | Custom VaultProxy + ComptrollerProxy | Custom BoringVault (~100 LOC) | ERC-7621 basket token standard | zkSync native paymaster interface |
| **Upgradability** | Non-proxy, direct deployment | Proxy per fund, release migrations | Non-upgradeable core | Not specified | Audited non-upgradeable vault |
| **Fees** | Exit fee only (mgmt/perf deferred) | Management, performance, entrance, exit | Externally managed via Accountant rate | Management (% of TVL, on-chain) | Gas sponsorship ratio + token markup |
| **Admin model** | TimelockController + Safe multisig | Dispatcher owner (Avantgarde Core) | External Teller/Accountant/Manager modules | veALVA governance | Vault owner (developers) |

---

## 2. Architecture Comparison

### 2.1 Vault Structure

**Robot Money** uses a two-layer allocation model: a Portfolio Router at the
outer layer splits USDC across individual `RobotMoneyVault` contracts, each of
which routes internally through `IStrategyAdapter` implementations. Vaults are
the stable interface; adapters are internal and swappable. The gateway sits
outside both layers as a permission and safety boundary for agent-signed writes.
The vault-plus-adapter pattern is modeled directly on Yearn V3: a single
ERC-4626 contract routes assets across pluggable strategy adapters, with a
keeper-triggered rebalance correcting drift. The asymmetric pause model
(EMERGENCY_ROLE pauses, ADMIN_ROLE unpauses) is also borrowed from Yearn's
security design. Veda (BoringVault) was evaluated as an off-the-shelf
provider for the Portfolio Router layer; the team chose to build in-house,
diverging from Veda primarily by not issuing an outer share token.

**Enzyme Finance** uses a two-contract model per fund: `VaultProxy` (persistent
asset holder, ERC-20 shares) and `ComptrollerProxy` (accounting, fee accrual,
share minting). An `IntegrationManager` routes strategies to integrated DeFi
protocols. An `ExternalPositionManager` handles non-standard positions. The
`PolicyManager` enforces fund-level trading rules. Each fund is independently
deployed; there is no outer allocation router.

**Veda BoringVault** separates responsibilities across four contracts:
`BoringVault` (~100 LOC, non-upgradeable, pure asset holder), `Teller` (deposit
entry point and share lock enforcement), `Accountant` (exchange rate with
on-chain safety bounds), and `Manager` (strategy gating via Merkle tree). The
minimal core is the central design principle; all complex logic lives in
replaceable external modules.

**Alvara Protocol** implements the ERC-7621 standard: each basket is a token
holding unlimited ERC-20 assets. LP tokens (ERC-20) represent depositor shares
and are freely tradeable on DEXs. Basket managers adjust composition in
real-time with single-transaction rebalancing. There is no outer router; each
basket is a standalone fund.

ERC-7621 standard note: the spec was proposed and authored entirely by Alvara
team members and merged to Draft status in April 2024. As of May 2026 it
remains Draft, with no other teams having shipped independent implementations.
Adoption signals beyond Alvara are thin — no migrations from Set Protocol,
Index Coop, or Reserve Protocol have materialized. The standard is worth
monitoring but carries meaningful ecosystem-adoption risk relative to
established standards like ERC-4626.

ERC-7575 standard note (multi-asset ERC-4626 vaults): a separate multi-asset
proposal — ERC-7575, "Multi-Asset ERC-4626 Vaults" — externalizes the ERC-20
share token from the ERC-4626 implementation so that one share token can have
multiple vault entry points / underlying assets (e.g. an LP-position vault).
Created December 2023 by authors spanning multiple teams (Jeroen Offerijns,
Alina Sinelnikova, Vikram Arun, Joey Santoro, Farhaan Ali; Centrifuge/RWA
lineage). As of May 2026 it remains **Draft** — better-authored than ERC-7621
but the same maturity tier. It is not relevant to Robot Money: its defining
feature is a single share token spanning multiple assets, which is precisely
the outer share token Robot Money deliberately chose not to issue at the
Portfolio Router layer (see §3.5). Adopting ERC-7575 would cut against a
settled design decision rather than fill a gap. Worth monitoring only if an
outer composite-claim model is ever reconsidered.

**Zyfi** is not a yield vault — it is a gas abstraction layer. Its `Vault`
contract holds developer-deposited ETH for transaction sponsorship. The
`Paymaster` contract intercepts zkSync Type 113 transactions, collects ERC-20
fee tokens from users, and covers gas from the sponsorship balance. It has no
depositor shares, no yield, and no withdrawal flow for end users.

### 2.2 Deposit and Withdrawal Flow

**Robot Money**

Direct path: user calls `vault.deposit(assets, receiver)` (ERC-4626 standard).
Router path: user calls `PortfolioRouter.deposit(amount)` → router splits
across active vaults by governance-set weights → each vault mints receipts
to the user. Both paths are synchronous and must complete in one transaction.
A preview is required before any signing prompt; unavailable legs revert the
entire deposit.

Gateway path (agents): `rmpc` reads chain state, then calls
`gateway.deposit(...)` → gateway enforces policy (valid-until, per-payment cap,
per-window cap, allowed destinations, share receiver) → forwards to vault or
router. Withdrawn assets go only to the policy-configured recipient; the agent
cannot redirect proceeds to itself.

**Enzyme Finance**

Deposit: `ComptrollerProxy.buyShares(denominationAsset, amount)` transfers the
denomination asset into `VaultProxy` and mints shares at current NAV. A wrapper
contract handles pre-swaps from non-denomination assets. NAV is updated
periodically (not continuously), creating a window where stale pricing is
possible. There is no protocol-level deposit preview.

Withdrawal: Users burn shares via redemption policies. Most public vaults allow
instant redemption. No synchronous-redemption guarantee is documented at the
protocol level.

**Veda BoringVault**

Deposit: `Teller.deposit(asset)` or `Teller.depositWithPermit(asset)` → Teller
fetches current exchange rate from Accountant → mints shares. After deposit,
all of the depositor's shares (including existing) are locked for a configurable
period. Asset support gated by `Teller.isSupported(asset)`.

Withdrawal: Proportional claim based on burned shares. `TellerWithBuffer`
provides instant withdrawal; other variants may have delays. Share lock is a
notable UX distinction from Robot Money's synchronous redemption guarantee.

**Alvara Protocol**

Deposit: Provide ERC-20 assets → LP tokens minted proportionally in a single
transaction. LP tokens are ERC-20 and immediately tradeable on DEXs.

Withdrawal: Burn LP tokens → atomic redemption of proportional basket holdings
in one transaction.

**Zyfi**

No depositor investment flow. Developer deposits ETH into `Vault.deposit()` to
fund a sponsorship balance. User transactions are processed by the paymaster;
no withdrawal of investment proceeds exists.

### 2.3 Permissioning and Access Control

**Robot Money** uses OZ `AccessControl` with `ADMIN_ROLE` held by a deployed
`TimelockController`. The Safe multisig holds `PROPOSER_ROLE` and
`EXECUTOR_ROLE` on the controller. No EOA may hold `ADMIN_ROLE` in production.
Depositor-owned agent policies are under sole depositor authority and are not
subject to the protocol timelock. This is a strict separation: protocol
controls its own upgrade path; depositors control their own agent delegation.

**Enzyme Finance** has three roles per fund: Owner (full control), Migrator
(migration and reconfiguration), and Asset Manager (trading operations,
further bounded by `PolicyManager` rules). Protocol-level admin is held by the
Enzyme Council (Avantgarde Core). This is a more permissioned model that
requires trusting a named legal entity.

**Veda BoringVault** enforces strategist actions through a Merkle tree. Each
leaf encodes a `(DecoderAndSanitizer, Selector, ValueNonZero)` tuple; only
actions whose calldata matches a leaf are permitted. `DecoderAndSanitizer`
contracts extract and validate arguments before execution. The non-upgradeable
`BoringVault` core means the Merkle tree is the primary attack surface, not the
vault itself.

**Alvara Protocol** is permissionless at the creation layer (any address, 0.1
ETH minimum seed). Post-creation, the basket manager has full control over
composition and rebalancing. Protocol-level decisions are governed by veALVA
holders (20% quorum, 51% pass rate). This is the most open manager model of
the four.

**Zyfi** uses Type 113 zkSync AA validation. Developers control their vault
balance and `sponsorshipRatio`. Users grant ERC-20 allowances; the paymaster
collects the exact fee. No depositor governance exists.

### 2.4 Fee Architecture

**Robot Money** currently ships exit fees only. The fee amount is bounded and
disclosed before signing. Management fees and performance fees are explicitly
deferred to a future phase and require a separate ADR before implementation.
Fee recipient changes are admin-timelock operations. This is the most
conservative fee model in the comparison.

**Enzyme Finance** supports the most complete fee surface: management fee
(percentage of AUM, paid as newly minted shares), performance fee (above
high-water mark, crystallized periodically), entrance fee, and exit fee. All
fees are calculated and accrued on-chain with no off-chain infrastructure. This
richness comes with accounting complexity — dilution from newly minted fee
shares is non-obvious to depositors.

**Veda BoringVault** delegates fee handling to external Accountant exchange rate
updates. The Accountant can model fees by adjusting the exchange rate over time.
There is no protocol-enforced fee type; vault operators choose their own model.
This is maximum flexibility at the cost of transparency standardization.

**Alvara Protocol** builds management fees into the protocol at the basket
level — a percentage of TVL collected at monthly rebalancing intervals, paid
on-chain to the basket manager. The mandatory minimum 5% ALVA weighting in
every basket is effectively a fee-in-kind to the protocol token.

**Zyfi** charges a fee spread between the estimated gas cost and the ERC-20
token amount collected from users. The developer controls the sponsorship
ratio (0–100%) determining who absorbs the cost. No investment yield fee
model applies.

### 2.5 Oracle and Pricing

**Robot Money** avoids price oracles for the current stable-yield vault, which
stays fully in USDC. `totalAssets()` is reported by adapters from live on-chain
positions (Morpho, Aave, Compound). Share price is computed from live
`totalAssets()` and supply via ERC-4626 math. No off-chain price feed.
The deployed prototype of the protocol-asset vault uses Uniswap V3 `slot0`
pricing, which is manipulable; the PRD requires a Uniswap V3 TWAP oracle
before that vault is Router-eligible. The agent-token vault faces the same
requirement for its curated basket. Both categories are deferred pending
dedicated ADRs and resolved rebalancing models.

**Enzyme Finance** uses external price oracles for NAV calculation across
multi-asset funds. NAV is updated periodically (not continuously), creating
stale-price windows. Protocol supports multiple oracle adapters and Chainlink
integration.

**Veda BoringVault** computes exchange rates off-chain and submits them
on-chain via the Accountant. The Accountant enforces bounds — rate cannot jump
beyond a configured threshold between updates — preventing oracle manipulation
or operator error from draining the vault silently. The off-chain computation
step is a trust assumption not present in Robot Money.

**Alvara Protocol** uses 1inch Swap API integration for best-execution pricing
during rebalancing. On-chain price discovery is delegated to DEX aggregators.
No dedicated oracle architecture is described.

**Zyfi** fetches token prices off-chain to estimate gas costs in ERC-20
denomination. Zero on-chain oracle dependency; this simplifies architecture
but creates potential for off-chain price manipulation in the fee estimation
path.

### 2.6 Governance Model

**Robot Money** governance controls Portfolio Router target weights across active
vaults. The current deployed `RouterGovernance.sol` is an admin-weighted MVP
mock: voting power is assigned by `ADMIN_ROLE`; proposal creation is
`ADMIN_ROLE`-only. Token-holder voting against `$ROBOTMONEY` balances is
explicitly a future goal. The governance surface is intentionally narrow — it
covers only router weight updates and does not control vault internals,
per-vault asset selection, fees, or individual agent policies.

**Enzyme Finance** governance (Enzyme Council / Avantgarde Core) controls
protocol-level releases and integrations. Individual fund managers control their
own fund parameters — there is no outer cross-fund allocation vote equivalent to
the Robot Money Portfolio Router weight vote.

**Alvara Protocol** uses veALVA governance (20% quorum, 51% pass rate) to
direct ALVA token rewards toward baskets each epoch. This is an incentive
allocation vote, not an asset-weight vote. Individual basket managers retain
full control of their basket composition.

**Veda BoringVault** has no protocol-level governance for fund allocation.
Strategy constraints are encoded in the Merkle tree by vault operators.

**Zyfi** has no governance mechanism relevant to investment allocation.

---

## 3. Differentiating Design Decisions

### 3.1 USDC as Deposit Denomination Across All Vaults

All Robot Money vaults accept USDC as the deposit asset. The current deployed
stable-yield vault stays fully in USDC (Morpho/Aave/Compound), eliminating
oracle risk, cross-asset liquidity risk, and price manipulation vectors. The
planned protocol-asset vault (wETH/cbBTC/wSOL exposure) and agent-token vault
(agent-economy token basket) accept USDC and swap into their target assets at
deposit time using Uniswap V3, swapping back on withdrawal. Those vaults are
not Router-eligible until TWAP pricing and a resolved rebalancing model are in
place. The stable-yield vault can be included in router allocations today
precisely because its redemption path carries no swap or oracle dependency.

The deposit-time equal-weight basket pattern of the protocol-asset and
agent-token vaults is structurally similar to Alvara — USDC in, basket exposure
out, proportional redemption on exit. The key differences are that Robot Money
uses USDC as the single denominator (Alvara accepts any ERC-20), does not issue
DEX-tradeable LP shares, and has no equivalent to the 5% ALVA protocol-token
floor. For these two vault categories, Alvara is the closest comparable prior
art in the market.

### 3.2 Synchronous Redemption as a Product Guarantee

Robot Money treats synchronous redemption as a first-class product promise.
Any vault included in router allocations must support single-transaction
withdrawal. Adapter liquidity failures and upstream venue pauses are
first-order risks addressed in the architecture, not edge-case footnotes.

Veda's share lock after deposit is the sharpest contrast: deposits lock all
shares (including pre-existing) for a configurable window. Enzyme does not
document a synchronous-redemption guarantee at the protocol level.

### 3.3 Autonomous Agent Gateway

The `RobotMoneyGateway` is the only product in this comparison with a
first-class design for autonomous agent access. The depositor owns the
policy (valid-until, per-payment cap, window cap, share receiver, allowed
destinations); the protocol never manages individual agent policies at
runtime. The gateway enforces on-chain that agents cannot redirect proceeds,
raise caps, or bypass disabled vaults.

No other product in this comparison has an equivalent structure. Enzyme and
Veda assume human-or-operator callers. Alvara and Zyfi do not model agent
delegation at all.

### 3.4 Admin Timelock Requirement

Robot Money requires `ADMIN_ROLE` on all five protocol contracts to be held
by a `TimelockController`. No EOA may hold `ADMIN_ROLE` in production. This
is a hard architectural constraint, not a post-launch governance aspiration.

Enzyme's protocol admin is held by the Enzyme Council, which is a named
legal entity and is not an on-chain timelock constraint. Veda and Alvara
do not publish equivalent constraints in their documentation.

### 3.5 No Outer Share Token

The Portfolio Router does not issue an outer share token. A portfolio
position is a reporting concept computed from per-vault receipt balances.
This avoids creating an unobservable outer claim or hidden custody layer.
This was an explicit design decision made after evaluating Veda as an
off-the-shelf provider: Veda issues an outer composite receipt; Robot Money
does not. Depositors receive underlying vault receipts directly regardless
of whether they deposit through the router or into a vault directly.

Enzyme creates per-fund ERC-20 shares with full share-token accounting.
Alvara LP tokens are ERC-20 and DEX-tradeable. Veda shares are ERC-20 but
share-locked after deposit. Robot Money's design reduces secondary-market
composability but preserves per-vault observability and avoids creating
hidden custody.

### 3.6 Adapter Pattern vs. Direct Strategy

Robot Money vaults hold no raw protocol positions directly. Every external
venue goes through an `IStrategyAdapter` that normalizes `deploy`,
`withdraw`, `totalAssets`, and `rescueTokens`. Adapters are internal to one
vault; mutating calls require the owning vault as `msg.sender`. This
isolates venue-specific risk to the adapter and keeps vault accounting clean.
This pattern is modeled directly on Yearn V3 strategies, which normalize
each yield venue behind a common interface callable only by the owning vault.

Enzyme routes through `IntegrationManager` (analogous) but exposes a richer
surface including external positions and leverage. Veda's `Manager` module
uses Merkle tree gating instead of a typed interface. Neither enforces the
same caller-restriction pattern Robot Money uses. Giza and Zyfai — stable-yield
aggregators on Base that allocate USDC across Aave, Compound, and Morpho — are
named in the PRD as potential build-vs-buy alternatives to custom adapters; the
current architecture supports either path by replacing a custom adapter with an
`IStrategyAdapter` wrapper around a Giza or Zyfai position.

---

## 4. Gap Analysis

| Concern | Robot Money status | Comparable prior art |
|---|---|---|
| Multi-asset basket vaults | Planned (protocol-asset, agent-token); not yet Router-eligible — pending TWAP oracle and rebalancing model | Enzyme (multi-asset), Alvara (basket) |
| TWAP oracle for basket vaults | Required before Router eligibility; current prototype uses manipulable `slot0` pricing | Enzyme (Chainlink), Alvara (1inch DEX aggregator) |
| Intra-vault rebalancing for baskets | TBD — trigger, target weights, and cost/slippage model are unresolved (`docs/development/open-questions.md` §3.15) | Alvara (single-tx atomic rebalance), Enzyme (manager-triggered) |
| Agent-token shortlist governance | TBD — bribery model vs. RM-token inclusion vote unresolved (`docs/development/open-questions.md` §1.3) | Alvara (veALVA incentive vote), Enzyme (Asset Manager role) |
| Router weight governance | Deployed as admin-weighted MVP mock; token-holder voting is a future goal | Alvara (veALVA epoch vote), Enzyme (Enzyme Council) |
| Performance/management fees | Deferred to future phase requiring separate ADR | Enzyme (full fee suite), Alvara (mgmt fee built-in) |
| DEX-tradeable LP shares | Not a design goal; per-vault receipts only | Alvara (DEX LP), some Enzyme funds |
| Off-chain NAV computation | Not used; on-chain `totalAssets()` only | Veda (off-chain exchange rate + safety bounds) |
| Share lock period | None; synchronous redemption guaranteed | Veda (all shares locked after deposit) |
| Gas abstraction | Not in scope | Zyfi (full paymaster service) |
| Permissionless vault creation | Not in scope; vaults are protocol-registered | Alvara (permissionless basket launch) |
| Build-vs-buy for stable-yield strategies | Custom adapters in-house (decided, issue #470); Giza/Zyfai named as alternatives if revisited per strategy | Giza, Zyfai (managed Base aggregators) |
| Agent-first access control | First-class via gateway; no comparable in this set | None in this comparison |
| Admin timelock | Required by architecture for all five protocol contracts | None documented at same strictness |

---

## 5. Sources

- Enzyme Finance architecture: https://docs.enzyme.finance/onyx-protocol/architecture/architecture-overview
- Enzyme GitHub: https://github.com/enzymefinance/protocol
- Enzyme deposit flow: https://sdk.enzyme.finance/sdk/depositor/deposit/
- Veda BoringVault GitHub: https://github.com/Veda-Labs/boring-vault
- Veda architecture: https://docs.veda.tech/architecture-and-flow-of-funds
- Veda security: https://docs.veda.tech/security-and-risk-controls/smart-contract-security
- Alvara Protocol: https://www.alvara.xyz/
- Alvara ERC-7621 guide: https://alvaraprotocol.medium.com/a-definitive-guide-to-the-erc-7621-token-standard-000e25d196f9
- Alvara docs: https://docs.alvara.xyz/token-and-tokenomics
- ERC-7575 (Multi-Asset ERC-4626 Vaults): https://eips.ethereum.org/EIPS/eip-7575
- ERC-7575 canonical source: https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7575.md
- Zyfi documentation: https://docs.zyfi.org
- Zyfi paymaster flow: https://docs.zyfi.org/introduction/paymaster-flow
- Zyfi sponsored paymaster: https://docs.zyfi.org/integration-guide/paymasters-integration/sponsored-paymaster
