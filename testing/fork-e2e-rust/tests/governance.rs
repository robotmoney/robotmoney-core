//! Canonical: Plan tracking issue #109 — "Router-weight governance" phase
//! Canonical: docs/technical/governance-decisions.md §3.2, §3.7 — a receipt is applied, not voted on
//! Implements: issue #309; issue #1698 (QA plan v1 C1) — one `applyReceipt` call, no voting
//!
//! Fork e2e scenarios for the weight setter's receipt path: RouterGovernance releases on the
//! ConsensusRecommendationReceipt register and writes PortfolioRouter weights. Each scenario deploys a
//! fresh stack on an anvil-fork backend (a VaultRegistry, two MockVaults, a PortfolioRouter, an
//! InvestmentCommitteePolicy, a ConsensusRecommendationReceipt and a RouterGovernance), records one
//! consensus receipt, and drives `RouterGovernance.applyReceipt` (or one of its refusals), asserting
//! on-chain state.
//!
//! Issue 1698 deleted the propose -> vote -> execute path, the voter set, voting power, quorum, voting
//! period and execution delay. These scenarios replaced the three that drove that path. The Safe and the
//! timelock are not deployed here: the deployer holds RouterGovernance `ADMIN_ROLE` as the timelock does
//! after stage 11, and stands in as the register's gateway (its only permitted writer). The deploy wiring
//! itself (stage 11 points `receiptContract` at the register and grants the weight setter the register's
//! `ADMIN_ROLE`) is asserted on the real deployment by `testing/smoke-test/tests/governance.rs`.
//!
//! Covered scenarios:
//!
//! - `governance_apply_receipt_releases_and_sets_weights_in_one_call` — happy path: one `applyReceipt`
//!   releases the receipt (`ReceiptReleased` from the register) and writes its vector (`ReceiptApplied`
//!   from the weight setter) in the same transaction; `isReleased` is true and `router.getWeights()`
//!   returns the receipt's vector.
//!
//! - `governance_apply_receipt_refuses_a_digest_mismatch` — the call names a digest the register did not
//!   store; it reverts, the receipt stays unreleased and the router weights are unchanged.
//!
//! - `governance_apply_receipt_refused_vector_releases_nothing` — the router refuses the vector (a
//!   duplicate vault); the whole call reverts, so the receipt stays unreleased, and the same receipt then
//!   applies with a valid vector.
//!
//! Each test boots its own anvil fork backend (per ADR §3.5), providing
//! full state isolation without snapshot/revert coordination.

use std::path::PathBuf;

use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
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
        enum VaultStatus { Active, DepositsPaused, Retired }

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
        function WEIGHT_SETTER_ROLE() external view returns (bytes32);
        function grantRole(bytes32 role, address account) external;
    }

    /// RouterGovernance interface (issue 1698: the weight setter applies a receipt, no voting).
    #[allow(missing_docs)]
    interface IRouterGovernance {
        function setReceiptContract(address receipt) external;
        function receiptContract() external view returns (address);
        function applyReceipt(bytes32 receiptId, bytes32 payloadDigest, address[] calldata vaults, uint256[] calldata bps) external;
    }

    /// InvestmentCommitteePolicy subset: the register reads COMMITTEE_AGENT_ROLE from it.
    #[allow(missing_docs)]
    interface IInvestmentCommitteePolicy {
        function registerAgent(address agent, string calldata agentId) external;
    }

    /// ConsensusRecommendationReceipt subset.
    #[allow(missing_docs)]
    interface IConsensusRecommendationReceipt {
        function recordReceipt(address submitter, bytes32 receiptId, bytes32 payloadDigest, string calldata payloadUri) external returns (uint256 index);
        function isRecorded(bytes32 receiptId) external view returns (bool);
        function isReleased(bytes32 receiptId) external view returns (bool);
        function grantRole(bytes32 role, address account) external;
    }
}

// ── Event signature helpers ───────────────────────────────────────────────────

/// `RouterGovernance.ReceiptApplied(bytes32,bytes32,address[],uint256[])` — topic0.
fn receipt_applied_topic0() -> B256 {
    keccak256(b"ReceiptApplied(bytes32,bytes32,address[],uint256[])")
}

/// `ConsensusRecommendationReceipt.ReceiptReleased(bytes32,address,uint64)` — topic0.
fn receipt_released_topic0() -> B256 {
    keccak256(b"ReceiptReleased(bytes32,address,uint64)")
}

/// `ADMIN_ROLE` of RouterGovernance and of the receipt register: `keccak256("ADMIN_ROLE")`.
fn admin_role() -> B256 {
    keccak256(b"ADMIN_ROLE")
}

// ── Contract deployment helpers ──────────────────────────────────────────────

/// Deploy `VaultRegistry` behind its proxy (ADR-0014) with `admin` as the admin.
fn deploy_registry(deployer: &rmpc_fork_e2e::Account<'_>, admin: Address) -> Address {
    rmpc_fork_e2e::proxied::deploy_vault_registry(deployer, admin).expect("deploy VaultRegistry")
}

/// Deploy `MockVault` with `asset_` = USDC address.
fn deploy_mock_vault(deployer: &rmpc_fork_e2e::Account<'_>, usdc: Address) -> Address {
    let mut code = load_initcode("MockVault.sol", "MockVault").to_vec();
    code.extend_from_slice(&encode_address_arg(usdc));
    deployer
        .deploy(Bytes::from(code), 2_000_000)
        .expect("deploy MockVault")
}

/// Deploy `PortfolioRouter` behind its proxy (ADR-0014) with the given usdc, registry, and admin.
fn deploy_portfolio_router(
    deployer: &rmpc_fork_e2e::Account<'_>,
    usdc: Address,
    registry: Address,
    admin: Address,
) -> Address {
    rmpc_fork_e2e::proxied::deploy_portfolio_router(deployer, usdc, registry, admin)
        .expect("deploy PortfolioRouter")
}

/// Deploy `RouterGovernance`. Constructor (issue 1698): `(address _router, address _admin)`.
fn deploy_router_governance(
    deployer: &rmpc_fork_e2e::Account<'_>,
    router: Address,
    admin: Address,
) -> Address {
    let mut code = load_initcode("RouterGovernance.sol", "RouterGovernance").to_vec();
    code.extend_from_slice(&encode_address_arg(router));
    code.extend_from_slice(&encode_address_arg(admin));
    deployer
        .deploy(Bytes::from(code), 5_000_000)
        .expect("deploy RouterGovernance")
}

/// Deploy `InvestmentCommitteePolicy` behind its proxy (ADR-0014): `initialize(admin, gateway, ...)`.
fn deploy_ic_policy(
    deployer: &rmpc_fork_e2e::Account<'_>,
    admin: Address,
    gateway: Address,
) -> Address {
    rmpc_fork_e2e::proxied::deploy_investment_committee_policy(deployer, admin, gateway)
        .expect("deploy InvestmentCommitteePolicy")
}

/// Deploy `ConsensusRecommendationReceipt` behind its proxy (ADR-0014):
/// `initialize(admin, gateway, icPolicy, ...)`.
fn deploy_receipt_register(
    deployer: &rmpc_fork_e2e::Account<'_>,
    admin: Address,
    gateway: Address,
    ic_policy: Address,
) -> Address {
    rmpc_fork_e2e::proxied::deploy_consensus_recommendation_receipt(
        deployer, admin, gateway, ic_policy,
    )
    .expect("deploy ConsensusRecommendationReceipt")
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

/// Grant ADMIN_ROLE and WEIGHT_SETTER_ROLE on the PortfolioRouter to `governance`.
/// `setWeights` is gated by WEIGHT_SETTER_ROLE, the other governance calls by ADMIN_ROLE.
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

    let raw = deployer
        .call(router, &IPortfolioRouter::WEIGHT_SETTER_ROLECall {})
        .expect("WEIGHT_SETTER_ROLE()");
    if raw.len() < 32 {
        panic!("WEIGHT_SETTER_ROLE() returned fewer than 32 bytes");
    }
    let setter_role = alloy_primitives::B256::from_slice(&raw[..32]);
    deployer
        .send(
            router,
            &IPortfolioRouter::grantRoleCall {
                role: setter_role,
                account: governance,
            },
            U256::ZERO,
            200_000,
        )
        .expect("grantRole(WEIGHT_SETTER_ROLE, governance)");
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

/// One deployed receipt-path stack.
struct Stack {
    router: Address,
    governance: Address,
    register: Address,
    vault_a: Address,
    vault_b: Address,
}

/// The receipt every scenario records, and the digest the register stores for it.
fn receipt_id() -> B256 {
    keccak256(b"fork-e2e governance receipt")
}
fn payload_digest() -> B256 {
    keccak256(b"fork-e2e governance payload")
}

/// Deploy and wire the stack the way stage 11 wires it, with the deployer standing in for the timelock
/// (RouterGovernance `ADMIN_ROLE`) and for the gateway (the register's only writer). The router starts at
/// 100% vault_a; the deployer records one receipt as an allowlisted committee agent.
fn deploy_stack(tag: &str, deployer: &rmpc_fork_e2e::Account<'_>) -> Stack {
    let usdc = rmpc_fork_e2e::addresses::USDC;
    let me = deployer.address;

    let registry = deploy_registry(deployer, me);
    let vault_a = deploy_mock_vault(deployer, usdc);
    let vault_b = deploy_mock_vault(deployer, usdc);
    let router = deploy_portfolio_router(deployer, usdc, registry, me);
    let governance = deploy_router_governance(deployer, router, me);
    let ic_policy = deploy_ic_policy(deployer, me, me);
    let register = deploy_receipt_register(deployer, me, me, ic_policy);
    eprintln!(
        "[{tag}] registry={registry:#x} vault_a={vault_a:#x} vault_b={vault_b:#x} router={router:#x} \
         governance={governance:#x} ic_policy={ic_policy:#x} register={register:#x}"
    );

    register_vault(deployer, registry, vault_a, usdc, "Vault A");
    register_vault(deployer, registry, vault_b, usdc, "Vault B");
    // Issue #475: mark both vaults router-eligible via the single registry gate.
    mark_router_eligible(deployer, registry, vault_a);
    mark_router_eligible(deployer, registry, vault_b);

    // Initial 100% vault_a, written by the deployer (the router constructor grants it WEIGHT_SETTER_ROLE).
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

    // The weight setter holds ADMIN_ROLE and WEIGHT_SETTER_ROLE on the router.
    grant_router_admin(deployer, router, governance);
    // Stage 11: point the weight setter at the register and grant it the register's ADMIN_ROLE (the
    // releaseReceipt gate).
    deployer
        .send(
            governance,
            &IRouterGovernance::setReceiptContractCall { receipt: register },
            U256::ZERO,
            200_000,
        )
        .expect("setReceiptContract");
    deployer
        .send(
            register,
            &IConsensusRecommendationReceipt::grantRoleCall {
                role: admin_role(),
                account: governance,
            },
            U256::ZERO,
            200_000,
        )
        .expect("register grantRole(ADMIN_ROLE, governance)");

    // The committee records one receipt through the "gateway" (the deployer here).
    deployer
        .send(
            ic_policy,
            &IInvestmentCommitteePolicy::registerAgentCall {
                agent: me,
                agentId: "fork-e2e".to_string(),
            },
            U256::ZERO,
            300_000,
        )
        .expect("registerAgent");
    deployer
        .send(
            register,
            &IConsensusRecommendationReceipt::recordReceiptCall {
                submitter: me,
                receiptId: receipt_id(),
                payloadDigest: payload_digest(),
                payloadUri: "https://receipts.invalid/fork-e2e.json".to_string(),
            },
            U256::ZERO,
            500_000,
        )
        .expect("recordReceipt");
    assert!(
        read_bool(
            deployer,
            register,
            &IConsensusRecommendationReceipt::isRecordedCall {
                receiptId: receipt_id()
            }
        ),
        "the receipt must be recorded before any scenario applies it"
    );

    Stack {
        router,
        governance,
        register,
        vault_a,
        vault_b,
    }
}

/// eth_call a view that returns one `bool`.
fn read_bool<C: SolCall>(caller: &rmpc_fork_e2e::Account<'_>, to: Address, call: &C) -> bool {
    let raw = caller.call(to, call).expect("bool view");
    assert_eq!(raw.len(), 32, "a bool view returns one word, got {raw:?}");
    raw[31] == 1
}

fn is_released(caller: &rmpc_fork_e2e::Account<'_>, s: &Stack) -> bool {
    read_bool(
        caller,
        s.register,
        &IConsensusRecommendationReceipt::isReleasedCall {
            receiptId: receipt_id(),
        },
    )
}

/// The router still routes 100% to vault_a: nothing was applied.
fn assert_weights_unchanged(caller: &rmpc_fork_e2e::Account<'_>, s: &Stack, tag: &str) {
    let (w_vaults, w_bps) = read_router_weights(caller, s.router);
    assert_eq!(
        w_vaults,
        vec![s.vault_a],
        "[{tag}] router vaults must be unchanged"
    );
    assert_eq!(
        w_bps,
        vec![U256::from(10_000u64)],
        "[{tag}] router bps must be unchanged"
    );
}

/// The call must have reverted on chain.
fn assert_reverted(
    result: Result<rmpc_fork_e2e::Receipt, rmpc_fork_e2e::HarnessError>,
    what: &str,
) {
    match result {
        Err(rmpc_fork_e2e::HarnessError::Reverted(_)) => {}
        Ok(r) => panic!("{what} must revert; it succeeded in {:?}", r.tx_hash),
        Err(e) => panic!("{what}: expected Reverted, got {e:?}"),
    }
}

// ── Scenario 1: one call releases and applies ─────────────────────────────────

/// governance_apply_receipt_releases_and_sets_weights_in_one_call — one `applyReceipt` releases the
/// recorded receipt and writes its 60/40 vector in the same transaction.
#[test]
fn governance_apply_receipt_releases_and_sets_weights_in_one_call() {
    const TAG: &str = "governance_apply_receipt_releases_and_sets_weights_in_one_call";
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[{TAG}] {}", fx.summary_line());
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let deployer = fx
        .ephemeral(one_eth * U256::from(5u64), U256::ZERO)
        .expect("fund deployer");
    let s = deploy_stack(TAG, &deployer);
    assert!(
        !is_released(&deployer, &s),
        "a recorded receipt starts unreleased"
    );

    let receipt = deployer
        .send(
            s.governance,
            &IRouterGovernance::applyReceiptCall {
                receiptId: receipt_id(),
                payloadDigest: payload_digest(),
                vaults: vec![s.vault_a, s.vault_b],
                bps: vec![U256::from(6000u64), U256::from(4000u64)],
            },
            U256::ZERO,
            800_000,
        )
        .expect("applyReceipt");
    eprintln!(
        "[{TAG}] applyReceipt tx {:?} gasUsed={}",
        receipt.tx_hash, receipt.gas_used
    );

    // Release and weights are one transaction: both events are in this receipt.
    let released = receipt.logs.iter().any(|l| {
        l.address == s.register
            && l.topics.first() == Some(&receipt_released_topic0())
            && l.topics.get(1) == Some(&receipt_id())
    });
    assert!(
        released,
        "ReceiptReleased from the register missing; logs={:?}",
        receipt.logs
    );
    let applied = receipt.logs.iter().any(|l| {
        l.address == s.governance
            && l.topics.first() == Some(&receipt_applied_topic0())
            && l.topics.get(1) == Some(&receipt_id())
    });
    assert!(
        applied,
        "ReceiptApplied from the weight setter missing; logs={:?}",
        receipt.logs
    );
    assert!(is_released(&deployer, &s), "the receipt must be released");

    let (w_vaults, w_bps) = read_router_weights(&deployer, s.router);
    assert_eq!(w_vaults, vec![s.vault_a, s.vault_b], "router vaults");
    assert_eq!(
        w_bps,
        vec![U256::from(6000u64), U256::from(4000u64)],
        "router bps must be the receipt's vector"
    );

    // One operation per receipt: applying it again reverts and changes nothing.
    assert_reverted(
        deployer.send(
            s.governance,
            &IRouterGovernance::applyReceiptCall {
                receiptId: receipt_id(),
                payloadDigest: payload_digest(),
                vaults: vec![s.vault_a],
                bps: vec![U256::from(10_000u64)],
            },
            U256::ZERO,
            800_000,
        ),
        "a second applyReceipt of a released receipt",
    );
    let (_, w_bps) = read_router_weights(&deployer, s.router);
    assert_eq!(
        w_bps,
        vec![U256::from(6000u64), U256::from(4000u64)],
        "a refused second application changes nothing"
    );
    eprintln!("[{TAG}] passed");
}

// ── Scenario 2: digest mismatch ───────────────────────────────────────────────

/// governance_apply_receipt_refuses_a_digest_mismatch — the call names a digest the register did not
/// store; it reverts, the receipt stays unreleased and the weights are unchanged.
#[test]
fn governance_apply_receipt_refuses_a_digest_mismatch() {
    const TAG: &str = "governance_apply_receipt_refuses_a_digest_mismatch";
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[{TAG}] {}", fx.summary_line());
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let deployer = fx
        .ephemeral(one_eth * U256::from(5u64), U256::ZERO)
        .expect("fund deployer");
    let s = deploy_stack(TAG, &deployer);

    assert_reverted(
        deployer.send(
            s.governance,
            &IRouterGovernance::applyReceiptCall {
                receiptId: receipt_id(),
                payloadDigest: keccak256(b"an edited payload"),
                vaults: vec![s.vault_a, s.vault_b],
                bps: vec![U256::from(6000u64), U256::from(4000u64)],
            },
            U256::ZERO,
            800_000,
        ),
        "applyReceipt with a digest the register did not store",
    );
    assert!(
        !is_released(&deployer, &s),
        "a refused application releases nothing"
    );
    assert_weights_unchanged(&deployer, &s, TAG);
    eprintln!("[{TAG}] passed");
}

// ── Scenario 3: a refused vector releases nothing ─────────────────────────────

/// governance_apply_receipt_refused_vector_releases_nothing — the router refuses a duplicate vault, so
/// the whole call reverts: the receipt stays unreleased, and the same receipt then applies.
#[test]
fn governance_apply_receipt_refused_vector_releases_nothing() {
    const TAG: &str = "governance_apply_receipt_refused_vector_releases_nothing";
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[{TAG}] {}", fx.summary_line());
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let deployer = fx
        .ephemeral(one_eth * U256::from(5u64), U256::ZERO)
        .expect("fund deployer");
    let s = deploy_stack(TAG, &deployer);

    // A duplicate vault (PortfolioRouter DuplicateVault, QA plan v1 C1): the release inside the same
    // call must roll back with it.
    assert_reverted(
        deployer.send(
            s.governance,
            &IRouterGovernance::applyReceiptCall {
                receiptId: receipt_id(),
                payloadDigest: payload_digest(),
                vaults: vec![s.vault_a, s.vault_a],
                bps: vec![U256::from(5000u64), U256::from(5000u64)],
            },
            U256::ZERO,
            800_000,
        ),
        "applyReceipt with a duplicate vault",
    );
    assert!(
        !is_released(&deployer, &s),
        "a vector the router refuses must release nothing"
    );
    assert_weights_unchanged(&deployer, &s, TAG);

    // Nothing was consumed: the same receipt applies with a valid vector.
    deployer
        .send(
            s.governance,
            &IRouterGovernance::applyReceiptCall {
                receiptId: receipt_id(),
                payloadDigest: payload_digest(),
                vaults: vec![s.vault_b],
                bps: vec![U256::from(10_000u64)],
            },
            U256::ZERO,
            800_000,
        )
        .expect("applyReceipt with a valid vector after the refusal");
    assert!(is_released(&deployer, &s), "the receipt is released now");
    let (w_vaults, _) = read_router_weights(&deployer, s.router);
    assert_eq!(w_vaults, vec![s.vault_b], "the valid vector was applied");
    eprintln!("[{TAG}] passed");
}
