//! Canonical: docs/implementation-plan.md §4 — Phase 1 Rust client (operator-visible error catalog)
//!
//! Named error variants used across the rmpc codebase.
//!
//! Variant names are part of the operator-visible contract: the CLI prints
//! the variant name (via `Display`) on the failure path, and downstream
//! tooling matches on those strings. Renaming a variant is a breaking change.

use thiserror::Error;

/// Top-level error type for the payment daemon.
///
/// The `Err`-prefixed variant names are mandated by issue #7 / the MVP doc
/// so they match the on-the-wire/log strings. The clippy lint that flags
/// shared prefixes is therefore suppressed at the type level.
#[derive(Debug, Error)]
#[allow(clippy::enum_variant_names)]
pub enum RmpcError {
    #[error("ErrAgentNotAuthorized: agent address is not registered with the gateway")]
    ErrAgentNotAuthorized,

    #[error("ErrFeeCapExceeded: computed maxFeePerGas exceeds operator-configured cap")]
    ErrFeeCapExceeded,

    #[error("ErrConcurrentInvocation: another rmpc invocation already holds the agent lock")]
    ErrConcurrentInvocation,

    #[error("ErrCodeHashMismatch: keccak256(eth_getCode(gateway)) does not match pinned hash")]
    ErrCodeHashMismatch,

    #[error("ErrChainIdMismatch: RPC eth_chainId does not match configured chain_id")]
    ErrChainIdMismatch,

    #[error("ErrGatewayPaused: gateway contract reports paused() == true")]
    ErrGatewayPaused,

    #[error("ErrAllowanceInsufficient: USDC allowance(self, gateway) < amount")]
    ErrAllowanceInsufficient,

    #[error("ErrBalanceInsufficient: USDC balanceOf(self) < amount")]
    ErrBalanceInsufficient,

    #[error("ErrSoftwareSignerDisallowed: [signer].allow_software_fallback must be true")]
    ErrSoftwareSignerDisallowed,

    /// The same `(order_id, idempotency_key, deadline)` tuple was
    /// already submitted from this client; the local replay cache
    /// returns the prior `tx_hash` instead of re-broadcasting. Audit
    /// finding M3.
    #[error(
        "ErrOrderIdAlreadySubmitted: order_id was already submitted (prior tx_hash={tx_hash})"
    )]
    ErrOrderIdAlreadySubmitted { tx_hash: String },

    /// The broadcast transaction was mined but reverted (`status == 0` in
    /// the receipt). Carries the transaction hash so operators can pull
    /// the trace.
    #[error("ErrTxReverted: transaction reverted on-chain (tx_hash={tx_hash})")]
    ErrTxReverted { tx_hash: String },

    /// The deposit landed in a block but the gateway emitted no
    /// `AgentDeposit` log — invariant violation. Operator must inspect.
    #[error("ErrAgentDepositLogMissing: receipt has no AgentDeposit log (tx_hash={tx_hash})")]
    ErrAgentDepositLogMissing { tx_hash: String },

    /// The vault being redeemed from is paused — hard refusal before signing.
    #[error("ErrVaultPaused: source vault reports paused() == true")]
    ErrVaultPaused,

    /// Shares to withdraw exceed the agent's `maxWithdrawPerPayment` policy cap.
    #[error("ErrWithdrawCapExceeded: shares exceed agent maxWithdrawPerPayment policy cap")]
    ErrWithdrawCapExceeded,

    /// The agent holds fewer vault shares than the requested withdrawal amount.
    #[error("ErrShareBalanceInsufficient: agent vault share balance < requested shares")]
    ErrShareBalanceInsufficient,

    /// The vault share allowance(agent, gateway) is less than the requested shares.
    #[error(
        "ErrShareAllowanceInsufficient: vault share allowance(agent, gateway) < requested shares"
    )]
    ErrShareAllowanceInsufficient,

    /// The withdraw landed in a block but the gateway emitted no
    /// `AgentWithdraw` log — invariant violation. Operator must inspect.
    #[error("ErrAgentWithdrawLogMissing: receipt has no AgentWithdraw log (tx_hash={tx_hash})")]
    ErrAgentWithdrawLogMissing { tx_hash: String },

    #[error("ErrConfig: configuration error: {0}")]
    ErrConfig(String),

    #[error("ErrIo: I/O error: {0}")]
    ErrIo(#[from] std::io::Error),

    #[error("ErrTomlParse: TOML parse error: {0}")]
    ErrTomlParse(#[from] toml::de::Error),

    /// Transport-level RPC failure — DNS, TCP, TLS, HTTP non-2xx, etc.
    /// Anything that prevents us from getting a JSON-RPC response body.
    #[error("ErrRpcTransport: JSON-RPC transport error: {0}")]
    ErrRpcTransport(String),

    /// Server returned a JSON-RPC error object (`{ "error": { code, message } }`).
    /// Code is preserved verbatim — operator tooling matches on it.
    #[error("ErrRpcServer: JSON-RPC server error code={code} message={message}")]
    ErrRpcServer { code: i64, message: String },

    /// The response body was malformed: not JSON, missing `result`, or the
    /// `result` field could not be deserialised into the expected shape.
    #[error("ErrRpcDecode: JSON-RPC response decode error: {0}")]
    ErrRpcDecode(String),
}

pub type Result<T> = std::result::Result<T, RmpcError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variant_names_render_via_display() {
        // The variant name must be the prefix of the Display output —
        // operator tooling matches on these strings.
        let cases: &[(RmpcError, &str)] = &[
            (RmpcError::ErrAgentNotAuthorized, "ErrAgentNotAuthorized"),
            (RmpcError::ErrFeeCapExceeded, "ErrFeeCapExceeded"),
            (
                RmpcError::ErrConcurrentInvocation,
                "ErrConcurrentInvocation",
            ),
            (RmpcError::ErrCodeHashMismatch, "ErrCodeHashMismatch"),
            (RmpcError::ErrChainIdMismatch, "ErrChainIdMismatch"),
            (RmpcError::ErrGatewayPaused, "ErrGatewayPaused"),
            (
                RmpcError::ErrAllowanceInsufficient,
                "ErrAllowanceInsufficient",
            ),
            (RmpcError::ErrBalanceInsufficient, "ErrBalanceInsufficient"),
            (
                RmpcError::ErrSoftwareSignerDisallowed,
                "ErrSoftwareSignerDisallowed",
            ),
            (
                RmpcError::ErrOrderIdAlreadySubmitted {
                    tx_hash: "0x00".into(),
                },
                "ErrOrderIdAlreadySubmitted",
            ),
        ];
        for (err, name) in cases {
            let s = format!("{err}");
            assert!(
                s.starts_with(name),
                "Display output {s:?} does not start with variant name {name:?}",
            );
        }
    }

    #[test]
    fn config_error_carries_message() {
        let e = RmpcError::ErrConfig("bad field".into());
        assert!(format!("{e}").contains("bad field"));
    }
}
