//! Canonical: docs/implementation-plan.md — "Router-weight governance" phase
//! Implements: issue #309
//!
//! Fork e2e scenarios for the RouterGovernance → PortfolioRouter weight
//! execution path. Each scenario deploys a fresh RouterGovernance +
//! PortfolioRouter + VaultRegistry + MockVault stack on an anvil-fork
//! backend, drives the full propose → vote → execute round-trip (or the
//! relevant failure branch), and asserts on on-chain state.
//!
//! Covered scenarios:
//!
//! - `governance_propose_vote_execute` — happy path: propose a new weight
//!   vector, cast votes past quorum, advance time past the voting deadline
//!   and execution delay, call `execute()`, assert `WeightsApplied` event
//!   emitted and `router.getWeights()` returns the new weights.
//!
//! - `governance_quorum_not_reached` — proposal expires without enough
//!   votes; after the voting deadline `router.getWeights()` is unchanged.
//!
//! - `governance_execute_before_delay_reverts` — quorum is reached but
//!   `execute()` is called before the execution delay elapses; the call
//!   reverts.
//!
//! All scenarios use `evm_snapshot` / `evm_revert` for isolation. Each
//! test boots its own anvil fork backend (per ADR §3.5).

use std::path::PathBuf;

use alloy_primitives::{keccak256, Address, Bytes, U256};
use alloy_sol_types::{sol, SolCall};
use rmpc_fork_e2e::{skip_if_no_fork, ForkFixture};
use serde_json::Value as JsonValue;

// ── Workspace root helper ────────────────────────────────────────────────────

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // testing/fork-e2e-rust → testing → repo root
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
    let json: JsonValue = serde_json::from_str(&raw).expect("artefact is valid JSON");
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
    /// VaultRegistry interface.
    #[allow(missing_docs)]
    interface IVaultRegistry {
        enum VaultStatus { Active, Paused, Retired }

        struct VaultMetadata {
            string name;
            address asset;
            uint256 registeredAt;
        }

        function registerVault(address vault, VaultMetadata calldata metadata) external;
        function setRouterEligible(address vault, bool eligible) external;
        function isRouterEligible(address vault) external view returns (bool);
        function listVaults() external view returns (address[] memory);
    }

    /// PortfolioRouter interface — governance subset.
    #[allow(missing_docs)]
    interface IPortfolioRouter {
        function setWeights(address[] calldata vaults, uint256[] calldata bps) external;
        function getWeights() external view returns (address[] memory vaults, uint256[] memory bps);
        function ADMIN_ROLE() external view returns (bytes32);
        function grantRole(bytes32 role, address account) external;
    }

    /// RouterGovernance interface.
    #[allow(missing_docs)]
    interface IRouterGovernance {
        function propose(address[] calldata vaults, uint256[] calldata bps) external returns (uint256 proposalId);
        function vote(uint256 proposalId) external;
        function execute(uint256 proposalId) external;
        function setVotingPower(address voter, uint256 power) external;
        function setQuorumThreshold(uint256 threshold) external;
        function currentProposalId() external view returns (uint256);
        function votingPower(address voter) external view returns (uint256);
        function cadenceParams() external view returns (uint64 votingPeriod, uint64 executionDelay, uint256 quorumThreshold, uint256 totalVotingPower);
        function currentWeights() external view returns (address[] memory vaults, uint256[] memory bps);

        // ProposalState enum: Active=0, Defeated=1, Queued=2, Executed=3
        function proposalState(uint256 proposalId) external view returns (uint8);
    }

    /// MockVault interface.
    #[allow(missing_docs)]
    interface IMockVault {
        function deposit(uint256 assets, address receiver) external returns (uint256 shares);
        function asset() external view returns (address);
    }
}

// ── Event signature helpers ───────────────────────────────────────────────────

/// `WeightsApplied(uint256,address[],uint256[])` — topic0.
fn weights_applied_topic0() -> alloy_primitives::B256 {
    keccak256(b"WeightsApplied(uint256,address[],uint256[])")
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
fn deploy_portfolio_router(
    deployer: &rmpc_fork_e2e::Account<'_>,
    usdc: Address,
    registry: Address,
    admin: Address,
) -> Address {
    let mut code = load_initcode("PortfolioRouter.sol", "PortfolioRouter").to_vec();
    let mut args = [0u8; 96];
    args[12..32].copy_from_slice(usdc.as_slice());
    args[44..64].copy_from_slice(registry.as_slice());
    args[76..96].copy_from_slice(admin.as_slice());
    code.extend_from_slice(&args);
    deployer
        .deploy(Bytes::from(code), 4_000_000)
        .expect("deploy PortfolioRouter")
}

/// Deploy `RouterGovernance`.
///
/// Constructor: `(address _router, address _admin, uint64 _votingPeriod,
///                uint64 _executionDelay, uint256 _quorumThreshold)`.
///
/// Args ABI layout: router(32) + admin(32) + votingPeriod(32) +
///                  executionDelay(32) + quorumThreshold(32) = 160 bytes.
fn deploy_router_governance(
    deployer: &rmpc_fork_e2e::Account<'_>,
    router: Address,
    admin: Address,
    voting_period_secs: u64,
    execution_delay_secs: u64,
    quorum_threshold: U256,
) -> Address {
    let mut code = load_initcode("RouterGovernance.sol", "RouterGovernance").to_vec();
    // 5 ABI-encoded 32-byte slots:
    //   [0..32]   = router   (address, left-padded in slot 0)
    //   [32..64]  = admin    (address, left-padded in slot 1)
    //   [64..96]  = votingPeriod  (uint64, right-aligned in slot 2)
    //   [96..128] = executionDelay (uint64, right-aligned in slot 3)
    //   [128..160] = quorumThreshold (uint256, slot 4)
    let mut args = [0u8; 160];
    // router address (slot 0, bytes 12..32)
    args[12..32].copy_from_slice(router.as_slice());
    // admin address (slot 1, bytes 44..64)
    args[44..64].copy_from_slice(admin.as_slice());
    // votingPeriod uint64 (slot 2, bytes 88..96 = right-aligned last 8 bytes)
    let vp_be = voting_period_secs.to_be_bytes();
    args[88..96].copy_from_slice(&vp_be);
    // executionDelay uint64 (slot 3, bytes 120..128)
    let ed_be = execution_delay_secs.to_be_bytes();
    args[120..128].copy_from_slice(&ed_be);
    // quorumThreshold uint256 (slot 4, bytes 128..160)
    let qt_bytes = quorum_threshold.to_be_bytes::<32>();
    args[128..160].copy_from_slice(&qt_bytes);
    code.extend_from_slice(&args);
    deployer
        .deploy(Bytes::from(code), 5_000_000)
        .expect("deploy RouterGovernance")
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

/// Mark `vault` router-eligible in the VaultRegistry so `setWeights` accepts
/// it. Issue #475: production-readiness is registry state — `PortfolioRouter`
/// reverts with `VaultNotRouterEligible` until the ADMIN_ROLE caller flips
/// the flag on the registry. See `docs/development/single-production-codebase.md`.
fn mark_router_eligible(admin: &rmpc_fork_e2e::Account<'_>, registry: Address, vault: Address) {
    admin
        .send(
            registry,
            &IVaultRegistry::setRouterEligibleCall {
                vault,
                eligible: true,
            },
            U256::ZERO,
            200_000,
        )
        .expect("setRouterEligible(true)");
}

/// Grant ADMIN_ROLE on the PortfolioRouter to `governance` so it can call
/// `setWeights`.
fn grant_router_admin(deployer: &rmpc_fork_e2e::Account<'_>, router: Address, governance: Address) {
    // Fetch ADMIN_ROLE selector: `ADMIN_ROLE()` → bytes32.
    let raw = deployer
        .call(router, &IPortfolioRouter::ADMIN_ROLECall {})
        .expect("ADMIN_ROLE()");
    if raw.len() < 32 {
        panic!("ADMIN_ROLE() returned fewer than 32 bytes");
    }
    let admin_role = alloy_primitives::B256::from_slice(&raw[..32]);
    deployer
        .send(
            router,
            &IPortfolioRouter::grantRoleCall {
                role: admin_role,
                account: governance,
            },
            U256::ZERO,
            200_000,
        )
        .expect("grantRole(ADMIN_ROLE, governance)");
}

/// Advance the EVM clock by `seconds` using `evm_increaseTime` + `evm_mine`.
fn advance_time(fx: &ForkFixture, seconds: u64) {
    fx.rpc()
        .evm_increase_time(seconds)
        .expect("evm_increase_time");
}

/// Read `router.getWeights()` and return (vaults, bps) — decoded from the
/// ABI return blob.
fn read_router_weights(
    caller: &rmpc_fork_e2e::Account<'_>,
    router: Address,
) -> (Vec<Address>, Vec<U256>) {
    let raw = caller
        .call(router, &IPortfolioRouter::getWeightsCall {})
        .expect("getWeights()");
    let r = IPortfolioRouter::getWeightsCall::abi_decode_returns(&raw, true)
        .expect("decode getWeights return");
    (r.vaults, r.bps)
}

/// Read `governance.proposalState(id)` and return it as a u8.
fn read_proposal_state(caller: &rmpc_fork_e2e::Account<'_>, governance: Address, id: U256) -> u8 {
    let raw = caller
        .call(
            governance,
            &IRouterGovernance::proposalStateCall { proposalId: id },
        )
        .expect("proposalState()");
    if raw.is_empty() {
        return 255; // sentinel for decode error
    }
    raw[31] // uint8 right-aligned in 32 bytes
}

// ── Scenario 1: happy path ────────────────────────────────────────────────────

/// governance_propose_vote_execute — propose a new weight vector, vote past
/// quorum, advance time past voting deadline and execution delay, execute, and
/// assert `WeightsApplied` event + router weights updated.
#[test]
fn governance_propose_vote_execute() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[governance_propose_vote_execute] {}", fx.summary_line());

    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));

    let deployer = fx
        .ephemeral(one_eth * U256::from(5u64), U256::ZERO)
        .expect("fund deployer");

    let snap = fx.rpc().evm_snapshot().expect("evm_snapshot");

    // Deploy the full governance stack.
    let registry = deploy_registry(&deployer, deployer.address);
    let vault_a = deploy_mock_vault(&deployer, usdc);
    let vault_b = deploy_mock_vault(&deployer, usdc);

    // voting_period = 3600 s (MIN_VOTING_PERIOD), execution_delay = 30 s, quorum = 1.
    let router = deploy_portfolio_router(&deployer, usdc, registry, deployer.address);
    let governance = deploy_router_governance(
        &deployer,
        router,
        deployer.address,
        3600,             // votingPeriod — MIN_VOTING_PERIOD enforced by constructor
        30,               // executionDelay
        U256::from(1u64), // quorumThreshold
    );

    eprintln!(
        "[governance_propose_vote_execute] registry={registry:#x} vault_a={vault_a:#x} vault_b={vault_b:#x} router={router:#x} governance={governance:#x}"
    );

    // Register vaults in the registry.
    register_vault(&deployer, registry, vault_a, usdc, "Vault A");
    register_vault(&deployer, registry, vault_b, usdc, "Vault B");

    // Issue #475: mark both vaults router-eligible via the single registry gate.
    mark_router_eligible(&deployer, registry, vault_a);
    mark_router_eligible(&deployer, registry, vault_b);

    // Set an initial 100% weight on vault_a (router needs weights before governance
    // can propose a change — the deployer holds ADMIN_ROLE on the router initially).
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
        .expect("setWeights initial");

    // Grant ADMIN_ROLE on the router to the governance contract so it can call
    // setWeights on execution.
    grant_router_admin(&deployer, router, governance);

    // Grant voting power to deployer.
    deployer
        .send(
            governance,
            &IRouterGovernance::setVotingPowerCall {
                voter: deployer.address,
                power: U256::from(100u64),
            },
            U256::ZERO,
            200_000,
        )
        .expect("setVotingPower");

    // Propose a new 60/40 weight split.
    let receipt = deployer
        .send(
            governance,
            &IRouterGovernance::proposeCall {
                vaults: vec![vault_a, vault_b],
                bps: vec![U256::from(6000u64), U256::from(4000u64)],
            },
            U256::ZERO,
            500_000,
        )
        .expect("propose");
    assert_eq!(receipt.status, 1, "propose must succeed");

    let proposal_id = U256::from(1u64);
    let state_after_propose = read_proposal_state(&deployer, governance, proposal_id);
    assert_eq!(
        state_after_propose, 0,
        "proposal must be Active after creation"
    );
    eprintln!("[governance_propose_vote_execute] proposal created, state=Active");

    // Cast a FOR vote from the deployer.
    let vote_receipt = deployer
        .send(
            governance,
            &IRouterGovernance::voteCall {
                proposalId: proposal_id,
            },
            U256::ZERO,
            200_000,
        )
        .expect("vote");
    assert_eq!(vote_receipt.status, 1, "vote must succeed");
    eprintln!("[governance_propose_vote_execute] vote cast");

    // Advance time past voting period (3600 s) + execution delay (30 s).
    advance_time(&fx, 3631);

    // State must now be Queued (quorum reached, delay elapsed).
    let state_after_time = read_proposal_state(&deployer, governance, proposal_id);
    // After deadline + delay: state is Queued (2) — still Queued until execute() is called.
    assert_eq!(
        state_after_time, 2,
        "proposal must be Queued after voting + delay"
    );
    eprintln!("[governance_propose_vote_execute] state=Queued, executing...");

    // Execute the proposal.
    let exec_receipt = deployer
        .send(
            governance,
            &IRouterGovernance::executeCall {
                proposalId: proposal_id,
            },
            U256::ZERO,
            500_000,
        )
        .expect("execute");
    assert_eq!(exec_receipt.status, 1, "execute must succeed");
    eprintln!(
        "[governance_propose_vote_execute] execute tx {:?} gasUsed={}",
        exec_receipt.tx_hash, exec_receipt.gas_used
    );

    // Assert WeightsApplied event is present.
    let topic0 = weights_applied_topic0();
    let weights_applied_log = exec_receipt
        .logs
        .iter()
        .find(|l| l.topics.first() == Some(&topic0) && l.address == governance);
    assert!(
        weights_applied_log.is_some(),
        "WeightsApplied event not found in receipt logs; logs={:?}",
        exec_receipt.logs
    );
    eprintln!("[governance_propose_vote_execute] WeightsApplied event confirmed");

    // Assert router weights updated to 60/40.
    let (w_vaults, w_bps) = read_router_weights(&deployer, router);
    assert_eq!(
        w_vaults.len(),
        2,
        "router must have 2 vaults after governance execution"
    );
    assert!(
        w_vaults.contains(&vault_a),
        "vault_a must be in router weights"
    );
    assert!(
        w_vaults.contains(&vault_b),
        "vault_b must be in router weights"
    );

    // Find bps for each vault.
    let idx_a = w_vaults.iter().position(|v| *v == vault_a).unwrap();
    let idx_b = w_vaults.iter().position(|v| *v == vault_b).unwrap();
    assert_eq!(
        w_bps[idx_a],
        U256::from(6000u64),
        "vault_a must have 60% weight"
    );
    assert_eq!(
        w_bps[idx_b],
        U256::from(4000u64),
        "vault_b must have 40% weight"
    );

    // Assert proposal state is now Executed (3).
    let state_after_exec = read_proposal_state(&deployer, governance, proposal_id);
    assert_eq!(state_after_exec, 3, "proposal must be Executed");
    eprintln!("[governance_propose_vote_execute] state=Executed, weights confirmed");

    fx.rpc().evm_revert(snap).expect("evm_revert");
    eprintln!("[governance_propose_vote_execute] passed");
}

// ── Scenario 2: quorum not reached ───────────────────────────────────────────

/// governance_quorum_not_reached — proposal is created with a quorum
/// threshold higher than available voting power; after the voting deadline
/// the proposal is Defeated and router weights remain unchanged.
#[test]
fn governance_quorum_not_reached() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[governance_quorum_not_reached] {}", fx.summary_line());

    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));

    let deployer = fx
        .ephemeral(one_eth * U256::from(5u64), U256::ZERO)
        .expect("fund deployer");

    let snap = fx.rpc().evm_snapshot().expect("evm_snapshot");

    let registry = deploy_registry(&deployer, deployer.address);
    let vault_a = deploy_mock_vault(&deployer, usdc);
    let vault_b = deploy_mock_vault(&deployer, usdc);

    let router = deploy_portfolio_router(&deployer, usdc, registry, deployer.address);

    // quorumThreshold = 1000, but we'll only grant 50 voting power to the
    // deployer — quorum can never be reached.
    let governance = deploy_router_governance(
        &deployer,
        router,
        deployer.address,
        3600,                // votingPeriod — MIN_VOTING_PERIOD enforced by constructor
        30,                  // executionDelay
        U256::from(1000u64), // quorumThreshold — unreachable
    );

    eprintln!(
        "[governance_quorum_not_reached] registry={registry:#x} vault_a={vault_a:#x} vault_b={vault_b:#x} router={router:#x} governance={governance:#x}"
    );

    register_vault(&deployer, registry, vault_a, usdc, "Vault A");
    register_vault(&deployer, registry, vault_b, usdc, "Vault B");

    // Issue #475: mark MockVaults router-eligible via the single registry gate.
    mark_router_eligible(&deployer, registry, vault_a);
    mark_router_eligible(&deployer, registry, vault_b);

    // Set initial weights (100% vault_a).
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
        .expect("setWeights initial");

    // Grant governance ADMIN_ROLE so execute() would work if it were called.
    grant_router_admin(&deployer, router, governance);

    // Grant only 50 voting power — below quorum of 1000.
    deployer
        .send(
            governance,
            &IRouterGovernance::setVotingPowerCall {
                voter: deployer.address,
                power: U256::from(50u64),
            },
            U256::ZERO,
            200_000,
        )
        .expect("setVotingPower");

    // Propose a 60/40 split.
    deployer
        .send(
            governance,
            &IRouterGovernance::proposeCall {
                vaults: vec![vault_a, vault_b],
                bps: vec![U256::from(6000u64), U256::from(4000u64)],
            },
            U256::ZERO,
            500_000,
        )
        .expect("propose");

    let proposal_id = U256::from(1u64);

    // Cast the only available vote (50 power — still below quorum of 1000).
    deployer
        .send(
            governance,
            &IRouterGovernance::voteCall {
                proposalId: proposal_id,
            },
            U256::ZERO,
            200_000,
        )
        .expect("vote");

    eprintln!("[governance_quorum_not_reached] vote cast (insufficient), advancing time...");

    // Advance past the voting period (3600 s).
    advance_time(&fx, 3601);

    // State must be Defeated (1).
    let state = read_proposal_state(&deployer, governance, proposal_id);
    assert_eq!(
        state, 1,
        "proposal must be Defeated when quorum not reached"
    );
    eprintln!("[governance_quorum_not_reached] state=Defeated confirmed");

    // Router weights must be unchanged (still 100% vault_a).
    let (w_vaults, w_bps) = read_router_weights(&deployer, router);
    assert_eq!(w_vaults.len(), 1, "router must still have 1 vault");
    assert_eq!(w_vaults[0], vault_a, "router vault must still be vault_a");
    assert_eq!(
        w_bps[0],
        U256::from(10_000u64),
        "router bps must still be 100%"
    );
    eprintln!("[governance_quorum_not_reached] router weights unchanged, confirmed");

    // Attempting to execute must revert with QuorumNotReached.
    let exec_result = deployer.send(
        governance,
        &IRouterGovernance::executeCall {
            proposalId: proposal_id,
        },
        U256::ZERO,
        300_000,
    );
    assert!(
        exec_result.is_err(),
        "execute on Defeated proposal must revert; got Ok"
    );
    match exec_result.unwrap_err() {
        rmpc_fork_e2e::HarnessError::Reverted(_) => {
            eprintln!("[governance_quorum_not_reached] execute() revert confirmed");
        }
        e => panic!("expected Reverted error, got: {e:?}"),
    }

    fx.rpc().evm_revert(snap).expect("evm_revert");
    eprintln!("[governance_quorum_not_reached] passed");
}

// ── Scenario 3: execute before delay reverts ──────────────────────────────────

/// governance_execute_before_delay_reverts — quorum is reached during the
/// voting period, but `execute()` is called before the execution delay
/// elapses; the call must revert.
#[test]
fn governance_execute_before_delay_reverts() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!(
        "[governance_execute_before_delay_reverts] {}",
        fx.summary_line()
    );

    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));

    let deployer = fx
        .ephemeral(one_eth * U256::from(5u64), U256::ZERO)
        .expect("fund deployer");

    let snap = fx.rpc().evm_snapshot().expect("evm_snapshot");

    let registry = deploy_registry(&deployer, deployer.address);
    let vault_a = deploy_mock_vault(&deployer, usdc);
    let vault_b = deploy_mock_vault(&deployer, usdc);

    let router = deploy_portfolio_router(&deployer, usdc, registry, deployer.address);

    // voting_period = 3600 s (MIN_VOTING_PERIOD), execution_delay = 7200 s (2 hours — large
    // enough to test that we can't skip it even after the voting period ends).
    let governance = deploy_router_governance(
        &deployer,
        router,
        deployer.address,
        3600,             // votingPeriod — MIN_VOTING_PERIOD enforced by constructor
        7200,             // executionDelay — large so we can trigger before it elapses
        U256::from(1u64), // quorumThreshold
    );

    eprintln!(
        "[governance_execute_before_delay_reverts] registry={registry:#x} vault_a={vault_a:#x} vault_b={vault_b:#x} router={router:#x} governance={governance:#x}"
    );

    register_vault(&deployer, registry, vault_a, usdc, "Vault A");
    register_vault(&deployer, registry, vault_b, usdc, "Vault B");

    // Issue #475: mark MockVaults router-eligible via the single registry gate.
    mark_router_eligible(&deployer, registry, vault_a);
    mark_router_eligible(&deployer, registry, vault_b);

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
        .expect("setWeights initial");

    grant_router_admin(&deployer, router, governance);

    deployer
        .send(
            governance,
            &IRouterGovernance::setVotingPowerCall {
                voter: deployer.address,
                power: U256::from(100u64),
            },
            U256::ZERO,
            200_000,
        )
        .expect("setVotingPower");

    deployer
        .send(
            governance,
            &IRouterGovernance::proposeCall {
                vaults: vec![vault_a, vault_b],
                bps: vec![U256::from(6000u64), U256::from(4000u64)],
            },
            U256::ZERO,
            500_000,
        )
        .expect("propose");

    let proposal_id = U256::from(1u64);

    deployer
        .send(
            governance,
            &IRouterGovernance::voteCall {
                proposalId: proposal_id,
            },
            U256::ZERO,
            200_000,
        )
        .expect("vote");

    eprintln!(
        "[governance_execute_before_delay_reverts] quorum vote cast, advancing time past voting period only..."
    );

    // Advance past voting period (3601 s) but NOT past the execution delay (7200 s).
    advance_time(&fx, 3601);

    // State must be Queued (quorum reached, voting period over, delay not elapsed).
    let state = read_proposal_state(&deployer, governance, proposal_id);
    assert_eq!(state, 2, "proposal must be Queued after voting period");
    eprintln!(
        "[governance_execute_before_delay_reverts] state=Queued, attempting early execute..."
    );

    // Attempting to execute before delay must revert.
    let exec_result = deployer.send(
        governance,
        &IRouterGovernance::executeCall {
            proposalId: proposal_id,
        },
        U256::ZERO,
        300_000,
    );
    assert!(
        exec_result.is_err(),
        "execute() before delay must revert; got Ok"
    );
    match exec_result.unwrap_err() {
        rmpc_fork_e2e::HarnessError::Reverted(_) => {
            eprintln!("[governance_execute_before_delay_reverts] revert before delay confirmed");
        }
        e => panic!("expected Reverted error, got: {e:?}"),
    }

    // Router weights must be unchanged.
    let (w_vaults, _w_bps) = read_router_weights(&deployer, router);
    assert_eq!(w_vaults.len(), 1, "router weights must be unchanged");
    assert_eq!(w_vaults[0], vault_a, "router must still point to vault_a");
    eprintln!("[governance_execute_before_delay_reverts] router weights unchanged, confirmed");

    fx.rpc().evm_revert(snap).expect("evm_revert");
    eprintln!("[governance_execute_before_delay_reverts] passed");
}
