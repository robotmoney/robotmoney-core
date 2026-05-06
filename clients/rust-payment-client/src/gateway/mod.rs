//! `gateway` module — typed `alloy-sol-types` bindings for the on-chain
//! contracts the daemon interacts with.
//!
//! Per issue #11 and `docs/implementation-plan-mvp.md` §3.5: typed ABI
//! encode/decode for `RobotMoneyGateway`, plus read-side bindings for the
//! `MockUSDC` / ERC-20 `allowance`+`balanceOf` views and the `MockVault`
//! used by tests. The ABIs are extracted from the Foundry build output and
//! committed under `clients/rust-payment-client/abi/` so the Rust crate is
//! buildable without re-running `forge build`.
//!
//! Only the typed call/event/error structs are exposed — no provider
//! abstraction is built here. Tx construction lives in `tx`, and the
//! JSON-RPC transport lives in [`crate::rpc`]. Keeping those concerns
//! separate matches §3.5 ("the Rust binary must remain the only path to a
//! signed deposit tx; no alloy provider is exposed externally").

use alloy_sol_types::sol;

sol!(
    #[sol(abi)]
    #[allow(missing_docs, clippy::too_many_arguments)]
    RobotMoneyGateway,
    "abi/RobotMoneyGateway.json"
);

sol!(
    #[sol(abi)]
    #[allow(missing_docs, clippy::too_many_arguments)]
    MockUsdc,
    "abi/MockUSDC.json"
);

sol!(
    #[sol(abi)]
    #[allow(missing_docs, clippy::too_many_arguments)]
    MockVault,
    "abi/MockVault.json"
);

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, b256, keccak256, Address, Bytes, LogData, B256, U256};
    use alloy_sol_types::{SolCall, SolError, SolEvent};

    /// The `deposit` selector must match `keccak256("deposit(bytes32,uint256,uint64,bytes32)")[..4]`.
    /// This is the load-bearing cross-check that the generated bindings line
    /// up with the Solidity ABI committed in `contracts/gateway/`.
    #[test]
    fn deposit_selector_matches_canonical_signature() {
        let canonical = "deposit(bytes32,uint256,uint64,bytes32)";
        let expected = &keccak256(canonical.as_bytes())[..4];
        let actual = RobotMoneyGateway::depositCall::SELECTOR;
        assert_eq!(&actual, expected, "deposit selector drift");
    }

    /// `authorizeAgent(address,(bool,uint64,uint256,uint256,address))` —
    /// ensure the tuple layout matches the on-chain ABI.
    #[test]
    fn authorize_agent_selector_matches() {
        let canonical = "authorizeAgent(address,(bool,uint64,uint256,uint256,address))";
        let expected = &keccak256(canonical.as_bytes())[..4];
        let actual = RobotMoneyGateway::authorizeAgentCall::SELECTOR;
        assert_eq!(&actual, expected);
    }

    #[test]
    fn paused_view_selector_matches() {
        let expected = &keccak256(b"paused()")[..4];
        let actual = RobotMoneyGateway::pausedCall::SELECTOR;
        assert_eq!(&actual, expected);
    }

    #[test]
    fn agent_not_authorized_error_selector_matches() {
        let expected = &keccak256(b"AgentNotAuthorized()")[..4];
        let actual = RobotMoneyGateway::AgentNotAuthorized::SELECTOR;
        assert_eq!(&actual, expected);
    }

    /// Round-trip an `AgentDeposit` log: ABI-encode a synthetic event, then
    /// decode it back through the bindings. This exercises both the topic0
    /// hash and the data layout (3 indexed + 4 unindexed fields).
    #[test]
    fn agent_deposit_event_roundtrip() {
        let payment_id = b256!("1111111111111111111111111111111111111111111111111111111111111111");
        let order_id = b256!("2222222222222222222222222222222222222222222222222222222222222222");
        let agent: Address = address!("00000000000000000000000000000000000000aa");
        let share_receiver: Address = address!("00000000000000000000000000000000000000bb");
        let amount = U256::from(123_456u64);
        let shares = U256::from(987_654u64);
        let window_id = 42u64;

        let ev = RobotMoneyGateway::AgentDeposit {
            paymentId: payment_id,
            orderId: order_id,
            agent,
            shareReceiver: share_receiver,
            amount,
            sharesMinted: shares,
            windowId: window_id,
        };

        let topics = ev.encode_topics();
        let data: Vec<u8> = ev.encode_data();
        let log = LogData::new_unchecked(
            topics.iter().map(|t| B256::from(t.0)).collect(),
            Bytes::from(data),
        );

        let decoded =
            RobotMoneyGateway::AgentDeposit::decode_log_data(&log, true).expect("decode log");

        assert_eq!(decoded.paymentId, payment_id);
        assert_eq!(decoded.orderId, order_id);
        assert_eq!(decoded.agent, agent);
        assert_eq!(decoded.shareReceiver, share_receiver);
        assert_eq!(decoded.amount, amount);
        assert_eq!(decoded.sharesMinted, shares);
        assert_eq!(decoded.windowId, window_id);

        let expected_topic0 =
            keccak256(b"AgentDeposit(bytes32,bytes32,address,address,uint256,uint256,uint64)");
        assert_eq!(B256::from(topics[0].0), expected_topic0);
    }

    /// Encoding `agents(address)` and decoding the 5-tuple return value
    /// proves the view bindings line up. We hand-roll the return blob from
    /// `(bool,uint64,uint256,uint256,address)` so the test does not depend
    /// on a live RPC.
    #[test]
    fn agents_view_decodes_5_tuple() {
        let mut blob = Vec::with_capacity(32 * 5);
        // active = true
        let mut w = [0u8; 32];
        w[31] = 1;
        blob.extend_from_slice(&w);
        // validUntil = 1_700_000_000
        let v: u64 = 1_700_000_000;
        let mut w = [0u8; 32];
        w[24..].copy_from_slice(&v.to_be_bytes());
        blob.extend_from_slice(&w);
        // maxPerPayment = 1_000_000 (1 USDC, 6 decimals)
        blob.extend_from_slice(&U256::from(1_000_000u64).to_be_bytes::<32>());
        // maxPerWindow = 100_000_000 (100 USDC)
        blob.extend_from_slice(&U256::from(100_000_000u64).to_be_bytes::<32>());
        // shareReceiver
        let recv: Address = address!("00000000000000000000000000000000000000cd");
        let mut w = [0u8; 32];
        w[12..].copy_from_slice(recv.as_slice());
        blob.extend_from_slice(&w);

        let decoded =
            RobotMoneyGateway::agentsCall::abi_decode_returns(&blob, true).expect("decode");
        assert!(decoded.active);
        assert_eq!(decoded.validUntil, v);
        assert_eq!(decoded.maxPerPayment, U256::from(1_000_000u64));
        assert_eq!(decoded.maxPerWindow, U256::from(100_000_000u64));
        assert_eq!(decoded.shareReceiver, recv);
    }

    /// The ERC-20 read-only views we need for preflight: `allowance` and
    /// `balanceOf` selectors must match the canonical ones.
    #[test]
    fn erc20_view_selectors_match() {
        assert_eq!(
            &MockUsdc::allowanceCall::SELECTOR,
            &keccak256(b"allowance(address,address)")[..4]
        );
        assert_eq!(
            &MockUsdc::balanceOfCall::SELECTOR,
            &keccak256(b"balanceOf(address)")[..4]
        );
    }
}
