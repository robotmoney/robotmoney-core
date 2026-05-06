//! Named error variants used across the rmpd codebase.
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
pub enum RmpdError {
    #[error("ErrAgentNotAuthorized: agent address is not registered with the gateway")]
    ErrAgentNotAuthorized,

    #[error("ErrFeeCapExceeded: computed maxFeePerGas exceeds operator-configured cap")]
    ErrFeeCapExceeded,

    #[error("ErrConcurrentInvocation: another rmpd invocation already holds the agent lock")]
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

    #[error("ErrConfig: configuration error: {0}")]
    ErrConfig(String),

    #[error("ErrIo: I/O error: {0}")]
    ErrIo(#[from] std::io::Error),

    #[error("ErrTomlParse: TOML parse error: {0}")]
    ErrTomlParse(#[from] toml::de::Error),
}

pub type Result<T> = std::result::Result<T, RmpdError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variant_names_render_via_display() {
        // The variant name must be the prefix of the Display output —
        // operator tooling matches on these strings.
        let cases: &[(RmpdError, &str)] = &[
            (RmpdError::ErrAgentNotAuthorized, "ErrAgentNotAuthorized"),
            (RmpdError::ErrFeeCapExceeded, "ErrFeeCapExceeded"),
            (
                RmpdError::ErrConcurrentInvocation,
                "ErrConcurrentInvocation",
            ),
            (RmpdError::ErrCodeHashMismatch, "ErrCodeHashMismatch"),
            (RmpdError::ErrChainIdMismatch, "ErrChainIdMismatch"),
            (RmpdError::ErrGatewayPaused, "ErrGatewayPaused"),
            (
                RmpdError::ErrAllowanceInsufficient,
                "ErrAllowanceInsufficient",
            ),
            (RmpdError::ErrBalanceInsufficient, "ErrBalanceInsufficient"),
            (
                RmpdError::ErrSoftwareSignerDisallowed,
                "ErrSoftwareSignerDisallowed",
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
        let e = RmpdError::ErrConfig("bad field".into());
        assert!(format!("{e}").contains("bad field"));
    }
}
