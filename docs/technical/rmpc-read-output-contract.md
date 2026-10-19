# ADR — `rmpc` read-command stable JSON output contract

> Scope: dev-scout decision record for Phase 3 (Direct Chain-Read Query Tooling) of `Plan tracking issue #109` §9. Locks the shared output envelope every `rmpc get-*` command emits, the seam multi-read commands use to aggregate partial results, and the type-level rules that prevent JSON-number drift on large integers. No real read commands are produced by this scout — only the shared module they will all consume.

---

## 1. Status

Accepted. Authored 2026-05-06 against `Plan tracking issue #109` §9 on branch `feat/51-dev-scout-rmpc-read-commands-stable-json-output-`. Closes the open question gate in §9 ("Output contract"). No prior ADR exists for this phase. Stub code lives in `clients/rust-payment-client/src/read_output.rs`.

## 2. Context

`Plan tracking issue #109` §9 prescribes a family of direct-chain-read commands (`rmpc get-vault`, `get-balance`, `get-agent`, `get-gateway`, `get-deposit`, `get-tx`, `get-allowance`, `get-roles`) and binds them all to one output contract:

- All large integers are decimal strings.
- Every command includes `chain_id`, `block_number`, and `source: "json_rpc"`.
- Multi-read commands include a `partial` flag and a per-field error list when any sub-read fails.

The plan does not say which crate owns the envelope, what the partial-aggregation seam looks like, or how the "no JSON numbers for `u256`/`u128`" rule is enforced. Without a single anchored answer, each read-command batch (`get-vault`, `get-balance`, …) would re-implement the envelope locally and drift — exactly the failure mode §9 names ("must be enforced as one shared module before the read-command batches diverge").

**Which system each read touches (owner decision 2026-10-19).** `rmpc` belongs to the rmpc gateway system, with `RobotMoneyGateway`. That system is a client of the separate vaults system. `get-gateway`, `get-agent`, `get-roles` and `get-deposit` read the gateway. `get-vault`, `get-vaults`, `get-router`, `get-governance` and `get-timelock` read the vaults system's public surfaces, the same ones a human wallet reads. `get-balance` and `get-allowance` read the USDC token. The envelope is the same for every read, whichever system it touches. The vaults system never depends on `rmpc` or the gateway.

The deferred existing `rmpc status` (issue #15) command predates §9 and emits a flatter shape with no envelope. It is **not** retrofit by this scout; migration is left as a follow-up.

## 3. Decisions

### 3.1 One shared module, in-crate — `rust_payment_client::read_output`

- **Decision.** Ship the envelope, partial-aggregator, and decimal-string newtypes as a single module inside the existing `rust-payment-client` crate, not a separate workspace crate.
- **Rationale.** The envelope is consumed only by `rmpc` subcommands today; the only other §9-named consumer (the Phase 5 explorer indexer) lives outside this repo's CLI tree and will deserialize the JSON wire format, not link the Rust module. A separate crate would add a workspace member, publish friction, and a stable-API obligation for zero short-term gain. If a second in-tree crate ever needs the types, promotion to `crates/rmpc-read-output` is a mechanical refactor.

### 3.2 Envelope shape — `chain_id`, `block_number`, `source`, `partial`, `errors`, `data`

- **Decision.** Field order on the wire is exactly the source-declaration order in `Envelope<T>`: `chain_id`, `block_number`, `source`, `partial`, `errors`, `data`. Snapshot tests assert on it.
- **Rationale.** Stable order makes diff review against snapshot fixtures readable. `partial` and `errors` are always present (never `Option`-stripped) so consumers can branch on `errors.length` without an `Option` check — the §9 acceptance criterion "Multi-read commands surface partial: true and a per-field error list" means the shape must exist on every command, with `errors: []` and `partial: false` for clean responses.
- **Why `errors` is always emitted.** Single-read commands cannot produce per-field partials by definition (the whole command either succeeded or returned an error exit code), but the contract is stronger if every read response has the same top-level keys. Agents and shell scripts can `jq '.errors[]'` against any read command without first probing for the field's existence.

### 3.3 `source` is locked to `"json_rpc"` for §9

- **Decision.** The `source` enum has exactly one variant, `JsonRpc`, serialized as `"json_rpc"`. Any future variant (e.g. an `Indexer` source for cross-checking) requires a new dev-scout that re-opens this ADR.
- **Rationale.** §9's "Principles" subsection is explicit: "Direct JSON-RPC reads only for canonical chain state. Explorer APIs may be optional enrichment later, but must not be the source of truth." Hard-coding the variant at the type level prevents a future read command from quietly setting `source: "etherscan"` when an RPC fails.

### 3.4 Partial aggregation via `PartialBuilder<T>`

- **Decision.** Multi-read commands construct a `PartialBuilder::new(chain_id, block_number, T::default_or_zero())`, drive sub-reads against `builder.data_mut()` on success and `builder.record_err(field, message)` on failure, and call `.finish()` to produce the final `Envelope<T>`. The builder owns the `partial` decision: `partial = !errors.is_empty()`.
- **Rationale.** The aggregation seam is the seam where the §9 "partial flag and per-field error list" rule becomes a single line of code. Per-command implementations cannot forget to set `partial`, cannot disagree on how it's computed, and cannot serialize `errors` in a different shape — the builder is the only path to an `Envelope`.
- **Field paths are dotted, JSON-shaped.** `record_err("vault.totalAssets", …)` and `record_err("adapters[2].balance", …)`. This matches how a consumer would name the field in `jq` and is what the §9 criterion "per-field error list" requires for usefulness.
- **Block-drift handling.** Sub-reads MUST share a single `block_number` (the builder is initialized with one). If a multi-read command issues sub-reads serially and the chain reorgs underneath, the implementer SHOULD record a synthetic `_meta.block_drift` field error and mark the envelope partial. The builder does not detect this on its own — the read-command batch issue that adds the first multi-read is responsible for choosing the pinning strategy (single `eth_blockNumber` up front, or `blockTag: "latest"` and tolerate drift).

### 3.5 Large integers are typed, not just documented — `DecimalU256` / `DecimalU128`

- **Decision.** Per-command `data` payloads use `DecimalU256` and `DecimalU128` newtypes for any value that exceeds the JSON-safe integer range. Their `Serialize` impl emits a JSON string in decimal form via `Display`; the wrapped raw `U256`/`u128` is never reachable through the public Serde path.
- **Rationale.** The §9 acceptance criterion "All large integers are decimal strings, never hex or numbers" is brittle if it lives only in code review checklists. Alloy's `U256` has multiple Serde impls in flight (decimal vs hex string vs the `quantity` representation); a payload struct that holds a raw `U256` field can serialize differently depending on which trait import the file picked up. Wrapping at the type level closes that gap — a payload that compiles is one that serializes per the contract.
- **Why two distinct widths.** `u128` and `U256` are physically different on-chain widths. Some Robot Money fields (per-window caps stored as `uint128`, basket amounts) are deliberately sub-`U256`. Distinct wrappers prevent a downstream batch from silently widening a `uint128` field into `U256` and bloating the JSON.
- **Type-check criterion in §9 test plan.** The test plan asks "Type-check that no field uses a JSON number for u256/u128 values." The mechanism: every per-command `data` struct uses these wrappers, so the unit tests for those structs (and the lib-level `decimal_u256_serializes_as_string_never_number` smoke test in `read_output.rs`) collectively prove the property.

### 3.6 Failed nullable sub-reads use `null`, not an in-domain sentinel

- **Decision.** A per-field `uint256` read that fails after the command has
  established its envelope is represented as `null` when the field's valid
  domain includes zero. A successful zero remains the decimal string `"0"`.
  The command still records the field in `errors` and sets `partial: true`.
- **Rationale.** A fabricated numeric default is data that a consumer can
  mistake for a successful answer. JSON `null` matches the existing
  `share_price` convention for "no answer" and is distinguishable from every
  successful result, including an empty vault.
- **Applies to.** Both `total_assets` (`totalAssets()`) and `total_supply`
  (`totalSupply()`) on `get-vault` and `get-vaults`. A failed `totalSupply()`
  renders `null`; a vault with genuinely zero shares renders `"0"`. Consumers
  that parse these fields must treat `null` as "unknown" and fail loudly, never
  coerce it to zero.
- **Also applies to `get-agent`** (QA plan U6, finding DR-8). A failed
  `agents()` read renders every field it fills as `null`: `active`,
  `valid_until`, `max_per_payment`, `max_per_window`, `share_receiver`,
  `asset_recipient`, `max_withdraw_per_payment`, `max_withdraw_per_window` and
  `withdrawals_enabled`. A failed allowance, block-timestamp or window-gross
  read renders `share_allowance`, `window_id` or `window_gross` as `null`.
  Before U6 a failed `agents()` read printed `false` and `"0"`, which read as an
  inactive agent with withdrawals disabled. A `null` boolean is unknown, never
  `false`. Pinned by `get_agent::tests::get_agent_failed_agents_read_renders_null`.

### 3.7 Snapshot-test placement is per-command, not per-envelope

- **Decision.** The shared module ships smoke tests for `Source`, `Envelope`, `PartialBuilder`, and the decimal newtypes only. Snapshot tests over **rendered JSON for a real read command** live with each `commands/get_*.rs` module, one per read-command batch.
- **Rationale.** A snapshot test on the empty envelope alone tells you nothing about whether a real command's output drifts. The §9 acceptance criterion "Snapshot tests assert the envelope shape across commands" is satisfied by per-command snapshots, each of which exercises the shared module end-to-end. Centralizing them in `read_output` would couple the test fixture to whichever command was implemented first.

## 4. Surfaces locked for downstream issues

The following are the seams downstream read-command batches MUST consume. Adding new fields, renaming variants, or changing field order requires re-opening this ADR.

| Surface | Path | Purpose |
| --- | --- | --- |
| `Envelope<T>` | `read_output::Envelope` | Wire shape for every `get-*` command success output |
| `Source` | `read_output::Source` | Read provenance — `JsonRpc` only |
| `FieldError` | `read_output::FieldError` | One entry on the partial-read error list |
| `PartialBuilder<T>` | `read_output::PartialBuilder` | Aggregation seam for multi-read commands |
| `DecimalU256` | `read_output::DecimalU256` | `u256` field that serializes as a decimal string |
| `DecimalU128` | `read_output::DecimalU128` | `u128` field that serializes as a decimal string |

## 5. Stable RmpcError Reason-Code Variants

The variants below are the stable, product-visible API surface of
`RmpcError` (`clients/rust-payment-client/src/errors.rs`).  Agents and
operator tooling **must** match on these variant names (the prefix of every
`Display` output) rather than on human-readable message text.  Renaming any
variant is a breaking change; see `docs/architecture.md` §7.2.

| Variant | Display prefix | Product reason code (arch §7.2) | Raised by (QA plan U6) |
|---|---|---|---|
| `ErrVaultDisabled` | `ErrVaultDisabled:` | `vault_disabled` | simulated `PortfolioRouter.VaultNotRegistered` / `RedeemVaultNotRegistered` / `VaultNotActive` with status Retired; `RobotMoneyVault.VaultRetired` / `VaultShutdown` |
| `ErrPolicyExpired` | `ErrPolicyExpired:` | `expired_policy` | preflight `agents(self).validUntil < now`; simulated `RobotMoneyGateway.AgentPolicyExpired` |
| `ErrLegUnavailable` | `ErrLegUnavailable:` | `unavailable_leg` | router deposit preflight: `router.previewDeposit` marks a leg with weight above 0 unavailable and `--allow-unavailable-legs` is absent (security round 3); simulated `PortfolioRouter.VaultNotActive` (DepositsPaused) / `VaultNotRouterEligible` / `VaultCapExceeded` / `NoWeightsSet` / `NoFundedLeg` / `LegSkippedWithFloor` |
| `ErrSlippageBoundExceeded` | `ErrSlippageBoundExceeded:` | `slippage_bound_exceeded` | simulated `PortfolioRouter.SlippageExceeded` (deposit `minSharesPerLeg` or redeem `minAssetsPerLeg`) |
| `ErrDepositCapExceeded` | `ErrDepositCapExceeded:` | `cap_exceeded` | preflight `maxPerPayment` / `maxPerWindow`; simulated `AmountExceedsPerPaymentCap` / `WindowCapExceeded` |
| `ErrWithdrawCapExceeded` | `ErrWithdrawCapExceeded:` | `cap_exceeded` | preflight `maxWithdrawPerPayment` / `maxWithdrawPerWindow`; simulated `SharesExceedWithdrawPerPaymentCap` / `WithdrawWindowCapExceeded` |

Before U6 none of the first four was raised anywhere, a cap breach printed
`ErrConfig` and an expired policy printed `ErrAgentNotAuthorized` (finding
DR-7). Two refusals that are not reason codes were added with them:
`ErrAgentBindingMismatch` (the preflight's `agents(self).shareReceiver` or
`agentOwner(self)` differs from the config's `share_receiver` / `agent_owner`,
QA plan D2) and `ErrMinAssetsPerLegRequired` (`withdraw-router` without a
floor).

QA plan P3 (issue 1810) added `ErrImplementationNotApproved`. Every write
preflight and `rmpc agent-consent` read the gateway's ERC-1967
implementation slot and that implementation's code at one block. They refuse
unless its code hash is in the config's `gateway_implementation_hashes`. A
proxy keeps its own code hash across an upgrade, so `ErrCodeHashMismatch`
cannot see a new implementation. A failed read of either is a refusal, never
"not a proxy". `rmpc get-gateway` adds `implementation`,
`implementation_code_hash`, `configured_implementation_hashes`,
`implementation_approved`, `implementation_version`, `upgrade_authority` and
`upgrades_frozen` to its `data`, all read at the envelope's block; a direct
gateway reports `implementation: null`. The `checks` object of every write
gains `gateway_implementation_approved` and `gateway_implementation`.

### 5.0 Where the simulated names come from

`WriteSession::submit` runs the exact calldata as an `eth_call` from the agent
before it reads fees or the nonce (`policy::revert::simulate`). A revert whose
selector is in `policy::revert::refusal_from_revert` is refused by that name,
with the contract error named in `message`, and nothing is signed. A revert
with any other selector, or a simulation the node cannot run, is logged and
the write proceeds as before: an on-chain revert is still `ErrTxReverted`.

### 5.1 One owner for the variant-name table (issue #1285)

`RmpcError::name()` in `clients/rust-payment-client/src/errors.rs` is the
single source of the operator-visible name printed in a command's `error`
field. Its match is **exhaustive with no wildcard arm**, so adding a
variant without extending it is a compile error.

Do not re-derive the name anywhere else. Eight modules previously carried
their own copy of the table; two of them ended with `_ => "ErrUnknown"`,
so a variant added after those copies were written reached operators as
the string `ErrUnknown` — silently breaking the rule above with no
compiler signal. Two more derived the name by splitting the `Display`
output on whitespace, which is the same contract restated in a form that
cannot be checked.

The four router and policy variants are unit-free (no struct fields). The
two cap variants carry a detail string that names the cap. Their `Display`
strings are:

```
ErrVaultDisabled: target vault is not registered or has been disabled
ErrPolicyExpired: agent policy has expired (validUntil < block.timestamp)
ErrLegUnavailable: router leg vault is unavailable (deposits paused, full, or de-listed)
ErrSlippageBoundExceeded: a router leg falls below the caller's per-leg minimum bound
ErrDepositCapExceeded: <amount and the cap it exceeds>
ErrWithdrawCapExceeded: <shares and the cap it exceeds>
```

Every one of them is raised before the transaction is signed: by the
preflight, or from the revert data of the pre-sign simulation (§5.0). A mined
revert is not decoded; it stays `ErrTxReverted` with the `tx_hash`.

## 6. Newly discovered integration points and risks

- **`rmpc status` predates the envelope.** Migrating its output to `Envelope<StatusFound>` is a breaking change for any e2e test or downstream consumer that already parses the flat shape. Filed as an out-of-scope follow-up; not part of this scout. Recommend the migration land at the same time as the first `get-*` command, in a separate PR, so the operator-visible break is one event.
- **Pretty-printer is per-command today.** ~~`commands/status.rs::emit` carries its own pretty-vs-compact branch. Each new `get-*` command will duplicate that branch unless we lift `emit` into `read_output`.~~ **Resolved by issue #1285**: the duplication did show up — 19 byte-identical copies, two of which degraded to `unwrap_or_default()` and printed an empty document on a serialisation error. `emit` now lives in `clients/rust-payment-client/src/output.rs` and every command calls it. It is a sibling of `read_output` rather than part of it, because write commands emit through it too.
- **No CLI-flag commitment.** This ADR does not pick the `--block <n>` / `--block latest` flag spelling, the `--json` vs `--pretty` toggle, or whether `chain_id` is read from config or queried via `eth_chainId`. Those belong to the per-batch issues; the envelope is pinning-agnostic.
- **Reorg semantics are deferred.** `PartialBuilder` carries one `block_number` but does not enforce it across sub-reads. The first multi-read batch (`get-vault` is the most likely candidate) owns the choice between "pin once via `eth_blockNumber` then issue all sub-reads against that tag" and "issue against `latest` and surface drift via `_meta.block_drift`". Recommend the former — it's stricter, and §9's "block_number" is naturally a single value.
- **Indexer source variant.** §9 explicitly allows future explorer enrichment as long as JSON-RPC remains the source of truth. If/when that lands, `Source` gains an `Indexer` variant and consumers learn to ignore commands with `source: "indexer"` for safety-critical flows. Out of scope here; flagged as a known future ADR trigger.

## 7. References

- `Plan tracking issue #109` §9 — Phase 3 Direct Chain-Read Query Tooling, "Output contract"
- `clients/rust-payment-client/src/read_output.rs` — stub module implementing the surfaces above
- `clients/rust-payment-client/src/commands/status.rs` — predates the envelope; migration deferred
