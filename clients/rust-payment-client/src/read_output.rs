//! Canonical: docs/implementation-plan.md §9 — Phase 3 Direct Chain-Read Query Tooling
//! ADR: docs/technical/rmpc-read-output-contract.md
//!
//! Shared output contract for all `rmpc get-*` read commands.
//!
//! # Why this module exists
//!
//! Implementation-plan §9 ("Output contract") binds every read command to one
//! shared envelope: large integers as decimal strings, top-level `chain_id`,
//! `block_number`, and `source: "json_rpc"`, plus a `partial` flag and a
//! per-field error list when a multi-read command's sub-reads fail
//! independently. That contract is what makes `rmpc` consumable by agents,
//! shell scripts, and the Phase 5 explorer indexer without any of them
//! having to special-case per-command shapes.
//!
//! Issue #51 is the **dev-scout** for this contract: it locks down the
//! envelope shape, the partial-aggregation seam, and the type-level
//! invariants (no JSON numbers for `u256`/`u128`) before the read-command
//! batches in Phase 3 land. Real serializers wire to these stubs; this
//! file ships compiling no-op surfaces only — runtime behavior is added
//! by the per-command implementation issues that follow.
//!
//! # Surfaces locked here (for downstream issues)
//!
//! - [`Envelope<T>`] — the wire-shape every command's success output
//!   serializes to. Generic over the per-command `data` payload `T`.
//! - [`Source`] — the constant tag identifying where the read was sourced
//!   from. `Source::JsonRpc` is the only variant for §9; explorer/indexer
//!   sources are explicitly out of scope.
//! - [`FieldError`] — a per-field error entry on the partial-read list.
//!   Used by multi-read commands (`get-vault`, `get-agent`, `get-gateway`)
//!   when one sub-read succeeds and another fails.
//! - [`PartialBuilder`] — the aggregation seam multi-read commands use to
//!   collect sub-read results, decide the `partial` flag, and produce a
//!   final [`Envelope`].
//! - [`DecimalU256`] / [`DecimalU128`] — newtype wrappers whose `Serialize`
//!   impl emits a JSON string, never a number. The type system enforces
//!   the §9 "decimal-string large integers" rule at compile time.
//!
//! # Non-goals
//!
//! - No JSON-RPC client wiring. The shared envelope only sees post-decoded
//!   values; transport lives in `crate::rpc`.
//! - No per-command field schema. `get-vault`, `get-balance`, etc. each
//!   define their own `data` payload type and snapshot-test it.
//! - No CLI flags, no pretty-printer behavior change. Pretty-printing is
//!   already a per-command concern (see `commands/status.rs::emit`).
//!
//! # Migration plan
//!
//! Existing `commands/status.rs` predates this contract and emits a
//! flatter shape. §9 read commands ship in a new `commands/get_*.rs`
//! family that uses [`Envelope`] from day one. Migrating `status` to the
//! envelope is a follow-up issue (filed separately if surfaced by
//! downstream batches), not part of #51.

#![allow(dead_code)]

use serde::{Serialize, Serializer};

use crate::network_env::NetworkEnv;

/// Source of a read response. Locked to JSON-RPC for §9; future variants
/// (e.g. `Indexer`) are explicitly out of scope and would require a new
/// dev-scout to extend the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Direct `eth_call` / `eth_getLogs` against a configured RPC endpoint.
    JsonRpc,
}

impl Source {
    /// Stable wire string for this source. Part of the operator-visible
    /// contract; downstream snapshot tests assert on the literal value.
    pub const fn as_str(self) -> &'static str {
        match self {
            Source::JsonRpc => "json_rpc",
        }
    }
}

impl Serialize for Source {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// Per-field error entry on a partial multi-read response. The `field`
/// path is dotted (`"vault.totalAssets"`, `"adapters[2].balance"`) so a
/// caller can locate the missing value inside `data`.
#[derive(Debug, Clone, Serialize)]
pub struct FieldError {
    /// Dotted JSON path of the field whose sub-read failed.
    pub field: String,
    /// Operator-actionable error message. Never includes secrets, RPC
    /// URLs, or signer material — only the failure category and any
    /// chain-side revert reason.
    pub message: String,
}

/// Stable read-command envelope. Every `rmpc get-*` command's stdout
/// document deserializes to this shape with a command-specific `data`.
///
/// Field order in the JSON document is the source-declaration order
/// below. Snapshot tests assert on it.
#[derive(Debug, Serialize)]
pub struct Envelope<T: Serialize> {
    /// EIP-155 chain id of the RPC the read was issued against.
    pub chain_id: u64,
    /// Block number the read was pinned to. For multi-read commands this
    /// is the block at which all sub-reads were issued (callers MUST pin
    /// to the same block; see [`PartialBuilder`]).
    pub block_number: u64,
    /// Where the read came from. Locked to [`Source::JsonRpc`] in §9.
    pub source: Source,
    /// Machine-readable network environment label derived from [`chain_id`].
    ///
    /// Stable values: `"local_devnet"`, `"rm_testnet"`, `"production_base"`,
    /// `"unknown"`. Consumers MUST NOT match on the integer `chain_id`; they
    /// SHOULD match on this string so the mapping can be extended without
    /// breaking consumers.
    pub network_env: NetworkEnv,
    /// `true` if any sub-read in a multi-read command failed. `false`
    /// for single-read commands and for fully-successful multi-reads.
    pub partial: bool,
    /// Per-field error list. Empty when `partial` is `false`. Always
    /// emitted (never `None`) so consumers can branch on `.length`
    /// without an `Option` check.
    pub errors: Vec<FieldError>,
    /// Command-specific payload. Each command defines its own type; the
    /// only shared rule is that `u256`/`u128` fields use
    /// [`DecimalU256`] / [`DecimalU128`] so they serialize as strings.
    pub data: T,
}

/// Aggregator for multi-read commands. Sub-reads call [`record_ok`] /
/// [`record_err`]; on completion the builder hands back a finalized
/// [`Envelope`]. Stub today — real impl lands with the first multi-read
/// command (`get-vault`).
///
/// Design notes for the implementer:
/// - Sub-reads MUST share a single `block_number`. If a sub-read returns
///   from a different block (chain reorg between sub-reads), the builder
///   should mark the whole envelope `partial: true` with a synthetic
///   `FieldError { field: "_meta.block_drift", … }`.
/// - The builder owns the `data` payload mutably; callers pass a closure
///   to fill in fields on success and the builder records the field name
///   on failure. This keeps the per-field path string in one place.
pub struct PartialBuilder<T> {
    chain_id: u64,
    block_number: u64,
    errors: Vec<FieldError>,
    data: T,
}

impl<T: Serialize> PartialBuilder<T> {
    /// Construct a builder with the pinned block and the zero-value
    /// payload. `data` is mutated in place by sub-read closures.
    pub fn new(chain_id: u64, block_number: u64, data: T) -> Self {
        Self {
            chain_id,
            block_number,
            errors: Vec::new(),
            data,
        }
    }

    /// Mutable handle on the in-progress payload. Sub-read closures use
    /// this to write decoded values when their RPC call succeeded.
    pub fn data_mut(&mut self) -> &mut T {
        &mut self.data
    }

    /// Record a sub-read failure against a dotted JSON path.
    pub fn record_err(&mut self, field: impl Into<String>, message: impl Into<String>) {
        self.errors.push(FieldError {
            field: field.into(),
            message: message.into(),
        });
    }

    /// Finalize into an [`Envelope`]. `partial` is `true` iff any
    /// [`record_err`](Self::record_err) call was made.
    pub fn finish(self) -> Envelope<T> {
        Envelope {
            chain_id: self.chain_id,
            block_number: self.block_number,
            source: Source::JsonRpc,
            network_env: NetworkEnv::from_chain_id(self.chain_id),
            partial: !self.errors.is_empty(),
            errors: self.errors,
            data: self.data,
        }
    }
}

/// Newtype around `alloy_primitives::U256` whose `Serialize` impl emits
/// a JSON **string** in decimal form. Use this for any vault asset
/// amount, share supply, cap, or window-usage value.
///
/// The wrapper exists so the type system rejects the bug §9 explicitly
/// guards against: a downstream command writing a raw `u256` into its
/// `data` struct and accidentally serializing it as a JSON number
/// (alloy's default impl for some integer types does that). This is a
/// no-op stub today; the real impl lands in the first command that
/// needs it.
#[derive(Debug, Clone, Copy, Default)]
pub struct DecimalU256(pub alloy_primitives::U256);

impl Serialize for DecimalU256 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        // U256's Display is decimal. Stringify via Display, never via
        // U256's serde impl, which can emit hex.
        s.collect_str(&self.0)
    }
}

/// Same as [`DecimalU256`] but for `u128`-shaped values (e.g. ERC-20
/// allowances on adapters that return `uint128`, or per-window caps
/// stored as `uint128`). Provided as a distinct type so callers can't
/// accidentally widen — widths are part of the on-chain truth.
#[derive(Debug, Clone, Copy, Default)]
pub struct DecimalU128(pub u128);

impl Serialize for DecimalU128 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    //! Stub-level smoke tests. Real snapshot tests for the §9 envelope
    //! land with the first `get-*` command in the read-command batch.
    //! These exist only to prove the types compile and that the
    //! string-serialization invariant (the §9 type-check criterion)
    //! holds for the wrapper newtypes.

    use super::*;
    use serde_json::json;

    #[derive(Serialize)]
    struct EmptyData {}

    #[test]
    fn source_serializes_as_json_rpc_string() {
        let v = serde_json::to_value(Source::JsonRpc).unwrap();
        assert_eq!(v, json!("json_rpc"));
    }

    #[test]
    fn envelope_clean_has_partial_false_and_empty_errors() {
        let env: Envelope<EmptyData> = PartialBuilder::new(8453, 12_345_678, EmptyData {}).finish();
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["chain_id"], 8453);
        assert_eq!(v["block_number"], 12_345_678);
        assert_eq!(v["source"], "json_rpc");
        assert_eq!(v["network_env"], "production_base");
        assert_eq!(v["partial"], false);
        assert!(v["errors"].as_array().unwrap().is_empty());
    }

    #[test]
    fn envelope_with_subread_failure_marks_partial() {
        let mut b = PartialBuilder::new(8453, 12_345_678, EmptyData {});
        b.record_err("vault.totalAssets", "eth_call reverted: 0x");
        let env = b.finish();
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["partial"], true);
        assert_eq!(v["network_env"], "production_base");
        assert_eq!(v["errors"][0]["field"], "vault.totalAssets");
        assert_eq!(v["errors"][0]["message"], "eth_call reverted: 0x");
    }

    #[test]
    fn envelope_network_env_reflects_chain_id() {
        // Local devnet (31337)
        let env: Envelope<EmptyData> = PartialBuilder::new(31337, 1, EmptyData {}).finish();
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["network_env"], "local_devnet");

        // RM testnet (84532)
        let env: Envelope<EmptyData> = PartialBuilder::new(84532, 1, EmptyData {}).finish();
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["network_env"], "rm_testnet");

        // Unknown chain
        let env: Envelope<EmptyData> = PartialBuilder::new(424_242, 1, EmptyData {}).finish();
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["network_env"], "unknown");
    }

    #[test]
    fn decimal_u256_serializes_as_string_never_number() {
        // 2^200 — well outside any JSON number's safe range. If this
        // ever serializes as a number, JSON.parse on the consumer side
        // silently truncates and the §9 contract is broken.
        let big = alloy_primitives::U256::from(1u8) << 200;
        let v = serde_json::to_value(DecimalU256(big)).unwrap();
        assert!(v.is_string(), "DecimalU256 must serialize as JSON string");
        assert_eq!(v.as_str().unwrap(), big.to_string());
    }

    #[test]
    fn decimal_u128_serializes_as_string_never_number() {
        let big = u128::MAX;
        let v = serde_json::to_value(DecimalU128(big)).unwrap();
        assert!(v.is_string(), "DecimalU128 must serialize as JSON string");
        assert_eq!(v.as_str().unwrap(), big.to_string());
    }
}
