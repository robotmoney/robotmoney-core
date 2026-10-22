//! Owner-consented agent registration for the fork tests (issue 1890).
//!
//! The gateway has no `authorizeAgent`. An agent is registered by `commitAuthorization` then
//! `revealAuthorization`; an agent other than the owner commits its consent first
//! (`keccak256(abi.encode(owner, keccak256(revealCalldata)))`), then the owner commits, one block
//! passes, and the owner reveals. Canonical: docs/architecture.md section 5.2, invariant ACL-9.

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::{sol, SolCall, SolValue};

use crate::{Account, ForkFixture};

sol! {
    /// The one gateway call the helper encodes itself.
    #[allow(missing_docs)]
    interface IRegistration {
        function commitAuthorization(bytes32 commitHash) external;
    }
}

/// Register `agent` with `owner` as the owner and share receiver. `reveal` builds the
/// `revealAuthorization(agent, salt, policy)` call for the salt the helper picked. The policy's
/// `shareReceiver` must be `owner.address`.
pub fn register_agent<R: SolCall>(
    fx: &ForkFixture,
    gateway: Address,
    owner: &Account<'_>,
    agent: &Account<'_>,
    reveal: impl Fn(B256) -> R,
) {
    let salt = keccak256(agent.address.as_slice());
    let call = reveal(salt);
    if agent.address != owner.address {
        let consent = keccak256((owner.address, keccak256(call.abi_encode())).abi_encode());
        agent
            .send(
                gateway,
                &IRegistration::commitAuthorizationCall {
                    commitHash: consent,
                },
                U256::ZERO,
                200_000,
            )
            .expect("agent consent commit");
    }
    let hash = keccak256((agent.address, owner.address, salt).abi_encode());
    owner
        .send(
            gateway,
            &IRegistration::commitAuthorizationCall { commitHash: hash },
            U256::ZERO,
            200_000,
        )
        .expect("owner commit");
    // The reveal must land in a later block than the commit.
    fx.rpc().evm_increase_time(1).expect("mine a block");
    owner
        .send(gateway, &call, U256::ZERO, 500_000)
        .expect("revealAuthorization");
}
