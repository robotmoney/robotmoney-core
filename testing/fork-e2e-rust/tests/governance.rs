//! Canonical: docs/technical/governance-decisions.md §3 — the Safe applies consensus receipts through the weight setter
//! Implements: issue #1698 — the weight setter applies a consensus receipt in one call; voting deleted
//!
//! Fork e2e scenarios for the RouterGovernance → PortfolioRouter weight path.
//! Each scenario deploys a fresh VaultRegistry + MockVault + PortfolioRouter +
//! InvestmentCommitteePolicy + ConsensusRecommendationReceipt + RouterGovernance
//! stack on an anvil-fork backend, records a consensus receipt, and drives
//! `RouterGovernance.applyReceipt` (or the relevant failure branch).
//!
//! The test account stands in for both the gateway (the receipt register's
//! only writer) and the timelock (the holder of RouterGovernance's
//! `WEIGHT_SETTER_ROLE`). It is also the allowlisted committee agent that
//! submits the receipt.
//!
//! Covered scenarios:
//!
//! - `governance_apply_receipt_round_trip` — happy path: `applyReceipt`
//!   releases the receipt, sets its vector on the router (`getWeights` equals
//!   the vector, `votedWeightsActive` is true) and emits `ReceiptApplied`.
//! - `governance_apply_receipt_digest_mismatch_reverts` — a call naming a
//!   digest other than the stored one reverts `PayloadDigestMismatch`.
//! - `governance_apply_receipt_already_released_reverts` — a second apply of
//!   the same receipt reverts `ReceiptAlreadyReleased`.
//! - `governance_apply_receipt_non_weight_setter_reverts` — a caller without
//!   `WEIGHT_SETTER_ROLE` reverts `AccessControlUnauthorizedAccount`.
//! - `governance_apply_receipt_duplicate_vault_reverts` — a vector naming a
//!   vault twice reverts `DuplicateVault` and leaves the receipt unreleased.
//!
//! Each failure scenario asserts the revert selector through `eth_call`, then
//! sends the transaction and asserts it reverted on chain and changed nothing.
//!
//! Each test boots its own anvil fork backend (per ADR §3.5), providing
//! full state isolation without snapshot/revert coordination.

use std::path::PathBuf;

use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::{sol, SolCall, SolError, SolEvent};
use rmpc_fork_e2e::{skip_if_no_fork, Account, ForkFixture, HarnessError};
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

/// Deploy `sol_file:contract_name` with ABI-encoded address constructor
/// arguments (each left-padded to a 32-byte slot).
fn deploy_with_address_args(
    deployer: &Account<'_>,
    sol_file: &str,
    contract_name: &str,
    args: &[Address],
    gas_limit: u64,
) -> Address {
    let mut code = load_initcode(sol_file, contract_name).to_vec();
    for addr in args {
        let mut slot = [0u8; 32];
        slot[12..].copy_from_slice(addr.as_slice());
        code.extend_from_slice(&slot);
    }
    deployer
        .deploy(Bytes::from(code), gas_limit)
        .unwrap_or_else(|e| panic!("deploy {contract_name}: {e}"))
}

// ── ABI bindings ─────────────────────────────────────────────────────────────

sol! {
    /// VaultRegistry interface.
    #[allow(missing_docs)]
    interface IVaultRegistry {
        struct VaultMetadata {
            string name;
            address asset;
            uint256 registeredAt;
        }

        function registerVault(address vault, VaultMetadata calldata metadata) external;
        function setRouterEligible(address vault, bool eligible) external;
    }

    /// PortfolioRouter interface — weight subset.
    #[allow(missing_docs)]
    interface IPortfolioRouter {
        error DuplicateVault(address vault);

        function getWeights() external view returns (address[] memory vaults, uint256[] memory bps);
        function votedWeightsActive() external view returns (bool);
        function WEIGHT_SETTER_ROLE() external view returns (bytes32);
    }

    /// InvestmentCommitteePolicy interface — agent allowlist subset.
    #[allow(missing_docs)]
    interface IInvestmentCommitteePolicy {
        function registerAgent(address agent, string calldata agentId_) external;
    }

    /// ConsensusRecommendationReceipt interface — record / read subset.
    #[allow(missing_docs)]
    interface IConsensusRecommendationReceipt {
        function ADMIN_ROLE() external view returns (bytes32);
        function recordReceipt(
            address submitter,
            bytes32 receiptId,
            bytes32 payloadDigest,
            string calldata payloadUri
        ) external returns (uint256 index);
        function isReleased(bytes32 receiptId) external view returns (bool);
    }

    /// OpenZeppelin AccessControl subset shared by every contract above.
    #[allow(missing_docs)]
    interface IAccessControl {
        error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);

        function grantRole(bytes32 role, address account) external;
        function hasRole(bytes32 role, address account) external view returns (bool);
    }

    /// RouterGovernance interface — the weight setter.
    #[allow(missing_docs)]
    interface IRouterGovernance {
        event ReceiptApplied(
            bytes32 indexed receiptId, bytes32 payloadDigest, address[] vaults, uint256[] bps
        );

        error ReceiptNotRecorded(bytes32 receiptId);
        error ReceiptAlreadyReleased(bytes32 receiptId);
        error PayloadDigestMismatch(bytes32 receiptId, bytes32 stored, bytes32 given);

        function WEIGHT_SETTER_ROLE() external view returns (bytes32);
        function applyReceipt(
            bytes32 receiptId,
            bytes32 payloadDigest,
            address[] calldata vaults,
            uint256[] calldata bps
        ) external;
    }
}

// ── The deployed stack ───────────────────────────────────────────────────────

/// One deployed weight-setter stack. `admin` deployed everything and holds
/// every admin role. It is the receipt register's gateway, the allowlisted
/// committee agent, and RouterGovernance's `WEIGHT_SETTER_ROLE` holder.
struct Stack<'a> {
    admin: Account<'a>,
    router: Address,
    receipts: Address,
    governance: Address,
    vault_a: Address,
    vault_b: Address,
}

fn read_bytes32<C: SolCall>(caller: &Account<'_>, to: Address, call: &C, label: &str) -> B256 {
    let raw = caller
        .call(to, call)
        .unwrap_or_else(|e| panic!("{label}: {e}"));
    assert!(raw.len() >= 32, "{label} returned fewer than 32 bytes");
    B256::from_slice(&raw[..32])
}

fn read_bool<C: SolCall>(caller: &Account<'_>, to: Address, call: &C, label: &str) -> bool {
    read_bytes32(caller, to, call, label) != B256::ZERO
}

fn grant_role(admin: &Account<'_>, target: Address, role: B256, account: Address, label: &str) {
    admin
        .send(
            target,
            &IAccessControl::grantRoleCall { role, account },
            U256::ZERO,
            200_000,
        )
        .unwrap_or_else(|e| panic!("grantRole {label}: {e}"));
}

/// Register `vault` in `registry` and mark it router-eligible (issue #475:
/// `setWeights` reverts `VaultNotRouterEligible` until the registry flag is set).
fn register_eligible_vault(
    admin: &Account<'_>,
    registry: Address,
    vault: Address,
    usdc: Address,
    name: &str,
) {
    admin
        .send(
            registry,
            &IVaultRegistry::registerVaultCall {
                vault,
                metadata: IVaultRegistry::VaultMetadata {
                    name: name.to_string(),
                    asset: usdc,
                    registeredAt: U256::ZERO,
                },
            },
            U256::ZERO,
            500_000,
        )
        .expect("registerVault");
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

/// Deploy and wire the full stack on `fx`.
fn deploy_stack<'a>(fx: &'a ForkFixture, tag: &str) -> Stack<'a> {
    let usdc = rmpc_fork_e2e::addresses::USDC;
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let admin = fx
        .ephemeral(one_eth * U256::from(5u64), U256::ZERO)
        .expect("fund admin");
    let me = admin.address;

    let registry = deploy_with_address_args(
        &admin,
        "VaultRegistry.sol",
        "VaultRegistry",
        &[me],
        3_000_000,
    );
    let vault_a =
        deploy_with_address_args(&admin, "MockVault.sol", "MockVault", &[usdc], 2_000_000);
    let vault_b =
        deploy_with_address_args(&admin, "MockVault.sol", "MockVault", &[usdc], 2_000_000);
    let router = deploy_with_address_args(
        &admin,
        "PortfolioRouter.sol",
        "PortfolioRouter",
        &[usdc, registry, me],
        8_000_000,
    );
    // InvestmentCommitteePolicy(admin_, gateway_): the gateway is never called here.
    let ic_policy = deploy_with_address_args(
        &admin,
        "InvestmentCommitteePolicy.sol",
        "InvestmentCommitteePolicy",
        &[me, me],
        8_000_000,
    );
    // ConsensusRecommendationReceipt(admin_, gateway_, icPolicy_): the test
    // account is the gateway, so it can call `recordReceipt` directly.
    let receipts = deploy_with_address_args(
        &admin,
        "ConsensusRecommendationReceipt.sol",
        "ConsensusRecommendationReceipt",
        &[me, me, ic_policy],
        5_000_000,
    );
    // RouterGovernance(_router, _receipts, _admin): `_admin` gets ADMIN_ROLE and
    // WEIGHT_SETTER_ROLE, standing in for the timelock.
    let governance = deploy_with_address_args(
        &admin,
        "RouterGovernance.sol",
        "RouterGovernance",
        &[router, receipts, me],
        5_000_000,
    );
    eprintln!(
        "[{tag}] registry={registry:#x} vault_a={vault_a:#x} vault_b={vault_b:#x} router={router:#x} \
         ic_policy={ic_policy:#x} receipts={receipts:#x} governance={governance:#x}"
    );

    register_eligible_vault(&admin, registry, vault_a, usdc, "Vault A");
    register_eligible_vault(&admin, registry, vault_b, usdc, "Vault B");

    // The receipt's submitter must hold COMMITTEE_AGENT_ROLE on the IC policy.
    admin
        .send(
            ic_policy,
            &IInvestmentCommitteePolicy::registerAgentCall {
                agent: me,
                agentId_: "fork-e2e-agent".to_string(),
            },
            U256::ZERO,
            300_000,
        )
        .expect("registerAgent");

    // RouterGovernance releases receipts (receipt ADMIN_ROLE) and sets weights
    // (router WEIGHT_SETTER_ROLE).
    let receipt_admin_role = read_bytes32(
        &admin,
        receipts,
        &IConsensusRecommendationReceipt::ADMIN_ROLECall {},
        "receipts.ADMIN_ROLE()",
    );
    grant_role(
        &admin,
        receipts,
        receipt_admin_role,
        governance,
        "receipts ADMIN_ROLE -> governance",
    );
    let router_setter_role = read_bytes32(
        &admin,
        router,
        &IPortfolioRouter::WEIGHT_SETTER_ROLECall {},
        "router.WEIGHT_SETTER_ROLE()",
    );
    grant_role(
        &admin,
        router,
        router_setter_role,
        governance,
        "router WEIGHT_SETTER_ROLE -> governance",
    );

    let stack = Stack {
        admin,
        router,
        receipts,
        governance,
        vault_a,
        vault_b,
    };
    assert!(
        !stack.voted_weights_active(),
        "a fresh router has no active weight vector"
    );
    stack
}

impl Stack<'_> {
    /// Record a receipt as the gateway, submitted by the allowlisted agent.
    /// Returns `(receiptId, payloadDigest)`.
    fn record_receipt(&self, label: &str) -> (B256, B256) {
        let receipt_id = keccak256(format!("fork-e2e receipt {label}").as_bytes());
        let digest = keccak256(format!("fork-e2e payload {label}").as_bytes());
        self.admin
            .send(
                self.receipts,
                &IConsensusRecommendationReceipt::recordReceiptCall {
                    submitter: self.admin.address,
                    receiptId: receipt_id,
                    payloadDigest: digest,
                    payloadUri: format!("ipfs://fork-e2e/{label}"),
                },
                U256::ZERO,
                400_000,
            )
            .expect("recordReceipt");
        assert!(
            !self.is_released(receipt_id),
            "a freshly recorded receipt is unreleased"
        );
        (receipt_id, digest)
    }

    fn apply_call(
        &self,
        receipt_id: B256,
        digest: B256,
        vaults: Vec<Address>,
        bps: &[u64],
    ) -> IRouterGovernance::applyReceiptCall {
        IRouterGovernance::applyReceiptCall {
            receiptId: receipt_id,
            payloadDigest: digest,
            vaults,
            bps: bps.iter().map(|b| U256::from(*b)).collect(),
        }
    }

    fn is_released(&self, receipt_id: B256) -> bool {
        read_bool(
            &self.admin,
            self.receipts,
            &IConsensusRecommendationReceipt::isReleasedCall {
                receiptId: receipt_id,
            },
            "isReleased",
        )
    }

    fn voted_weights_active(&self) -> bool {
        read_bool(
            &self.admin,
            self.router,
            &IPortfolioRouter::votedWeightsActiveCall {},
            "votedWeightsActive",
        )
    }

    fn router_weights(&self) -> (Vec<Address>, Vec<U256>) {
        let raw = self
            .admin
            .call(self.router, &IPortfolioRouter::getWeightsCall {})
            .expect("getWeights()");
        let r = IPortfolioRouter::getWeightsCall::abi_decode_returns(&raw, true)
            .expect("decode getWeights return");
        (r.vaults, r.bps)
    }
}

/// Assert `call` from `caller` reverts with the custom error `selector`: first
/// through `eth_call` (which carries the revert data), then as a sent
/// transaction (which must fail on chain).
fn expect_revert(
    caller: &Account<'_>,
    to: Address,
    call: &IRouterGovernance::applyReceiptCall,
    selector: [u8; 4],
    error_name: &str,
) {
    let selector_hex = hex::encode(selector);
    match caller.call(to, call) {
        Ok(out) => panic!(
            "eth_call must revert {error_name}; returned 0x{}",
            hex::encode(out)
        ),
        Err(e) => {
            let msg = e.to_string().to_lowercase();
            assert!(
                msg.contains(&selector_hex),
                "eth_call must revert {error_name} (selector 0x{selector_hex}); got: {e}"
            );
        }
    }
    match caller.send(to, call, U256::ZERO, 1_000_000) {
        Err(HarnessError::Reverted(_)) => {}
        Ok(r) => panic!(
            "applyReceipt must revert {error_name}; tx {:?} succeeded",
            r.tx_hash
        ),
        Err(e) => panic!("expected an on-chain revert ({error_name}), got: {e:?}"),
    }
}

// ── Scenario 1: happy path ───────────────────────────────────────────────────

/// governance_apply_receipt_round_trip — record a receipt, apply it, and assert
/// the receipt is released, the router routes by its vector, and
/// `ReceiptApplied` records the digest and the vector.
#[test]
fn governance_apply_receipt_round_trip() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let tag = "governance_apply_receipt_round_trip";
    eprintln!("[{tag}] {}", fx.summary_line());
    let s = deploy_stack(&fx, tag);

    let (receipt_id, digest) = s.record_receipt("round-trip");
    let vaults = vec![s.vault_a, s.vault_b];
    let bps = [6000u64, 4000];
    let r = s
        .admin
        .send(
            s.governance,
            &s.apply_call(receipt_id, digest, vaults.clone(), &bps),
            U256::ZERO,
            1_000_000,
        )
        .expect("applyReceipt");
    assert_eq!(r.status, 1, "applyReceipt must succeed");
    eprintln!(
        "[{tag}] applyReceipt tx {:?} gasUsed={}",
        r.tx_hash, r.gas_used
    );

    // ReceiptApplied(receiptId indexed, payloadDigest, vaults, bps).
    let log = r
        .logs
        .iter()
        .find(|l| {
            l.address == s.governance
                && l.topics.first() == Some(&IRouterGovernance::ReceiptApplied::SIGNATURE_HASH)
        })
        .unwrap_or_else(|| panic!("ReceiptApplied not found in logs: {:?}", r.logs));
    let ev = IRouterGovernance::ReceiptApplied::decode_raw_log(
        log.topics.iter().copied(),
        &log.data,
        true,
    )
    .expect("decode ReceiptApplied");
    assert_eq!(ev.receiptId, receipt_id, "event receiptId");
    assert_eq!(ev.payloadDigest, digest, "event payloadDigest");
    assert_eq!(ev.vaults, vaults, "event vaults");
    let want_bps: Vec<U256> = bps.iter().map(|b| U256::from(*b)).collect();
    assert_eq!(ev.bps, want_bps, "event bps");

    assert!(
        s.is_released(receipt_id),
        "applyReceipt must release the receipt"
    );
    assert!(
        s.voted_weights_active(),
        "applyReceipt must make the receipt's vector the active one"
    );
    let (w_vaults, w_bps) = s.router_weights();
    assert_eq!(
        w_vaults, vaults,
        "router vaults must equal the receipt's vector"
    );
    assert_eq!(
        w_bps, want_bps,
        "router bps must equal the receipt's vector"
    );
    eprintln!("[{tag}] passed");
}

// ── Scenario 2: digest mismatch ──────────────────────────────────────────────

/// governance_apply_receipt_digest_mismatch_reverts — the scheduled call names a
/// digest other than the receipt's stored one; `applyReceipt` reverts and the
/// receipt stays unreleased.
#[test]
fn governance_apply_receipt_digest_mismatch_reverts() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let tag = "governance_apply_receipt_digest_mismatch_reverts";
    eprintln!("[{tag}] {}", fx.summary_line());
    let s = deploy_stack(&fx, tag);

    let (receipt_id, digest) = s.record_receipt("digest-mismatch");
    let wrong_digest = keccak256(b"some other payload");
    assert_ne!(wrong_digest, digest);
    expect_revert(
        &s.admin,
        s.governance,
        &s.apply_call(receipt_id, wrong_digest, vec![s.vault_a], &[10_000]),
        IRouterGovernance::PayloadDigestMismatch::SELECTOR,
        "PayloadDigestMismatch",
    );

    assert!(
        !s.is_released(receipt_id),
        "the receipt must stay unreleased"
    );
    assert!(!s.voted_weights_active(), "no vector may be set");
    eprintln!("[{tag}] passed");
}

// ── Scenario 3: already released ─────────────────────────────────────────────

/// governance_apply_receipt_already_released_reverts — a receipt applies once; a
/// second apply (even with a different vector) reverts and the first vector
/// stays active.
#[test]
fn governance_apply_receipt_already_released_reverts() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let tag = "governance_apply_receipt_already_released_reverts";
    eprintln!("[{tag}] {}", fx.summary_line());
    let s = deploy_stack(&fx, tag);

    let (receipt_id, digest) = s.record_receipt("already-released");
    s.admin
        .send(
            s.governance,
            &s.apply_call(receipt_id, digest, vec![s.vault_a], &[10_000]),
            U256::ZERO,
            1_000_000,
        )
        .expect("first applyReceipt");
    assert!(
        s.is_released(receipt_id),
        "first apply releases the receipt"
    );

    expect_revert(
        &s.admin,
        s.governance,
        &s.apply_call(receipt_id, digest, vec![s.vault_b], &[10_000]),
        IRouterGovernance::ReceiptAlreadyReleased::SELECTOR,
        "ReceiptAlreadyReleased",
    );

    let (w_vaults, w_bps) = s.router_weights();
    assert_eq!(
        w_vaults,
        vec![s.vault_a],
        "the first vector must stay active"
    );
    assert_eq!(w_bps, vec![U256::from(10_000u64)]);
    eprintln!("[{tag}] passed");
}

// ── Scenario 4: caller without WEIGHT_SETTER_ROLE ────────────────────────────

/// governance_apply_receipt_non_weight_setter_reverts — only the
/// `WEIGHT_SETTER_ROLE` holder (the timelock) may apply a receipt; any other
/// caller reverts and the receipt stays unreleased.
#[test]
fn governance_apply_receipt_non_weight_setter_reverts() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let tag = "governance_apply_receipt_non_weight_setter_reverts";
    eprintln!("[{tag}] {}", fx.summary_line());
    let s = deploy_stack(&fx, tag);

    let (receipt_id, digest) = s.record_receipt("non-weight-setter");
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let stranger = fx.ephemeral(one_eth, U256::ZERO).expect("fund stranger");
    let setter_role = read_bytes32(
        &s.admin,
        s.governance,
        &IRouterGovernance::WEIGHT_SETTER_ROLECall {},
        "governance.WEIGHT_SETTER_ROLE()",
    );
    assert!(
        !read_bool(
            &s.admin,
            s.governance,
            &IAccessControl::hasRoleCall {
                role: setter_role,
                account: stranger.address,
            },
            "hasRole(stranger)",
        ),
        "the stranger must not hold WEIGHT_SETTER_ROLE"
    );

    expect_revert(
        &stranger,
        s.governance,
        &s.apply_call(receipt_id, digest, vec![s.vault_a], &[10_000]),
        IAccessControl::AccessControlUnauthorizedAccount::SELECTOR,
        "AccessControlUnauthorizedAccount",
    );

    assert!(
        !s.is_released(receipt_id),
        "the receipt must stay unreleased"
    );
    assert!(!s.voted_weights_active(), "no vector may be set");
    eprintln!("[{tag}] passed");
}

// ── Scenario 5: duplicate vault ──────────────────────────────────────────────

/// governance_apply_receipt_duplicate_vault_reverts — the router refuses a
/// vector that names a vault twice; the whole call reverts, so the receipt is
/// not released either.
#[test]
fn governance_apply_receipt_duplicate_vault_reverts() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let tag = "governance_apply_receipt_duplicate_vault_reverts";
    eprintln!("[{tag}] {}", fx.summary_line());
    let s = deploy_stack(&fx, tag);

    let (receipt_id, digest) = s.record_receipt("duplicate-vault");
    expect_revert(
        &s.admin,
        s.governance,
        &s.apply_call(
            receipt_id,
            digest,
            vec![s.vault_a, s.vault_a],
            &[5000, 5000],
        ),
        IPortfolioRouter::DuplicateVault::SELECTOR,
        "DuplicateVault",
    );

    assert!(
        !s.is_released(receipt_id),
        "a refused vector must not leave the receipt released"
    );
    assert!(!s.voted_weights_active(), "no vector may be set");
    eprintln!("[{tag}] passed");
}
