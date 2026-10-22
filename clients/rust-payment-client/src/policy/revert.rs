//! Canonical: docs/technical/rmpc-read-output-contract.md §5 — Stable RmpcError reason-code variants
//! (See also: docs/architecture.md §7.2 — Execution Results)
//!
//! Pre-sign simulation of a write, and the one table that turns a contract
//! revert into a named [`RmpcError`] (QA plan U6, finding DR-7).
//!
//! The read-output contract documents `ErrVaultDisabled`, `ErrPolicyExpired`
//! and `ErrDestinationNotSelected` as "decoded from a mined or simulated
//! transaction". Before U6 nothing decoded them: the variants
//! existed and no code path raised them. [`simulate`] runs the exact calldata
//! the agent is about to sign as an `eth_call` from the agent's address. A
//! revert whose selector is in [`refusal_from_revert`] becomes a refusal with
//! that name, before any fee read, nonce read or signature.
//!
//! A revert rmpc has no name for, or a simulation the node could not run, is
//! [`Simulation::Inconclusive`]: the write goes ahead exactly as it did before
//! U6. The preflight stays the authority. The simulation only names reverts
//! the chain would have produced anyway, without burning gas to learn them.

use alloy_primitives::{hex, Address, Bytes};
use alloy_sol_types::SolError;

use crate::errors::RmpcError;
use crate::gateway::RobotMoneyGateway;
use crate::rpc::{CallOutcome, CallRequest, FailoverRpcClient};

/// Vault-level errors a single-vault deposit can bubble up through the
/// gateway. The `IVault` binding carries no errors, so they are declared
/// here from `contracts/RobotMoneyVault.sol`.
mod vault_errors {
    alloy_sol_types::sol! {
        error VaultRetired();
        error VaultShutdown();
    }
}

/// What the pre-sign simulation of a write found.
#[derive(Debug)]
pub enum Simulation {
    /// The call returned. The write is expected to succeed.
    Passed,
    /// The call reverted with a product reason rmpc names. `revert` is the
    /// contract error the selector belongs to, for the refusal message.
    Refused {
        revert: &'static str,
        err: RmpcError,
    },
    /// The call reverted with a payload rmpc has no name for, or the node
    /// could not run it. The write proceeds; the string says why.
    Inconclusive(String),
}

/// `eth_call` the write's calldata from `from` to `to` at `latest` and
/// classify the answer. Never errors: an RPC failure is
/// [`Simulation::Inconclusive`].
pub async fn simulate(
    rpc: &FailoverRpcClient,
    from: Address,
    to: Address,
    calldata: &[u8],
) -> Simulation {
    let req = CallRequest {
        to,
        from: Some(from),
        data: Bytes::copy_from_slice(calldata),
    };
    match rpc.eth_call_outcome(&req, None).await {
        Ok(CallOutcome::Returned(_)) => Simulation::Passed,
        Ok(CallOutcome::Reverted { data, message }) => match refusal_from_revert(&data) {
            Some((revert, err)) => Simulation::Refused { revert, err },
            None => Simulation::Inconclusive(format!(
                "simulated call reverted ({message}) with unrecognised data 0x{}",
                hex::encode(&data)
            )),
        },
        Err(e) => Simulation::Inconclusive(format!("simulation could not run: {e}")),
    }
}

/// True when `data` starts with `E`'s 4-byte selector.
fn is<E: SolError>(data: &[u8]) -> bool {
    data.len() >= 4 && data[..4] == E::SELECTOR
}

/// The named refusal for a revert payload, with the contract error's name.
/// `None` for a payload rmpc has no product reason for.
///
/// Gateway reverts come first, then vault reverts `depositTo` bubbles up. `DepositsArePaused()` is one selector on the
/// gateway and on every vault.
pub fn refusal_from_revert(data: &[u8]) -> Option<(&'static str, RmpcError)> {
    // -- Gateway policy ---------------------------------------------------
    if is::<RobotMoneyGateway::AgentPolicyExpired>(data) {
        return Some(("AgentPolicyExpired", RmpcError::ErrPolicyExpired));
    }
    if is::<RobotMoneyGateway::AgentNotAuthorized>(data) {
        return Some(("AgentNotAuthorized", RmpcError::ErrAgentNotAuthorized));
    }
    if is::<RobotMoneyGateway::AmountExceedsPerPaymentCap>(data) {
        return Some((
            "AmountExceedsPerPaymentCap",
            RmpcError::ErrDepositCapExceeded("amount exceeds the agent's maxPerPayment".into()),
        ));
    }
    if is::<RobotMoneyGateway::WindowCapExceeded>(data) {
        return Some((
            "WindowCapExceeded",
            RmpcError::ErrDepositCapExceeded(
                "rolling deposit window gross plus amount exceeds the agent's maxPerWindow".into(),
            ),
        ));
    }
    if is::<RobotMoneyGateway::InvalidDestination>(data) {
        // The gateway pins no vault: the destination is not in the policy list.
        return Some((
            "InvalidDestination",
            RmpcError::ErrDestinationNotSelected(
                "the gateway policy's allowedDestinations does not list this vault".into(),
            ),
        ));
    }
    if is::<RobotMoneyGateway::DepositsArePaused>(data) {
        return Some(("DepositsArePaused", RmpcError::ErrDepositsPaused));
    }

    // -- Vault ------------------------------------------------------------
    if is::<vault_errors::VaultRetired>(data) {
        return Some(("VaultRetired", RmpcError::ErrVaultDisabled));
    }
    if is::<vault_errors::VaultShutdown>(data) {
        return Some(("VaultShutdown", RmpcError::ErrVaultDisabled));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, keccak256};
    use mockito::Matcher;
    use serde_json::json;

    fn sel(sig: &str) -> Vec<u8> {
        keccak256(sig.as_bytes())[..4].to_vec()
    }

    /// The bindings' selectors are the canonical signatures in the
    /// contracts. A renamed or re-typed error would otherwise stop matching
    /// without any test noticing.
    #[test]
    fn mapped_selectors_match_the_canonical_signatures() {
        for (sig, got) in [
            (
                "AgentPolicyExpired()",
                RobotMoneyGateway::AgentPolicyExpired::SELECTOR,
            ),
            (
                "AmountExceedsPerPaymentCap()",
                RobotMoneyGateway::AmountExceedsPerPaymentCap::SELECTOR,
            ),
            (
                "WindowCapExceeded()",
                RobotMoneyGateway::WindowCapExceeded::SELECTOR,
            ),
            (
                "InvalidDestination()",
                RobotMoneyGateway::InvalidDestination::SELECTOR,
            ),
            ("VaultRetired()", vault_errors::VaultRetired::SELECTOR),
        ] {
            assert_eq!(got.to_vec(), sel(sig), "{sig}");
        }
    }

    /// Every documented reason code is reachable from its revert
    /// (rmpc-read-output-contract.md §5).
    #[test]
    fn documented_reverts_map_to_their_reason_codes() {
        let cases: [(&str, &str); 8] = [
            ("AgentPolicyExpired()", "ErrPolicyExpired"),
            ("AgentNotAuthorized()", "ErrAgentNotAuthorized"),
            ("AmountExceedsPerPaymentCap()", "ErrDepositCapExceeded"),
            ("WindowCapExceeded()", "ErrDepositCapExceeded"),
            ("InvalidDestination()", "ErrDestinationNotSelected"),
            ("DepositsArePaused()", "ErrDepositsPaused"),
            ("VaultRetired()", "ErrVaultDisabled"),
            ("VaultShutdown()", "ErrVaultDisabled"),
        ];
        for (sig, want) in cases {
            let (_, err) = refusal_from_revert(&sel(sig)).unwrap_or_else(|| panic!("{sig}"));
            assert_eq!(err.name(), want, "{sig}");
        }
    }

    #[test]
    fn unknown_or_short_payloads_have_no_name() {
        assert!(refusal_from_revert(&[]).is_none());
        assert!(refusal_from_revert(&[0x81, 0x99]).is_none());
        assert!(refusal_from_revert(&sel("PaymentIdAlreadyUsed()")).is_none());
        // Error(string): a require message is not a product reason.
        assert!(refusal_from_revert(&sel("Error(string)")).is_none());
    }

    /// The simulation sends the write's calldata from the agent and names an
    /// unlisted-destination revert before anything is signed.
    #[tokio::test]
    async fn simulate_names_an_invalid_destination_revert() {
        let agent = address!("00000000000000000000000000000000000000aa");
        let gateway = address!("0000000000000000000000000000000000000b00");
        let calldata = [0xde, 0xad, 0xbe, 0xef, 0x01];
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/")
            .match_body(Matcher::AllOf(vec![
                Matcher::PartialJson(json!({"method": "eth_call"})),
                Matcher::Regex(r#""data":"0xdeadbeef01""#.into()),
                Matcher::Regex(format!(r#"(?i)"from":"{agent:#x}""#)),
            ]))
            .with_status(200)
            .with_body(format!(
                r#"{{"jsonrpc":"2.0","id":1,"error":{{"code":3,"message":"execution reverted","data":"0x{}"}}}}"#,
                hex::encode(sel("InvalidDestination()"))
            ))
            .expect(1)
            .create_async()
            .await;
        let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
        match simulate(&rpc, agent, gateway, &calldata).await {
            Simulation::Refused { revert, err } => {
                assert_eq!(revert, "InvalidDestination");
                assert_eq!(err.name(), "ErrDestinationNotSelected");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        m.assert_async().await;
    }

    /// An unnamed revert and an unreachable node are both inconclusive, so
    /// the write keeps its pre-U6 behaviour.
    #[tokio::test]
    async fn simulate_is_inconclusive_for_unknown_reverts_and_dead_nodes() {
        let agent = address!("00000000000000000000000000000000000000aa");
        let gateway = address!("0000000000000000000000000000000000000b00");
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/")
            .with_status(200)
            .with_body(r#"{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x12345678"}}"#)
            .create_async()
            .await;
        let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
        assert!(matches!(
            simulate(&rpc, agent, gateway, &[0x01]).await,
            Simulation::Inconclusive(_)
        ));

        let dead = FailoverRpcClient::new(vec!["http://127.0.0.1:1".into()]).unwrap();
        assert!(matches!(
            simulate(&dead, agent, gateway, &[0x01]).await,
            Simulation::Inconclusive(_)
        ));
    }
}
