//! Canonical: docs/implementation-plan.md §4.8 — CLI surface
//!
//! Argument parsing for the `rmpc` CLI.
//!
//! Lives in the library so integration tests can introspect the parser.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "rmpc", version, about = "Robot Money payment client")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Sign and broadcast a USDC deposit through the gateway.
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
        /// Gas limit for the deposit tx envelope. Default 750_000 — the
        /// vault path can perform cold ERC-4626, adapter allowlist, and
        /// strategy-allocation writes on first interaction.
        #[arg(long = "gas-limit", default_value_t = 750_000)]
        gas_limit: u64,
        /// Optional override for `max_fee_per_gas_cap` in wei (issue #93).
        /// When set, this beats both the TOML `max_fee_per_gas_cap`
        /// field and the per-chain default for any chain id.
        #[arg(long = "fee-cap")]
        fee_cap: Option<u64>,
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
    /// Per docs/implementation-plan.md §9 / docs/technical/rmpc-read-output-contract.md.
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
        /// Gas limit for the withdraw tx envelope. Default 350_000.
        #[arg(long = "gas-limit", default_value_t = 350_000)]
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
    /// per-leg shares across all active router vaults, and calls
    /// `gateway.withdrawFromRouter(orderId, sharesPerLeg, deadline, idempotencyKey)`.
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
}
