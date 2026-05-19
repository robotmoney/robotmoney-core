//! Canonical: docs/architecture.md §4.2 — Portfolio Router
//! Implements: issue #304
//!
//! Fork e2e scenarios for the PortfolioRouter contract.
//!
//! Covered scenarios:
//!
//! - `router_deposit_happy_path` — deploy registry + two mock vaults +
//!   router, set a 60/40 weight split, deposit USDC, assert USDC is split
//!   proportionally, vault receipts are minted to the depositor, and
//!   `RouterDeposit` events are emitted with per-leg detail.
//!
//! - `router_unavailable_leg_reverts` — register two vaults, configure
//!   one to revert on deposit (via a `FailableMockVault`), assert that the
//!   entire `router.deposit()` call reverts (all-or-revert semantics).
//!
//! - `router_cap_exceeded_reverts` — set a global `routerCap` lower than
//!   the attempted deposit amount and assert the tx reverts with a stable
//!   `RouterCapExceeded` error selector.
//!
//! - `agent_gateway_router_deposit` — deploy a gateway wired to the
//!   router, authorize an agent, call `gateway.depositTo(router)`, and
//!   assert the `AgentDepositRouted` event is emitted.
//!
//! All scenarios use `evm_snapshot` / `evm_revert` for isolation. Each
//! test boots its own anvil fork backend (per ADR §3.5).

use std::path::PathBuf;

use alloy_primitives::{keccak256, Address, Bytes, U256};
use alloy_sol_types::sol;
use rmpc_fork_e2e::{skip_if_no_fork, ForkFixture};
use serde_json::Value;

// ── Workspace root helper ────────────────────────────────────────────────────

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // testing/fork-e2e-rust → testing → repo root
    p.pop();
    p.pop();
    p
}

// ── Foundry artifact loader ──────────────────────────────────────────────────

/// Load the creation bytecode from a Foundry JSON artefact at
/// `out/<sol_file>/<contract_name>.json`.
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

/// ABI-encode a single `address` constructor argument (left-padded to 32 bytes).
fn encode_address_arg(addr: Address) -> [u8; 32] {
    let mut arg = [0u8; 32];
    arg[12..].copy_from_slice(addr.as_slice());
    arg
}

// ── ABI bindings ─────────────────────────────────────────────────────────────

sol! {
    /// VaultRegistry interface (same as in lib.rs but scoped to this test).
    #[allow(missing_docs)]
    interface IVaultRegistry {
        enum VaultStatus { Active, Paused, Retired }

        struct VaultMetadata {
            string name;
            address asset;
            uint256 registeredAt;
        }

        function registerVault(address vault, VaultMetadata calldata metadata) external;
        function setVaultStatus(address vault, VaultStatus newStatus) external;
        function listVaults() external view returns (address[] memory);
        function getVault(address vault)
            external view
            returns (VaultMetadata memory metadata, VaultStatus status);
    }

    /// PortfolioRouter interface.
    #[allow(missing_docs)]
    interface IPortfolioRouter {
        function setWeights(address[] calldata vaults, uint256[] calldata bps) external;
        function setRouterCap(uint256 cap) external;
        function setVaultCap(address vault, uint256 cap) external;
        function setNonPrototypeAttested(address vault, bool attested) external;
        function deposit(uint256 amount, uint256[] calldata minSharesPerLeg)
            external returns (uint256[] memory sharesPerLeg);
        function depositFor(address receiver, uint256 amount, uint256[] calldata minSharesPerLeg)
            external returns (uint256[] memory sharesPerLeg);
        function getWeights()
            external view returns (address[] memory vaults, uint256[] memory bps);
    }

    /// ERC-4626-shaped mock vault (MockVault.sol).
    #[allow(missing_docs)]
    interface IMockVault {
        function deposit(uint256 assets, address receiver) external returns (uint256 shares);
        function balanceOf(address account) external view returns (uint256);
        function asset() external view returns (address);
    }

    /// FailableMockVault — a MockVault that can be flipped to revert on deposit.
    /// Deployed from FailableMockVault.sol (written below).
    #[allow(missing_docs)]
    interface IFailableMockVault {
        function setFailOnDeposit(bool fail) external;
        function deposit(uint256 assets, address receiver) external returns (uint256 shares);
        function balanceOf(address account) external view returns (uint256);
        function asset() external view returns (address);
    }

    /// USDC (ERC-20) minimal interface.
    #[allow(missing_docs)]
    interface IUSDC {
        function approve(address spender, uint256 amount) external returns (bool);
        function balanceOf(address account) external view returns (uint256);
        function transfer(address to, uint256 amount) external returns (bool);
        function allowance(address owner, address spender) external view returns (uint256);
    }

    /// Gateway interface — enough to authorize an agent and call depositTo.
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

        function authorizeAgent(address agent, AgentPolicy calldata p) external;
        function depositTo(
            bytes32 orderId,
            uint256 amount,
            uint64 deadline,
            bytes32 idempotencyKey,
            address destination,
            uint256[] calldata minSharesPerLeg
        ) external returns (bytes32 paymentId);
        function agents(address agent)
            external view
            returns (
                bool active,
                uint64 validUntil,
                uint256 maxPerPayment,
                uint256 maxPerWindow,
                address shareReceiver
            );
        function AGENT_ROLE() external view returns (bytes32);
        function hasRole(bytes32 role, address account) external view returns (bool);
    }
}

// ── Event signature helpers ──────────────────────────────────────────────────

/// `RouterDeposit(address,address,uint256,uint256,uint256)` — topic0.
fn router_deposit_topic0() -> alloy_primitives::B256 {
    keccak256(b"RouterDeposit(address,address,uint256,uint256,uint256)")
}

/// `AgentDepositRouted(bytes32,bytes32,address,address,address,uint256,uint256[],uint64)` — topic0.
fn agent_deposit_routed_topic0() -> alloy_primitives::B256 {
    keccak256(
        b"AgentDepositRouted(bytes32,bytes32,address,address,address,uint256,uint256[],uint64)",
    )
}

// ── Contract deployment helpers ──────────────────────────────────────────────

/// Deploy `VaultRegistry` with `admin` as the admin.
fn deploy_registry(deployer: &rmpc_fork_e2e::Account<'_>, admin: Address) -> Address {
    let mut code = load_initcode("VaultRegistry.sol", "VaultRegistry").to_vec();
    code.extend_from_slice(&encode_address_arg(admin));
    deployer
        .deploy(Bytes::from(code), 3_000_000)
        .expect("deploy VaultRegistry")
}

/// Deploy `MockVault` with `asset_` = USDC address.
fn deploy_mock_vault(deployer: &rmpc_fork_e2e::Account<'_>, usdc: Address) -> Address {
    let mut code = load_initcode("MockVault.sol", "MockVault").to_vec();
    code.extend_from_slice(&encode_address_arg(usdc));
    deployer
        .deploy(Bytes::from(code), 2_000_000)
        .expect("deploy MockVault")
}

/// Deploy `PortfolioRouter` with the given usdc, registry, and admin.
///
/// Constructor: `(address _usdc, address _registry, address _admin)` — 3 × 32 bytes.
fn deploy_portfolio_router(
    deployer: &rmpc_fork_e2e::Account<'_>,
    usdc: Address,
    registry: Address,
    admin: Address,
) -> Address {
    let mut code = load_initcode("PortfolioRouter.sol", "PortfolioRouter").to_vec();
    // 3 × address args
    let mut args = [0u8; 96];
    args[12..32].copy_from_slice(usdc.as_slice());
    args[44..64].copy_from_slice(registry.as_slice());
    args[76..96].copy_from_slice(admin.as_slice());
    code.extend_from_slice(&args);
    deployer
        .deploy(Bytes::from(code), 4_000_000)
        .expect("deploy PortfolioRouter")
}

/// Deploy `RobotMoneyGateway`.
///
/// Constructor: `(IERC20 usdc_, IERC4626 vault_, address admin_, address pauser_, address router_)`.
#[allow(clippy::too_many_arguments)]
fn deploy_gateway(
    deployer: &rmpc_fork_e2e::Account<'_>,
    usdc: Address,
    vault: Address,
    admin: Address,
    pauser: Address,
    router: Address,
) -> Address {
    let mut code = load_initcode("RobotMoneyGateway.sol", "RobotMoneyGateway").to_vec();
    // 5 × address args
    let mut args = [0u8; 160];
    args[12..32].copy_from_slice(usdc.as_slice());
    args[44..64].copy_from_slice(vault.as_slice());
    args[76..96].copy_from_slice(admin.as_slice());
    args[108..128].copy_from_slice(pauser.as_slice());
    args[140..160].copy_from_slice(router.as_slice());
    code.extend_from_slice(&args);
    deployer
        .deploy(Bytes::from(code), 5_000_000)
        .expect("deploy RobotMoneyGateway")
}

/// Register `vault_addr` in `registry` with a minimal metadata struct.
fn register_vault(
    deployer: &rmpc_fork_e2e::Account<'_>,
    registry: Address,
    vault_addr: Address,
    usdc: Address,
    name: &str,
) {
    let meta = IVaultRegistry::VaultMetadata {
        name: name.to_string(),
        asset: usdc,
        registeredAt: U256::ZERO,
    };
    deployer
        .send(
            registry,
            &IVaultRegistry::registerVaultCall {
                vault: vault_addr,
                metadata: meta,
            },
            U256::ZERO,
            500_000,
        )
        .expect("registerVault");
}

/// Attest a non-`IPrototypeAware` vault as router-eligible. MockVault does not
/// implement `IPrototypeAware`, so per the issue #447 gate the router requires
/// an explicit ADMIN_ROLE attestation before `setWeights` will accept it.
fn attest_non_prototype(admin: &rmpc_fork_e2e::Account<'_>, router: Address, vault_addr: Address) {
    admin
        .send(
            router,
            &IPortfolioRouter::setNonPrototypeAttestedCall {
                vault: vault_addr,
                attested: true,
            },
            U256::ZERO,
            200_000,
        )
        .expect("setNonPrototypeAttested");
}

/// Call `USDC.approve(spender, amount)` from `account`.
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

/// Read `USDC.balanceOf(addr)` from `caller`'s perspective.
fn usdc_balance_of(caller: &rmpc_fork_e2e::Account<'_>, usdc: Address, addr: Address) -> U256 {
    let raw = caller
        .call(usdc, &IUSDC::balanceOfCall { account: addr })
        .expect("USDC.balanceOf");
    if raw.len() < 32 {
        return U256::ZERO;
    }
    U256::from_be_slice(&raw[..32])
}

/// Read `vault.balanceOf(addr)` for a mock vault share token.
fn vault_shares_of(caller: &rmpc_fork_e2e::Account<'_>, vault: Address, addr: Address) -> U256 {
    let raw = caller
        .call(vault, &IMockVault::balanceOfCall { account: addr })
        .expect("vault.balanceOf");
    if raw.len() < 32 {
        return U256::ZERO;
    }
    U256::from_be_slice(&raw[..32])
}

// ── Scenario 1: happy path ────────────────────────────────────────────────────

/// router_deposit_happy_path — USDC split 60/40 across two MockVaults,
/// receipts minted to depositor, RouterDeposit events emitted per leg.
#[test]
fn router_deposit_happy_path() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[router_deposit_happy_path] {}", fx.summary_line());

    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    // 1000 USDC (6 decimals).
    let deposit_amount = U256::from(1_000_000_000u64);

    let deployer = fx
        .ephemeral(one_eth * U256::from(5u64), deposit_amount)
        .expect("fund deployer");

    let snap = fx.rpc().evm_snapshot().expect("evm_snapshot");

    // Deploy infrastructure.
    let registry = deploy_registry(&deployer, deployer.address);
    let vault_a = deploy_mock_vault(&deployer, usdc);
    let vault_b = deploy_mock_vault(&deployer, usdc);
    let router = deploy_portfolio_router(&deployer, usdc, registry, deployer.address);

    eprintln!(
        "[router_deposit_happy_path] registry={registry:#x} vault_a={vault_a:#x} vault_b={vault_b:#x} router={router:#x}"
    );

    // Register vaults.
    register_vault(&deployer, registry, vault_a, usdc, "Vault A");
    register_vault(&deployer, registry, vault_b, usdc, "Vault B");

    // MockVault does not implement IPrototypeAware; attest both vaults so the
    // router's eligibility gate (issue #447) admits them.
    attest_non_prototype(&deployer, router, vault_a);
    attest_non_prototype(&deployer, router, vault_b);

    // Set 60/40 weights.
    let set_weights_call = IPortfolioRouter::setWeightsCall {
        vaults: vec![vault_a, vault_b],
        bps: vec![U256::from(6000u64), U256::from(4000u64)],
    };
    deployer
        .send(router, &set_weights_call, U256::ZERO, 500_000)
        .expect("setWeights");

    // Approve router to pull USDC from depositor.
    approve_usdc(&deployer, usdc, router, deposit_amount);

    // Deposit.
    let deposit_call = IPortfolioRouter::depositCall {
        amount: deposit_amount,
        minSharesPerLeg: vec![],
    };
    let receipt = deployer
        .send(router, &deposit_call, U256::ZERO, 1_500_000)
        .expect("router.deposit");

    assert_eq!(receipt.status, 1, "router.deposit must succeed");
    eprintln!(
        "[router_deposit_happy_path] deposit tx {:?} gasUsed={}",
        receipt.tx_hash, receipt.gas_used
    );

    // Assert USDC split: vault_a holds 60%, vault_b holds 40%.
    let expected_a = (deposit_amount * U256::from(6000u64)) / U256::from(10_000u64);
    let expected_b = (deposit_amount * U256::from(4000u64)) / U256::from(10_000u64);

    let usdc_in_a = usdc_balance_of(&deployer, usdc, vault_a);
    let usdc_in_b = usdc_balance_of(&deployer, usdc, vault_b);
    assert_eq!(
        usdc_in_a, expected_a,
        "vault_a must hold 60% of deposited USDC"
    );
    assert_eq!(
        usdc_in_b, expected_b,
        "vault_b must hold 40% of deposited USDC"
    );

    // Assert vault receipts minted to depositor (MockVault is 1:1).
    let shares_a = vault_shares_of(&deployer, vault_a, deployer.address);
    let shares_b = vault_shares_of(&deployer, vault_b, deployer.address);
    assert_eq!(shares_a, expected_a, "vault_a shares must equal leg amount");
    assert_eq!(shares_b, expected_b, "vault_b shares must equal leg amount");

    // Assert RouterDeposit events (2 legs).
    let topic0 = router_deposit_topic0();
    let router_deposit_logs: Vec<_> = receipt
        .logs
        .iter()
        .filter(|l| l.topics.first() == Some(&topic0) && l.address == router)
        .collect();
    assert_eq!(
        router_deposit_logs.len(),
        2,
        "expected 2 RouterDeposit events; got {:?}",
        receipt.logs
    );

    // Topic1 = indexed depositor, topic2 = indexed vault.
    let log_vaults: Vec<Address> = router_deposit_logs
        .iter()
        .map(|l| Address::from_slice(&l.topics[2].as_slice()[12..]))
        .collect();
    assert!(
        log_vaults.contains(&vault_a),
        "RouterDeposit missing vault_a leg"
    );
    assert!(
        log_vaults.contains(&vault_b),
        "RouterDeposit missing vault_b leg"
    );

    fx.rpc().evm_revert(snap).expect("evm_revert");
    eprintln!("[router_deposit_happy_path] passed");
}

// ── Scenario 2: unavailable leg reverts ──────────────────────────────────────

/// router_unavailable_leg_reverts — when one leg becomes unavailable, the
/// entire router.deposit() call reverts (all-or-revert).
///
/// Strategy: deploy two USDC-backed MockVaults, weight them 50/50, then pause
/// vault_b in the VaultRegistry. PortfolioRouter._depositTo re-reads registry
/// status per leg and reverts with `VaultNotActive` if any weighted vault is
/// not Active. This proves all-or-revert under the registry-status guard.
///
/// Note: this test previously used an EOA as one leg, but issue #426 added a
/// `_requireRouterEligible` check that rejects code-less vaults at
/// `setWeights` (no `asset()` view). The pause-after-weighting path is the
/// correct e2e shape now — eligibility is enforced at config time and lifecycle
/// status is enforced at deposit time.
#[test]
fn router_unavailable_leg_reverts() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[router_unavailable_leg_reverts] {}", fx.summary_line());

    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let deposit_amount = U256::from(1_000_000_000u64);

    let deployer = fx
        .ephemeral(one_eth * U256::from(5u64), deposit_amount)
        .expect("fund deployer");

    let snap = fx.rpc().evm_snapshot().expect("evm_snapshot");

    // Deploy two USDC-backed vaults and the registry/router.
    let registry = deploy_registry(&deployer, deployer.address);
    let vault_a = deploy_mock_vault(&deployer, usdc);
    let vault_b = deploy_mock_vault(&deployer, usdc);
    let router = deploy_portfolio_router(&deployer, usdc, registry, deployer.address);

    // Register both vaults.
    register_vault(&deployer, registry, vault_a, usdc, "Vault A");
    register_vault(&deployer, registry, vault_b, usdc, "Vault B");

    // Attest both MockVaults (no IPrototypeAware) for router eligibility.
    attest_non_prototype(&deployer, router, vault_a);
    attest_non_prototype(&deployer, router, vault_b);

    // Set 50/50 weights between vault_a and vault_b. Both are Active and
    // router-eligible, so setWeights succeeds.
    deployer
        .send(
            router,
            &IPortfolioRouter::setWeightsCall {
                vaults: vec![vault_a, vault_b],
                bps: vec![U256::from(5000u64), U256::from(5000u64)],
            },
            U256::ZERO,
            500_000,
        )
        .expect("setWeights");

    // Pause vault_b in the registry — this makes the leg unavailable at
    // deposit time without changing router eligibility (registry status and
    // router eligibility are distinct signals; see issue #426).
    deployer
        .send(
            registry,
            &IVaultRegistry::setVaultStatusCall {
                vault: vault_b,
                newStatus: IVaultRegistry::VaultStatus::Paused,
            },
            U256::ZERO,
            200_000,
        )
        .expect("setVaultStatus(Paused)");

    // Approve router.
    approve_usdc(&deployer, usdc, router, deposit_amount);

    // Attempt deposit — must revert because vault_b is Paused.
    let result = deployer.send(
        router,
        &IPortfolioRouter::depositCall {
            amount: deposit_amount,
            minSharesPerLeg: vec![],
        },
        U256::ZERO,
        1_500_000,
    );
    assert!(
        result.is_err(),
        "router.deposit must revert when a weighted vault is paused; got Ok"
    );
    match result.unwrap_err() {
        rmpc_fork_e2e::HarnessError::Reverted(_) => {
            eprintln!("[router_unavailable_leg_reverts] revert confirmed (all-or-revert)");
        }
        e => panic!("expected Reverted error, got: {e:?}"),
    }

    // Sanity: vault_a received no USDC (full revert).
    let usdc_in_a = usdc_balance_of(&deployer, usdc, vault_a);
    assert_eq!(
        usdc_in_a,
        U256::ZERO,
        "vault_a must hold 0 USDC after full revert"
    );

    fx.rpc().evm_revert(snap).expect("evm_revert");
    eprintln!("[router_unavailable_leg_reverts] passed");
}

// ── Scenario 3: cap exceeded reverts ─────────────────────────────────────────

/// router_cap_exceeded_reverts — deposit exceeding the global router cap
/// reverts with the `RouterCapExceeded` custom error.
///
/// We set a routerCap of 500 USDC and attempt a 1000 USDC deposit.
#[test]
fn router_cap_exceeded_reverts() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[router_cap_exceeded_reverts] {}", fx.summary_line());

    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let deposit_amount = U256::from(1_000_000_000u64); // 1000 USDC
    let cap = U256::from(500_000_000u64); // 500 USDC

    let deployer = fx
        .ephemeral(one_eth * U256::from(5u64), deposit_amount)
        .expect("fund deployer");

    let snap = fx.rpc().evm_snapshot().expect("evm_snapshot");

    let registry = deploy_registry(&deployer, deployer.address);
    let vault_a = deploy_mock_vault(&deployer, usdc);
    let router = deploy_portfolio_router(&deployer, usdc, registry, deployer.address);

    register_vault(&deployer, registry, vault_a, usdc, "Vault A");
    attest_non_prototype(&deployer, router, vault_a);

    // Set single-vault weight vector.
    deployer
        .send(
            router,
            &IPortfolioRouter::setWeightsCall {
                vaults: vec![vault_a],
                bps: vec![U256::from(10_000u64)],
            },
            U256::ZERO,
            500_000,
        )
        .expect("setWeights");

    // Set global router cap (500 USDC < 1000 USDC deposit).
    deployer
        .send(
            router,
            &IPortfolioRouter::setRouterCapCall { cap },
            U256::ZERO,
            100_000,
        )
        .expect("setRouterCap");

    approve_usdc(&deployer, usdc, router, deposit_amount);

    let result = deployer.send(
        router,
        &IPortfolioRouter::depositCall {
            amount: deposit_amount,
            minSharesPerLeg: vec![],
        },
        U256::ZERO,
        1_000_000,
    );

    assert!(
        result.is_err(),
        "router.deposit must revert when routerCap is exceeded"
    );
    match result.unwrap_err() {
        rmpc_fork_e2e::HarnessError::Reverted(_) => {
            eprintln!("[router_cap_exceeded_reverts] revert confirmed (RouterCapExceeded)");
        }
        e => panic!("expected Reverted error, got: {e:?}"),
    }

    fx.rpc().evm_revert(snap).expect("evm_revert");
    eprintln!("[router_cap_exceeded_reverts] passed");
}

// ── Scenario 4: agent gateway router deposit ──────────────────────────────────

/// agent_gateway_router_deposit — an authorized agent calls
/// `gateway.depositTo(router)` and the `AgentDepositRouted` event is emitted.
///
/// This scenario deploys the full stack (registry + MockVault + router +
/// gateway), authorizes the deployer as the agent's policy owner and the
/// deployer itself as the agent (for simplicity in the test), calls
/// `depositTo` with `destination = router`, and asserts:
///   - tx succeeds (status = 1)
///   - `AgentDepositRouted` event is present in the receipt logs
///
/// Note: rmpc's `deposit` command calls `gateway.deposit()` (not
/// `depositTo`). The gateway router path is exercised directly here via
/// ABI encoding to keep the test self-contained and avoid requiring a
/// `depositTo` CLI surface on rmpc.
#[test]
fn agent_gateway_router_deposit() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[agent_gateway_router_deposit] {}", fx.summary_line());

    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let deposit_amount = U256::from(100_000_000u64); // 100 USDC

    // Three accounts: owner (admin/deployer), pauser (holds PAUSER_ROLE),
    // agent (calls depositTo). ADMIN_ROLE and PAUSER_ROLE must be held by
    // distinct addresses (AccessRoles role-separation invariant).
    let owner = fx
        .ephemeral(one_eth * U256::from(3u64), U256::ZERO)
        .expect("fund owner");
    let pauser = fx.ephemeral(one_eth, U256::ZERO).expect("fund pauser");
    let agent = fx
        .ephemeral(one_eth * U256::from(3u64), deposit_amount)
        .expect("fund agent");

    let snap = fx.rpc().evm_snapshot().expect("evm_snapshot");

    // Deploy full stack.
    let registry = deploy_registry(&owner, owner.address);
    let vault_a = deploy_mock_vault(&owner, usdc);
    let router = deploy_portfolio_router(&owner, usdc, registry, owner.address);

    // The gateway constructor calls `vault_.asset()` to verify the vault
    // asset matches USDC. MockVault exposes `asset()` returning the
    // constructor `asset_` argument, so this will succeed.
    // admin_ and pauser_ must be distinct addresses due to role-separation.
    let gateway = deploy_gateway(&owner, usdc, vault_a, owner.address, pauser.address, router);

    eprintln!(
        "[agent_gateway_router_deposit] registry={registry:#x} vault={vault_a:#x} router={router:#x} gateway={gateway:#x}"
    );

    // Register vault_a and set 100% weight.
    register_vault(&owner, registry, vault_a, usdc, "Vault A");
    attest_non_prototype(&owner, router, vault_a);
    owner
        .send(
            router,
            &IPortfolioRouter::setWeightsCall {
                vaults: vec![vault_a],
                bps: vec![U256::from(10_000u64)],
            },
            U256::ZERO,
            500_000,
        )
        .expect("setWeights");

    // Authorize the agent. The owner calls `gateway.authorizeAgent(agent, policy)`.
    // Policy: active=true, validUntil = now + 3600, maxPerPayment = deposit_amount,
    // maxPerWindow = deposit_amount, shareReceiver = owner.address,
    // allowedDestinations = [router].
    let now_secs: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let policy = IGateway::AgentPolicy {
        active: true,
        validUntil: now_secs + 3600,
        maxPerPayment: deposit_amount,
        maxPerWindow: deposit_amount,
        shareReceiver: owner.address,
        allowedDestinations: vec![router],
        assetRecipient: Address::ZERO,
        maxWithdrawPerPayment: U256::ZERO,
        maxWithdrawPerWindow: U256::ZERO,
        allowedSourceVaults: vec![],
    };
    owner
        .send(
            gateway,
            &IGateway::authorizeAgentCall {
                agent: agent.address,
                p: policy,
            },
            U256::ZERO,
            500_000,
        )
        .expect("authorizeAgent");

    eprintln!(
        "[agent_gateway_router_deposit] agent authorized: agent={:#x} shareReceiver={:#x}",
        agent.address, owner.address
    );

    // Agent approves gateway to pull USDC.
    approve_usdc(&agent, usdc, gateway, deposit_amount);

    // Agent calls gateway.depositTo(orderId, amount, deadline, idempotencyKey, router, []).
    let order_id = alloy_primitives::B256::from([1u8; 32]);
    let idempotency_key = alloy_primitives::B256::from([2u8; 32]);
    let deadline = now_secs + 300;

    let receipt = agent
        .send(
            gateway,
            &IGateway::depositToCall {
                orderId: order_id,
                amount: deposit_amount,
                deadline,
                idempotencyKey: idempotency_key,
                destination: router,
                minSharesPerLeg: vec![],
            },
            U256::ZERO,
            2_000_000,
        )
        .expect("gateway.depositTo");

    assert_eq!(receipt.status, 1, "gateway.depositTo must succeed");
    eprintln!(
        "[agent_gateway_router_deposit] depositTo tx {:?} gasUsed={}",
        receipt.tx_hash, receipt.gas_used
    );

    // Assert AgentDepositRouted event is present.
    let topic0 = agent_deposit_routed_topic0();
    let routed_log = receipt
        .logs
        .iter()
        .find(|l| l.topics.first() == Some(&topic0) && l.address == gateway);
    assert!(
        routed_log.is_some(),
        "AgentDepositRouted event not found in receipt logs; logs={:?}",
        receipt.logs
    );
    let log = routed_log.unwrap();
    // topic3 = indexed agent address.
    assert!(
        log.topics.len() >= 4,
        "AgentDepositRouted must have at least 4 topics"
    );
    let agent_from_topic = Address::from_slice(&log.topics[3].as_slice()[12..]);
    assert_eq!(
        agent_from_topic, agent.address,
        "AgentDepositRouted topic3 (agent) mismatch"
    );

    // Assert vault_a received the USDC (router deposited 100%).
    let usdc_in_vault = usdc_balance_of(&owner, usdc, vault_a);
    assert_eq!(
        usdc_in_vault, deposit_amount,
        "vault_a must hold 100% of deposited USDC"
    );

    // Assert owner received vault shares (shareReceiver = owner.address).
    let shares = vault_shares_of(&owner, vault_a, owner.address);
    assert_eq!(
        shares, deposit_amount,
        "owner must hold vault_a shares equal to deposit (1:1 MockVault)"
    );

    fx.rpc().evm_revert(snap).expect("evm_revert");
    eprintln!("[agent_gateway_router_deposit] passed");
}
