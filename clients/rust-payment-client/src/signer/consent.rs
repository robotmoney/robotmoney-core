//! Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway (agent consent)
//! Implements: issue #1791 — the agent's EIP-712 consent to a depositor binding
//!
//! The typed data an agent key signs so a depositor can bind it.
//!
//! A caller without `ADMIN_ROLE` binds an agent other than itself only with
//! the agent's EIP-712 `AgentConsent` signature, passed as the fourth
//! argument of `RobotMoneyGateway.revealAuthorization`
//! (`_requireAgentConsent`, `contracts/gateway/RobotMoneyGateway.sol`). This
//! module rebuilds the gateway's digest byte for byte:
//!
//! ```text
//! domain = EIP712Domain(name "RobotMoneyGateway", version "1",
//!                       chainId, verifyingContract = gateway)
//! struct = AgentConsent(address agent, address owner,
//!                       address shareReceiver, uint256 nonce)
//! digest = keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct)
//! ```
//!
//! `owner` is the depositor that will reveal (`msg.sender` of the reveal) and
//! `nonce` is `agentConsentNonce(agent)` at signing time; each successful
//! reveal advances it, so one signature authorizes once. The signature layout
//! the gateway reads is `r ‖ s ‖ v` (65 bytes, `v` in {27, 28}, low `s`).
//!
//! The signer trait takes this struct, never a raw digest, so the agent key
//! still exposes no generic signing oracle (see [`super::AgentSigner`]).

#![allow(deprecated)]

use alloy_primitives::{keccak256, Address, Signature as AlloySignature, B256, U256};

/// The EIP-712 type string. Its hash is the gateway's
/// `AGENT_CONSENT_TYPEHASH`.
pub const AGENT_CONSENT_TYPE: &str =
    "AgentConsent(address agent,address owner,address shareReceiver,uint256 nonce)";

/// The EIP-712 domain type the gateway hashes.
const EIP712_DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/// The gateway's EIP-712 domain name.
pub const DOMAIN_NAME: &str = "RobotMoneyGateway";

/// The gateway's EIP-712 domain version.
pub const DOMAIN_VERSION: &str = "1";

/// One consent: everything the digest binds except the agent, which is the
/// signer's own address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentConsent {
    /// The depositor that will call `revealAuthorization` and own the binding.
    pub owner: Address,
    /// The share receiver of the policy that depositor will reveal. A caller
    /// without `ADMIN_ROLE` must name itself, so this equals `owner` on every
    /// reveal the gateway accepts.
    pub share_receiver: Address,
    /// `agentConsentNonce(agent)` on the gateway at signing time.
    pub nonce: U256,
    /// The chain the gateway lives on (the domain's `chainId`).
    pub chain_id: u64,
    /// The gateway address (the domain's `verifyingContract`).
    pub gateway: Address,
}

impl AgentConsent {
    /// `keccak256(abi.encode(DOMAIN_TYPEHASH, name, version, chainId, gateway))`.
    pub fn domain_separator(&self) -> B256 {
        let mut buf = Vec::with_capacity(5 * 32);
        buf.extend_from_slice(keccak256(EIP712_DOMAIN_TYPE.as_bytes()).as_slice());
        buf.extend_from_slice(keccak256(DOMAIN_NAME.as_bytes()).as_slice());
        buf.extend_from_slice(keccak256(DOMAIN_VERSION.as_bytes()).as_slice());
        buf.extend_from_slice(&U256::from(self.chain_id).to_be_bytes::<32>());
        buf.extend_from_slice(self.gateway.into_word().as_slice());
        keccak256(buf)
    }

    /// `keccak256(abi.encode(AGENT_CONSENT_TYPEHASH, agent, owner, shareReceiver, nonce))`.
    pub fn struct_hash(&self, agent: Address) -> B256 {
        let mut buf = Vec::with_capacity(5 * 32);
        buf.extend_from_slice(keccak256(AGENT_CONSENT_TYPE.as_bytes()).as_slice());
        buf.extend_from_slice(agent.into_word().as_slice());
        buf.extend_from_slice(self.owner.into_word().as_slice());
        buf.extend_from_slice(self.share_receiver.into_word().as_slice());
        buf.extend_from_slice(&self.nonce.to_be_bytes::<32>());
        keccak256(buf)
    }

    /// The digest `agent` signs: `keccak256(0x1901 ‖ domainSeparator ‖ structHash)`.
    pub fn digest(&self, agent: Address) -> B256 {
        let mut buf = Vec::with_capacity(2 + 64);
        buf.extend_from_slice(&[0x19, 0x01]);
        buf.extend_from_slice(self.domain_separator().as_slice());
        buf.extend_from_slice(self.struct_hash(agent).as_slice());
        keccak256(buf)
    }
}

/// The 65-byte `r ‖ s ‖ v` layout `_requireAgentConsent` reads, with `v` as
/// 27 or 28 (what `ecrecover` takes).
pub fn encode_rsv(sig: &AlloySignature) -> [u8; 65] {
    let mut out = [0u8; 65];
    out[..32].copy_from_slice(&sig.r().to_be_bytes::<32>());
    out[32..64].copy_from_slice(&sig.s().to_be_bytes::<32>());
    out[64] = 27 + u8::from(sig.v().y_parity());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, b256, hex};
    use alloy_sol_types::{eip712_domain, sol, SolStruct};

    sol! {
        struct AgentConsentTyped {
            address agent;
            address owner;
            address shareReceiver;
            uint256 nonce;
        }
    }

    /// Anvil account #1, the agent of the golden vector.
    pub(crate) const GOLDEN_AGENT: Address = address!("70997970C51812dc3A010C7d01b50e0d17dc79C8");

    /// The golden consent: anvil #2 reveals for anvil #1 on chain 8453 at
    /// gateway 0x…0b00, at nonce 3.
    pub(crate) fn golden() -> AgentConsent {
        AgentConsent {
            owner: address!("3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
            share_receiver: address!("3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
            nonce: U256::from(3u64),
            chain_id: 8453,
            gateway: address!("0000000000000000000000000000000000000b00"),
        }
    }

    /// Computed with `cast keccak`/`cast abi-encode` step by step and
    /// confirmed by `cast wallet sign --data` (EIP-712 typed data) producing
    /// the same signature as signing this digest raw. The dapp's
    /// `agentConsent.test.ts` pins the same vector through viem.
    pub(crate) const GOLDEN_DIGEST: B256 =
        b256!("3ac1860ad8706f9a902e92d0657147f83d27f3a7c64bd38132d667196db1cdbf");

    /// The type hash is the gateway's `AGENT_CONSENT_TYPEHASH`.
    #[test]
    fn type_hash_matches_gateway_constant() {
        assert_eq!(
            keccak256(AGENT_CONSENT_TYPE.as_bytes()),
            b256!("40acaac9d2c4fc03092a72bcf893dc85aaed8a0c370d54cc7c6e60e6f209f062"),
        );
    }

    #[test]
    fn digest_matches_golden_vector() {
        assert_eq!(golden().digest(GOLDEN_AGENT), GOLDEN_DIGEST);
    }

    /// A second, independent EIP-712 implementation (alloy's `SolStruct`)
    /// agrees with the hand-rolled one for the golden fields and for a
    /// different chain, gateway and nonce.
    #[test]
    fn digest_matches_alloy_eip712() {
        for consent in [
            golden(),
            AgentConsent {
                chain_id: 31337,
                gateway: address!("c3e53F4d16Ae77Db1c982e75a937B9f60FE63690"),
                nonce: U256::ZERO,
                ..golden()
            },
        ] {
            let domain = eip712_domain! {
                name: DOMAIN_NAME,
                version: DOMAIN_VERSION,
                chain_id: consent.chain_id,
                verifying_contract: consent.gateway,
            };
            let typed = AgentConsentTyped {
                agent: GOLDEN_AGENT,
                owner: consent.owner,
                shareReceiver: consent.share_receiver,
                nonce: consent.nonce,
            };
            assert_eq!(
                typed.eip712_signing_hash(&domain),
                consent.digest(GOLDEN_AGENT)
            );
        }
    }

    /// Every bound field moves the digest: a consent for one owner, share
    /// receiver, nonce, chain or gateway never verifies for another.
    #[test]
    fn every_bound_field_changes_the_digest() {
        let base = golden().digest(GOLDEN_AGENT);
        let other = address!("00000000000000000000000000000000000000aa");
        for changed in [
            AgentConsent {
                owner: other,
                ..golden()
            },
            AgentConsent {
                share_receiver: other,
                ..golden()
            },
            AgentConsent {
                nonce: U256::from(4u64),
                ..golden()
            },
            AgentConsent {
                chain_id: 84532,
                ..golden()
            },
            AgentConsent {
                gateway: other,
                ..golden()
            },
        ] {
            assert_ne!(changed.digest(GOLDEN_AGENT), base, "{changed:?}");
        }
        assert_ne!(golden().digest(other), base, "the agent is bound too");
    }

    #[test]
    fn encode_rsv_uses_27_28() {
        let word = U256::from_be_slice(&[0x11; 32]);
        let sig = AlloySignature::new(word, word, alloy_primitives::Parity::Parity(true));
        let rsv = encode_rsv(&sig);
        assert_eq!(rsv[64], 28);
        assert_eq!(hex::encode(&rsv[..64]), "11".repeat(64));
    }
}
