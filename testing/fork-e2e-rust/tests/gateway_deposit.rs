//! Canonical: docs/architecture.md section 5.2 (Agent Permissions Gateway), issue 1889.
//!
//! Fork e2e scenarios for the gateway's one agent action, `depositTo` into a vault the owner
//! selected in the policy's `allowedDestinations`. They replace the retired agent-withdrawal
//! scenarios (the gateway has no withdrawal path).
//!
//! - `agent_deposit_into_selected_vault`: two vaults are selected, the agent deposits into the
//!   second one, and the shares land with the owner (the share receiver).
//! - `agent_deposit_unselected_vault_refused`: a vault outside the policy list reverts and no USDC
//!   or shares move.
//! - `agent_deposit_window_cap`: a deposit that fills the per-window cap succeeds and the next one
//!   in the same window reverts.
//! - `agent_cannot_redirect_shares`: the agent never receives shares, they go to the share receiver.
//!
//! Each test boots its own anvil fork backend (per ADR section 3.5).

use std::path::PathBuf;

use alloy_primitives::{Address, Bytes, U256};
use alloy_sol_types::sol;
use rmpc_fork_e2e::registration::register_agent;
use rmpc_fork_e2e::{skip_if_no_fork, ForkFixture};
use serde_json::Value;

// ── Workspace root helper ────────────────────────────────────────────────────

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // testing/fork-e2e-rust -> testing -> repo root
    p.pop();
    p.pop();
    p
}

// ── Foundry artifact loader ──────────────────────────────────────────────────

fn load_initcode(sol_file: &str, contract_name: &str) -> Bytes {
    let artifact_path = workspace_root()
        .join("out")
        .join(sol_file)
        .join(format!("{contract_name}.json"));
    let raw = std::fs::read_to_string(&artifact_path).unwrap_or_else(|e| {
        panic!(
            "Cannot read Foundry artefact at {}; run `forge build` first: {e}",
            artifact_path.display()
        )
    });
    let json: Value = serde_json::from_str(&raw).expect("artefact is valid JSON");
    let hex_with_prefix = json
        .get("bytecode")
        .and_then(|v| v.get("object"))
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("{contract_name}.json missing bytecode.object"));
    let hex = hex_with_prefix.trim_start_matches("0x");
    Bytes::from(
        hex::decode(hex)
            .unwrap_or_else(|e| panic!("{contract_name} bytecode is not valid hex: {e}")),
    )
}

fn encode_address_arg(addr: Address) -> [u8; 32] {
    let mut arg = [0u8; 32];
    arg[12..].copy_from_slice(addr.as_slice());
    arg
}

// ── ABI bindings ─────────────────────────────────────────────────────────────

sol! {
    #[allow(missing_docs)]
    interface IUSDC {
        function approve(address spender, uint256 amount) external returns (bool);
        function balanceOf(address account) external view returns (uint256);
    }

    #[allow(missing_docs)]
    interface IMockVault {
        function balanceOf(address account) external view returns (uint256);
    }

    #[allow(missing_docs)]
    interface IGateway {
        struct AgentPolicy {
            bool active;
            uint64 validUntil;
            uint256 maxPerPayment;
            uint256 maxPerWindow;
            address shareReceiver;
            address[] allowedDestinations;
            address assetRecipient;
            uint256 maxWithdrawPerPayment;
            uint256 maxWithdrawPerWindow;
            address[] allowedSourceVaults;
        }

        function revealAuthorization(address agent, bytes32 salt, AgentPolicy calldata p) external;
        function depositTo(
            bytes32 orderId,
            uint256 amount,
            uint64 deadline,
            bytes32 idempotencyKey,
            address destination,
            uint256[] calldata minSharesPerLeg
        ) external returns (bytes32 paymentId);
    }
}

// ── Contract deployment helpers ──────────────────────────────────────────────

/// Deploy `MockVault` with `asset_` = USDC address.
fn deploy_mock_vault(deployer: &rmpc_fork_e2e::Account<'_>, usdc: Address) -> Address {
    let mut code = load_initcode("MockVault.sol", "MockVault").to_vec();
    code.extend_from_slice(&encode_address_arg(usdc));
    deployer
        .deploy(Bytes::from(code), 2_000_000)
        .expect("deploy MockVault")
}

/// Deploy `RobotMoneyGateway`. It pins no vault and no router: `initialize(usdc, admin, pauser,
/// timelock, mode)`, where the harness appends the timelock and the mode.
fn deploy_gateway(
    deployer: &rmpc_fork_e2e::Account<'_>,
    usdc: Address,
    admin: Address,
    pauser: Address,
) -> Address {
    let mut args = [0u8; 96];
    args[12..32].copy_from_slice(usdc.as_slice());
    args[44..64].copy_from_slice(admin.as_slice());
    args[76..96].copy_from_slice(pauser.as_slice());
    rmpc_fork_e2e::governed::deploy_governed(
        deployer,
        "RobotMoneyGateway.sol",
        "RobotMoneyGateway",
        &args,
        8_000_000,
    )
    .expect("deploy RobotMoneyGateway")
}

fn approve_usdc(
    account: &rmpc_fork_e2e::Account<'_>,
    usdc: Address,
    spender: Address,
    amount: U256,
) {
    account
        .send(
            usdc,
            &IUSDC::approveCall { spender, amount },
            U256::ZERO,
            100_000,
        )
        .expect("USDC.approve");
}

fn usdc_balance_of(caller: &rmpc_fork_e2e::Account<'_>, usdc: Address, addr: Address) -> U256 {
    balance_of_with_retry("USDC.balanceOf", || {
        caller.call(usdc, &IUSDC::balanceOfCall { account: addr })
    })
}

fn vault_balance_of(caller: &rmpc_fork_e2e::Account<'_>, vault: Address, addr: Address) -> U256 {
    balance_of_with_retry("vault.balanceOf", || {
        caller.call(vault, &IMockVault::balanceOfCall { account: addr })
    })
}

/// Read a balance after a receipt, tolerating a brief post-receipt visibility window. A short
/// response is not a zero balance: retry it, then fail loudly.
fn balance_of_with_retry<F>(method: &str, mut call: F) -> U256
where
    F: FnMut() -> Result<alloy_primitives::Bytes, rmpc_fork_e2e::HarnessError>,
{
    let mut last_error = String::new();
    for attempt in 0..5u32 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        match call() {
            Err(error) => {
                last_error = format!("{method} attempt {attempt}: {error}");
                eprintln!("[{method}] {last_error}");
            }
            Ok(raw) if raw.len() >= 32 => return U256::from_be_slice(&raw[..32]),
            Ok(raw) => {
                last_error = format!(
                    "{method} attempt {attempt}: returned {} bytes, expected at least 32",
                    raw.len()
                );
                eprintln!("[{method}] {last_error}");
            }
        }
    }

    panic!("{method} unreadable after 5 attempts: {last_error}");
}

#[test]
#[should_panic(expected = "unreadable after 5 attempts")]
fn short_balance_of_response_is_not_coerced_to_zero() {
    balance_of_with_retry("vault.balanceOf", || Ok(Bytes::new()));
}

/// A deposit-only policy: the share receiver is the owner and the retired members are zero.
fn deposit_policy(
    valid_until: u64,
    cap: U256,
    receiver: Address,
    destinations: Vec<Address>,
) -> IGateway::AgentPolicy {
    IGateway::AgentPolicy {
        active: true,
        validUntil: valid_until,
        maxPerPayment: cap,
        maxPerWindow: cap,
        shareReceiver: receiver,
        allowedDestinations: destinations,
        assetRecipient: Address::ZERO,
        maxWithdrawPerPayment: U256::ZERO,
        maxWithdrawPerWindow: U256::ZERO,
        allowedSourceVaults: vec![],
    }
}

fn deposit_to(
    agent: &rmpc_fork_e2e::Account<'_>,
    gateway: Address,
    destination: Address,
    amount: U256,
    deadline: u64,
    tag: u8,
) -> Result<rmpc_fork_e2e::Receipt, rmpc_fork_e2e::HarnessError> {
    agent.send(
        gateway,
        &IGateway::depositToCall {
            orderId: alloy_primitives::B256::from([tag; 32]),
            amount,
            deadline,
            idempotencyKey: alloy_primitives::B256::from([tag.wrapping_add(100); 32]),
            destination,
            minSharesPerLeg: vec![],
        },
        U256::ZERO,
        3_000_000,
    )
}

// ── Scenarios ────────────────────────────────────────────────────────────────

#[test]
fn agent_deposit_into_selected_vault() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let amount = U256::from(100_000_000u64);

    let owner = fx
        .ephemeral(one_eth * U256::from(3u64), U256::ZERO)
        .expect("fund owner");
    let pauser = fx.ephemeral(one_eth, U256::ZERO).expect("fund pauser");
    let agent = fx
        .ephemeral(one_eth * U256::from(2u64), amount)
        .expect("fund agent");

    let vault_a = deploy_mock_vault(&owner, usdc);
    let vault_b = deploy_mock_vault(&owner, usdc);
    let gateway = deploy_gateway(&owner, usdc, owner.address, pauser.address);

    let now_secs: u64 = fx.chain_now().expect("read chain time");
    let policy = deposit_policy(
        now_secs + 3600,
        amount,
        owner.address,
        vec![vault_a, vault_b],
    );
    register_agent(&fx, gateway, &owner, &agent, |salt| {
        IGateway::revealAuthorizationCall {
            agent: agent.address,
            salt,
            p: policy.clone(),
        }
    });

    approve_usdc(&agent, usdc, gateway, amount);
    let receipt = deposit_to(&agent, gateway, vault_b, amount, now_secs + 300, 1)
        .expect("depositTo into the selected vault B");
    assert_eq!(receipt.status, 1, "depositTo must succeed");

    assert_eq!(
        vault_balance_of(&owner, vault_b, owner.address),
        amount,
        "owner holds the B shares"
    );
    assert_eq!(
        vault_balance_of(&owner, vault_a, owner.address),
        U256::ZERO,
        "vault A is untouched"
    );
    assert_eq!(
        usdc_balance_of(&owner, usdc, vault_b),
        amount,
        "vault B holds the USDC"
    );
    eprintln!("[agent_deposit_into_selected_vault] passed");
}

#[test]
fn agent_deposit_unselected_vault_refused() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let amount = U256::from(100_000_000u64);

    let owner = fx
        .ephemeral(one_eth * U256::from(3u64), U256::ZERO)
        .expect("fund owner");
    let pauser = fx.ephemeral(one_eth, U256::ZERO).expect("fund pauser");
    let agent = fx
        .ephemeral(one_eth * U256::from(2u64), amount)
        .expect("fund agent");

    let selected = deploy_mock_vault(&owner, usdc);
    let unselected = deploy_mock_vault(&owner, usdc);
    let gateway = deploy_gateway(&owner, usdc, owner.address, pauser.address);

    let now_secs: u64 = fx.chain_now().expect("read chain time");
    let policy = deposit_policy(now_secs + 3600, amount, owner.address, vec![selected]);
    register_agent(&fx, gateway, &owner, &agent, |salt| {
        IGateway::revealAuthorizationCall {
            agent: agent.address,
            salt,
            p: policy.clone(),
        }
    });

    approve_usdc(&agent, usdc, gateway, amount);
    let agent_usdc_before = usdc_balance_of(&agent, usdc, agent.address);
    let result = deposit_to(&agent, gateway, unselected, amount, now_secs + 300, 2);
    match result {
        Err(rmpc_fork_e2e::HarnessError::Reverted(_)) => {}
        other => panic!("expected Reverted (InvalidDestination), got {other:?}"),
    }
    assert_eq!(
        usdc_balance_of(&agent, usdc, agent.address),
        agent_usdc_before,
        "agent USDC must not move"
    );
    assert_eq!(
        usdc_balance_of(&agent, usdc, unselected),
        U256::ZERO,
        "the unselected vault must stay empty"
    );
    assert_eq!(
        vault_balance_of(&agent, unselected, owner.address),
        U256::ZERO,
        "no shares may be minted"
    );
    eprintln!("[agent_deposit_unselected_vault_refused] passed");
}

#[test]
fn agent_deposit_window_cap() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let cap = U256::from(100_000_000u64);

    let owner = fx
        .ephemeral(one_eth * U256::from(3u64), U256::ZERO)
        .expect("fund owner");
    let pauser = fx.ephemeral(one_eth, U256::ZERO).expect("fund pauser");
    let agent = fx
        .ephemeral(one_eth * U256::from(2u64), cap * U256::from(2u64))
        .expect("fund agent");

    let vault = deploy_mock_vault(&owner, usdc);
    let gateway = deploy_gateway(&owner, usdc, owner.address, pauser.address);

    let now_secs: u64 = fx.chain_now().expect("read chain time");
    let policy = deposit_policy(now_secs + 3600, cap, owner.address, vec![vault]);
    register_agent(&fx, gateway, &owner, &agent, |salt| {
        IGateway::revealAuthorizationCall {
            agent: agent.address,
            salt,
            p: policy.clone(),
        }
    });

    approve_usdc(&agent, usdc, gateway, cap * U256::from(2u64));
    let first = deposit_to(&agent, gateway, vault, cap, now_secs + 300, 3).expect("first deposit");
    assert_eq!(
        first.status, 1,
        "the deposit that fills the window cap must succeed"
    );

    let second = deposit_to(&agent, gateway, vault, U256::from(1u64), now_secs + 300, 4);
    match second {
        Err(rmpc_fork_e2e::HarnessError::Reverted(_)) => {}
        other => panic!("expected Reverted (WindowCapExceeded), got {other:?}"),
    }
    assert_eq!(
        vault_balance_of(&owner, vault, owner.address),
        cap,
        "only the first deposit minted shares"
    );
    eprintln!("[agent_deposit_window_cap] passed");
}

#[test]
fn agent_cannot_redirect_shares() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let amount = U256::from(50_000_000u64);

    let owner = fx
        .ephemeral(one_eth * U256::from(3u64), U256::ZERO)
        .expect("fund owner");
    let pauser = fx.ephemeral(one_eth, U256::ZERO).expect("fund pauser");
    let agent = fx
        .ephemeral(one_eth * U256::from(2u64), amount)
        .expect("fund agent");

    let vault = deploy_mock_vault(&owner, usdc);
    let gateway = deploy_gateway(&owner, usdc, owner.address, pauser.address);

    let now_secs: u64 = fx.chain_now().expect("read chain time");
    let policy = deposit_policy(now_secs + 3600, amount, owner.address, vec![vault]);
    register_agent(&fx, gateway, &owner, &agent, |salt| {
        IGateway::revealAuthorizationCall {
            agent: agent.address,
            salt,
            p: policy.clone(),
        }
    });

    approve_usdc(&agent, usdc, gateway, amount);
    let receipt = deposit_to(&agent, gateway, vault, amount, now_secs + 300, 5).expect("deposit");
    assert_eq!(receipt.status, 1, "deposit must succeed");
    // depositTo takes no receiver argument: shares can only go to the policy's share receiver.
    assert_eq!(
        vault_balance_of(&agent, vault, agent.address),
        U256::ZERO,
        "the agent must hold no shares"
    );
    assert_eq!(
        vault_balance_of(&agent, vault, owner.address),
        amount,
        "the owner holds the shares"
    );
    eprintln!("[agent_cannot_redirect_shares] passed");
}
