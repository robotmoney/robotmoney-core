//! Canonical: Plan tracking issue #109 §4.8 — CLI surface
//!
//! Argument parsing for the `rmpc` CLI.
//!
//! Lives in the library so integration tests can introspect the parser.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

/// Planned `rmpc deposit` execution route.
///
/// Issue #649 owns adding this as a parsed CLI argument and routing `Router`
/// through `RobotMoneyGateway.depositTo`. Keeping the enum unwired here avoids
/// accepting a flag that still executes the existing vault-only path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum DepositDestination {
    Vault,
    Router,
}

#[derive(Debug, Parser)]
#[command(name = "rmpc", version, about = "Robot Money payment client")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Sign and broadcast a USDC deposit through the gateway.
    ///
    /// When `--destination` is supplied the call encodes
    /// `gateway.depositTo(orderId, amount, deadline, idempotencyKey,
    /// destination, minSharesPerLeg)`, routing the deposit through the
    /// PortfolioRouter at that address. Without `--destination` the
    /// existing single-vault `gateway.deposit()` path is used unchanged.
    Deposit {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Deposit amount in USDC's smallest unit (6 decimals). Decimal
        /// integer string; e.g. `100000000` = 100 USDC.
        #[arg(long)]
        amount: String,
        /// 32-byte order id, 0x-prefixed hex.
        #[arg(long = "order-id")]
        order_id: String,
        /// 32-byte idempotency key, 0x-prefixed hex. Defaults to
        /// `--order-id` when omitted.
        #[arg(long = "idempotency-key")]
        idempotency_key: Option<String>,
        /// Deadline horizon in seconds from now. Capped at 600 (the
        /// gateway's `MAX_DEADLINE_SKEW`). Default 300.
        #[arg(long = "deadline-secs", default_value_t = 300)]
        deadline_secs: u64,
        /// Maximum seconds to wait for the receipt. Default 60.
        #[arg(long = "receipt-timeout-secs", default_value_t = 60)]
        receipt_timeout_secs: u64,
        /// Gas limit for the deposit tx envelope. Default 3_000_000 — a
        /// deposit allocates across the three real yield adapters and reads
        /// `totalAssets()` on each, including the Morpho Gauntlet USDC Prime
        /// vault whose `convertToAssets` iterates its multi-market supply
        /// queue (per-market `idToMarketParams`/`extSloads`/`market` reads
        /// plus AdaptiveCurveIRM accrual). On a real-adapter vault this path
        /// costs ~1.55M gas, so the historical 750_000 default ran out of gas
        /// once the now-removed no-yield test adapter no longer
        /// short-circuited `totalAssets()` (issue #912).
        #[arg(long = "gas-limit", default_value_t = 3_000_000)]
        gas_limit: u64,
        /// Optional override for `max_fee_per_gas_cap` in wei (issue #93).
        /// When set, this beats both the TOML `max_fee_per_gas_cap`
        /// field and the per-chain default for any chain id.
        #[arg(long = "fee-cap")]
        fee_cap: Option<u64>,
        /// Router-deposit destination: 0x-prefixed address of the
        /// PortfolioRouter to route through. When provided the command
        /// calls `gateway.depositTo()` instead of `gateway.deposit()`.
        #[arg(long)]
        destination: Option<String>,
        /// Per-leg minimum shares for the router deposit (repeatable or
        /// comma-separated decimal U256 values). Only meaningful together
        /// with `--destination`; defaults to an empty slice when omitted.
        #[arg(long = "min-shares-per-leg", value_delimiter = ',', num_args = 0..)]
        min_shares_per_leg: Vec<String>,
        /// Pretty-print the JSON output (multi-line, indented).
        #[arg(long)]
        pretty: bool,
    },
    /// Look up a previously submitted payment by its on-chain `paymentId`.
    Status {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// 32-byte payment id, 0x-prefixed hex.
        #[arg(long = "payment-id")]
        payment_id: String,
        /// Pretty-print the JSON output (multi-line, indented).
        #[arg(long)]
        pretty: bool,
    },
    /// Print the signer-backend self-check report (v0 §9.2 JSON).
    SelfCheck {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Pretty-print the JSON output (multi-line, indented).
        #[arg(long)]
        pretty: bool,
    },
    /// Read vault state directly from chain (issue #49 / §9).
    GetVault {
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Vault address to look up in the registry (0x-prefixed hex).
        /// When provided, reads from the VaultRegistry contract and returns
        /// registry metadata plus live ERC-4626 state. When omitted, reads
        /// the single vault pinned in the operator config (legacy behaviour).
        #[arg(long)]
        address: Option<String>,
        #[arg(long)]
        pretty: bool,
    },
    /// List all vaults registered in the VaultRegistry (issue #297 / §5.1).
    GetVaults {
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Read PortfolioRouter state: vault addresses, weight bps, and router
    /// cap (issue #308 / §5.1).
    GetRouter {
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Read RouterGovernance state: active proposal, cadence params, and
    /// last applied weight vector (issue #308 / §5.1).
    GetGovernance {
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Read TimelockController state: proposers, executors, min delay, and
    /// pending operation hashes with ready timestamps (issue #414).
    GetTimelock {
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Read gateway state directly from chain (issue #49 / §9).
    GetGateway {
        #[arg(long, short = 'c')]
        config: PathBuf,
        #[arg(long)]
        pretty: bool,
    },
    /// Read an agent's authorization + window usage (issue #49 / §9).
    GetAgent {
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Target agent address, 0x-prefixed hex.
        #[arg(long)]
        agent: String,
        #[arg(long)]
        pretty: bool,
    },
    /// Read role membership on the gateway for a target address
    /// (issue #49 / §9).
    GetRoles {
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Target address, 0x-prefixed hex.
        #[arg(long)]
        address: String,
        #[arg(long)]
        pretty: bool,
    },
    /// Read an ERC-20 token balance for an address (USDC by default).
    ///
    /// Per Plan tracking issue #109 §9 / docs/technical/rmpc-read-output-contract.md.
    GetBalance {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// 20-byte holder address, 0x-prefixed hex.
        #[arg(long)]
        address: String,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Read an ERC-20 allowance(owner, spender) on the configured USDC.
    GetAllowance {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// 20-byte owner address, 0x-prefixed hex.
        #[arg(long)]
        owner: String,
        /// 20-byte spender address, 0x-prefixed hex.
        #[arg(long)]
        spender: String,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Look up a gateway deposit by its on-chain id (`AgentDeposit.paymentId`).
    GetDeposit {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// 32-byte deposit (payment) id, 0x-prefixed hex.
        #[arg(long = "deposit-id")]
        deposit_id: String,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Look up a transaction's receipt status by hash.
    GetTx {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// 32-byte transaction hash, 0x-prefixed hex.
        #[arg(long = "tx-hash")]
        tx_hash: String,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Submit a new weight-reallocation proposal to RouterGovernance.propose()
    /// (issue #632). Requires `governance_address` in the operator config and
    /// a production-grade (or software-fallback) signer. Returns
    /// `{ok:true,result:{proposal_id,tx_hash,block_number}}` on success.
    Propose {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Comma-separated vault addresses, 0x-prefixed hex.
        /// Example: `--vaults 0xAAA...,0xBBB...`
        #[arg(long, value_delimiter = ',')]
        vaults: Vec<String>,
        /// Comma-separated weight bps values (must sum to 10 000).
        /// Example: `--weights-bps 6000,4000`
        #[arg(long = "weights-bps", value_delimiter = ',')]
        weights_bps: Vec<u64>,
        /// Gas limit for the propose tx envelope. Default 500 000.
        #[arg(long = "gas-limit", default_value_t = 500_000)]
        gas_limit: u64,
        /// Optional override for `max_fee_per_gas_cap` in wei.
        #[arg(long = "fee-cap")]
        fee_cap: Option<u64>,
        /// Maximum seconds to wait for the receipt. Default 60.
        #[arg(long = "receipt-timeout-secs", default_value_t = 60)]
        receipt_timeout_secs: u64,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Cast a vote on an active RouterGovernance proposal (issue #632).
    /// Uses `RouterGovernance.vote(proposalId)` for `--choice yes`;
    /// `no` and `abstain` are client-side no-ops (contract supports FOR only).
    /// Idempotent: re-casting the same choice exits 0; a different choice
    /// after an on-chain `yes` exits 2 with ErrVoteAlreadyCast.
    Vote {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Proposal id to vote on (decimal integer).
        #[arg(long = "proposal-id")]
        proposal_id: String,
        /// Vote direction: `yes`, `no`, or `abstain`.
        #[arg(long)]
        choice: String,
        /// Gas limit for the vote tx envelope. Default 200 000.
        #[arg(long = "gas-limit", default_value_t = 200_000)]
        gas_limit: u64,
        /// Optional override for `max_fee_per_gas_cap` in wei.
        #[arg(long = "fee-cap")]
        fee_cap: Option<u64>,
        /// Maximum seconds to wait for the receipt. Default 60.
        #[arg(long = "receipt-timeout-secs", default_value_t = 60)]
        receipt_timeout_secs: u64,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Redeem vault shares through the gateway (agent-initiated redemption).
    ///
    /// Performs preflight reads (gateway paused, agent policy, vault paused,
    /// share allowance, share balance) then builds and broadcasts a
    /// `gateway.withdraw(orderId, shares, sourceVault, deadline, idempotencyKey)`
    /// call. Emits a stable JSON result with `assetsOut`, `assetRecipient`,
    /// `txHash`, and `blockNumber` on success; exits non-zero on any refusal.
    Withdraw {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Number of vault shares to redeem (decimal, in share units).
        #[arg(long)]
        shares: String,
        /// Source vault address to redeem from (0x-prefixed hex).
        #[arg(long = "source-vault")]
        source_vault: String,
        /// 32-byte order id, 0x-prefixed hex.
        #[arg(long = "order-id")]
        order_id: String,
        /// 32-byte idempotency key, 0x-prefixed hex. Defaults to
        /// `--order-id` when omitted.
        #[arg(long = "idempotency-key")]
        idempotency_key: Option<String>,
        /// Deadline horizon in seconds from now. Capped at 600. Default 300.
        #[arg(long = "deadline-secs", default_value_t = 300)]
        deadline_secs: u64,
        /// Maximum seconds to wait for the receipt. Default 60.
        #[arg(long = "receipt-timeout-secs", default_value_t = 60)]
        receipt_timeout_secs: u64,
        /// Gas limit for the withdraw tx envelope. Default 3_000_000 — a
        /// redemption reads `totalAssets()` across the three real yield
        /// adapters (including the Morpho Gauntlet USDC Prime multi-market
        /// `convertToAssets` loop) AND performs the real adapter withdrawal,
        /// so it is at least as expensive as a deposit. The historical
        /// 350_000 default was sized for the now-removed no-yield test
        /// adapter (issue #912).
        #[arg(long = "gas-limit", default_value_t = 3_000_000)]
        gas_limit: u64,
        /// Optional override for `max_fee_per_gas_cap` in wei.
        #[arg(long = "fee-cap")]
        fee_cap: Option<u64>,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Redeem vault shares via the Portfolio Router (multi-vault proportional
    /// redemption, agent-initiated).
    ///
    /// Reads the router's effective weight vector, distributes the requested
    /// per-leg shares across the caller-supplied vaults, and calls
    /// `gateway.withdrawFromRouter(orderId, vaults, sharesPerLeg, deadline, idempotencyKey)`.
    /// USDC lands at the policy-configured `assetRecipient`; no shares pass
    /// through the gateway. Re-run with `--get-router` first to preview the
    /// router's current vault order.
    ///
    /// Requires `--confirm` to proceed past the preview.
    WithdrawRouter {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        /// Comma-separated share amounts per router leg (decimal, one per
        /// vault in the router's effective weight vector order).
        /// Example: `--shares-per-leg 60000000,40000000`
        #[arg(long = "shares-per-leg", value_delimiter = ',')]
        shares_per_leg: Vec<String>,
        /// Comma-separated vault addresses to redeem from (0x-prefixed), one per
        /// leg, parallel to --shares-per-leg. Identity-bound: shares_per_leg[i] is
        /// redeemed from vaults[i] (issue #967). Drives the redeem legs directly
        /// instead of the router's live weight vector.
        #[arg(long = "vaults", value_delimiter = ',')]
        vaults: Vec<String>,
        /// Per-leg minimum USDC out (slippage floor), decimal, parallel to
        /// `--shares-per-leg`. The gateway forwards this floor to the router,
        /// which reverts a leg whose realized proceeds fall below it (GW-5 /
        /// F-11). Length must equal `--shares-per-leg`; a leg value of 0
        /// disables the floor for that leg. When omitted entirely the client
        /// sends an all-zero floor of the same length (back-compat), but a real
        /// off-chain-computed minimum is strongly recommended.
        /// Example: `--min-assets-per-leg 59700000,39800000`
        #[arg(long = "min-assets-per-leg", value_delimiter = ',', num_args = 0..)]
        min_assets_per_leg: Vec<String>,
        /// 32-byte order id, 0x-prefixed hex.
        #[arg(long = "order-id")]
        order_id: String,
        /// 32-byte idempotency key, 0x-prefixed hex. Defaults to
        /// `--order-id` when omitted.
        #[arg(long = "idempotency-key")]
        idempotency_key: Option<String>,
        /// Deadline horizon in seconds from now. Capped at 600. Default 300.
        #[arg(long = "deadline-secs", default_value_t = 300)]
        deadline_secs: u64,
        /// Maximum seconds to wait for the receipt. Default 60.
        #[arg(long = "receipt-timeout-secs", default_value_t = 60)]
        receipt_timeout_secs: u64,
        /// Gas limit for the withdraw-router tx. Default 750_000 (covers
        /// N-leg vault redemption with cold storage writes).
        #[arg(long = "gas-limit", default_value_t = 750_000)]
        gas_limit: u64,
        /// Optional override for `max_fee_per_gas_cap` in wei.
        #[arg(long = "fee-cap")]
        fee_cap: Option<u64>,
        /// Proceed past the preview and sign + broadcast the transaction.
        /// Without this flag the command prints a preview and exits 2.
        #[arg(long)]
        confirm: bool,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
    /// Investment Committee v0 — register an agent or submit a signed
    /// allocation vote through the InvestmentCommitteePolicy contract,
    /// routed via RobotMoneyGateway.
    ///
    /// Both subcommands write through the gateway (same signer + policy
    /// enforced as for deposits). Implements: issue #1044.
    Committee {
        /// Path to the operator config TOML. Requires `ic_policy_address`.
        #[arg(long, short = 'c')]
        config: PathBuf,
        #[command(subcommand)]
        subcommand: CommitteeSubcommand,
        /// Pretty-print the JSON output.
        #[arg(long, global = true)]
        pretty: bool,
    },
    /// Manage the local Investment Swarm signing identity — the
    /// production signing path for every swarm member. Ed25519 keypair,
    /// encrypted at rest — distinct from the on-chain EVM signer used by
    /// `rmpc committee register` / `vote-submit`. Exports a base64 public
    /// key for `POST /api/swarm/apply` and signs the exact canonical
    /// payload returned by `POST /api/swarm/signing-payload`, producing
    /// the signature `POST /api/swarm/submit` requires, so a prospective
    /// member never has to hand-roll Ed25519 code. The flow is plain REST
    /// end to end (apply -> approval -> claim -> participate).
    /// Implements: issue #1111.
    ///
    /// The keystore passphrase is never accepted on argv and never read
    /// from stdin, so it must never be typed into an agent transcript.
    /// Set `RMPC_COMMITTEE_IDENTITY_PASSPHRASE_FILE` to a
    /// current-user-owned file with mode 0600 or stricter, or run the
    /// command from a terminal and type it at the local `/dev/tty`
    /// prompt. The legacy `RMPC_COMMITTEE_IDENTITY_PASSPHRASE`
    /// environment variable remains supported.
    CommitteeIdentity {
        /// Path to the committee identity keystore file.
        #[arg(long, short = 'p')]
        path: PathBuf,
        #[command(subcommand)]
        subcommand: CommitteeIdentitySubcommand,
        /// Pretty-print the JSON output.
        #[arg(long, global = true)]
        pretty: bool,
    },
}

/// Subcommands for `rmpc committee-identity`.
#[derive(Debug, Subcommand)]
pub enum CommitteeIdentitySubcommand {
    /// Generate a fresh Ed25519 committee signing identity and write
    /// an encrypted keystore at `--path`. Refuses to overwrite an
    /// existing file.
    Create,
    /// Print the identity's base64 (standard, padded) Ed25519 public
    /// key — the exact value `POST /api/swarm/apply`'s `publicKey`
    /// field expects. Reads the keystore's cleartext `public_key` field;
    /// no passphrase required.
    ShowPublicKey,
    /// Sign the exact canonical payload string returned by `POST
    /// /api/swarm/signing-payload` and print the base64 (standard,
    /// padded) Ed25519 signature that `POST /api/swarm/submit` requires
    /// alongside the member bearer token. Deterministic: signing the same
    /// payload twice yields the same signature.
    Sign {
        /// The exact canonical payload string to sign, passed inline.
        /// Mutually exclusive with `--payload-file`.
        #[arg(long, conflicts_with = "payload_file")]
        payload: Option<String>,
        /// Path to a file holding the exact canonical payload bytes to
        /// sign (every byte in the file is signed verbatim, no trimming).
        /// A file ending in whitespace is refused because canonical JSON
        /// cannot end in whitespace; use `printf '%s' "$payload" > file`,
        /// never `echo`. Mutually exclusive with `--payload`. Prefer this
        /// over `--payload` for payloads containing shell-sensitive characters.
        #[arg(long = "payload-file", conflicts_with = "payload")]
        payload_file: Option<PathBuf>,
    },
}

/// Subcommands for `rmpc committee`.
#[derive(Debug, Subcommand)]
pub enum CommitteeSubcommand {
    /// Register a committee agent address in the InvestmentCommitteePolicy
    /// contract. Caller must hold ADMIN_ROLE on the IC policy contract.
    ///
    /// Routes through RobotMoneyGateway with `--order-id` as the
    /// idempotency key.
    Register {
        /// Committee agent address to allowlist (0x-prefixed hex).
        #[arg(long)]
        agent: String,
        /// Human-readable agent identifier (e.g. "athena-v1", "robot-money").
        #[arg(long = "agent-id")]
        agent_id: String,
        /// 32-byte order id / idempotency key, 0x-prefixed hex.
        #[arg(long = "order-id")]
        order_id: String,
        /// Deadline horizon in seconds from now. Default 300.
        #[arg(long = "deadline-secs", default_value_t = 300)]
        deadline_secs: u64,
        /// Maximum seconds to wait for the receipt. Default 60.
        #[arg(long = "receipt-timeout-secs", default_value_t = 60)]
        receipt_timeout_secs: u64,
        /// Gas limit for the register tx. Default 300_000.
        #[arg(long = "gas-limit", default_value_t = 300_000)]
        gas_limit: u64,
        /// Optional override for `max_fee_per_gas_cap` in wei.
        #[arg(long = "fee-cap")]
        fee_cap: Option<u64>,
    },
    /// Submit a signed allocation vote for a vault through the
    /// InvestmentCommitteePolicy contract. Caller must hold
    /// COMMITTEE_AGENT_ROLE on the IC policy contract.
    ///
    /// Routes through RobotMoneyGateway with `--order-id` as the
    /// idempotency key.
    VoteSubmit {
        /// Target vault address (0x-prefixed hex).
        #[arg(long)]
        vault: String,
        /// Allocation stance: overweight | neutral | underweight.
        #[arg(long)]
        stance: String,
        /// Target allocation weight in basis points (0–10 000).
        #[arg(long = "weight-bps")]
        target_weight_bps: u16,
        /// Confidence score 0–100.
        #[arg(long)]
        confidence: u8,
        /// Public URI to the narrative chain-of-thought / memo.
        #[arg(long = "rationale-uri")]
        rationale_uri: String,
        /// keccak256 of the full vote JSON (0x-prefixed hex).
        #[arg(long = "vote-json-hash")]
        vote_json_hash: String,
        /// keccak256 of the agent prompt (0x-prefixed hex).
        #[arg(long = "prompt-hash")]
        prompt_hash: String,
        /// keccak256 of the inputs consumed (0x-prefixed hex).
        #[arg(long = "inputs-digest")]
        inputs_digest: String,
        /// Vote JSON schema version. Default "1.0".
        #[arg(long = "schema-version", default_value = "1.0")]
        schema_version: String,
        /// Unix seconds when the vote was formed.
        #[arg(long)]
        timestamp: u64,
        /// 32-byte order id / idempotency key, 0x-prefixed hex.
        #[arg(long = "order-id")]
        order_id: String,
        /// Deadline horizon in seconds from now. Default 300.
        #[arg(long = "deadline-secs", default_value_t = 300)]
        deadline_secs: u64,
        /// Maximum seconds to wait for the receipt. Default 60.
        #[arg(long = "receipt-timeout-secs", default_value_t = 60)]
        receipt_timeout_secs: u64,
        /// Gas limit for the vote-submit tx. Default 500_000.
        #[arg(long = "gas-limit", default_value_t = 500_000)]
        gas_limit: u64,
        /// Optional override for `max_fee_per_gas_cap` in wei.
        #[arg(long = "fee-cap")]
        fee_cap: Option<u64>,
    },
}
