//! Canonical: Plan tracking issue #109 §4.8 — CLI surface
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
    /// Sign and broadcast a USDC deposit through the gateway into a vault.
    ///
    /// Encodes `gateway.depositTo(orderId, amount, deadline, idempotencyKey,
    /// vault, [])`. The vault is `--vault` when given, else the config's
    /// `vault_address`. It must be one the owner selected (`allowed_destinations`
    /// in the config, else `vault_address`) and one the gateway policy lists.
    /// rmpc checks that vault's pause state and implementation before signing.
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
        /// Gas limit for the deposit tx envelope. When omitted the client
        /// uses 3_000_000 (gateway entry floor 2_000_000; a deposit across
        /// real yield adapters costs ~1.55M gas, issue #912). A value below
        /// the floor is refused with `ErrGasLimitBelowFloor` before signing:
        /// the gateway would revert `InsufficientGas` and burn the gas and
        /// the nonce.
        #[arg(long = "gas-limit")]
        gas_limit: Option<u64>,
        /// Optional override for `max_fee_per_gas_cap` in wei (issue #93).
        /// When set, this beats both the TOML `max_fee_per_gas_cap`
        /// field and the per-chain default for any chain id.
        #[arg(long = "fee-cap")]
        fee_cap: Option<u64>,
        /// Vault to deposit into (0x-prefixed address). Defaults to the
        /// config's `vault_address`.
        #[arg(long)]
        vault: Option<String>,
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
    /// Print the exact source commit this binary was compiled from
    /// (embedded at build time), plus its cargo version. No config file
    /// or chain access needed. Exists so provenance checks (fusion-qa's
    /// AC-ID-03) can compare against the pinned tag's commit directly
    /// instead of inferring staleness from the binary's mtime.
    BuildInfo {
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
    /// Read RouterGovernance state: the active and default router weight
    /// vectors, the router and receipt register it is bound to, and who holds
    /// `ADMIN_ROLE` and `WEIGHT_SETTER_ROLE` (issue #1698).
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
    /// Consensus recommendation receipt (Project Fusion) — verify a receipt
    /// off-chain.
    ///
    /// The chain proves that one submitter attested to the receipt; it cannot
    /// prove each named analyst signed, because the EVM has no Ed25519
    /// precompile. The embedded analyst signatures are therefore verified
    /// off-chain here. Implements: issue #1247.
    Receipt {
        /// Path to the operator config TOML.
        #[arg(long, short = 'c')]
        config: PathBuf,
        #[command(subcommand)]
        subcommand: ReceiptSubcommand,
        /// Pretty-print the JSON output.
        #[arg(long, global = true)]
        pretty: bool,
    },
    /// Manage the local Investment Swarm signing identity — the
    /// production signing path for every swarm member. Ed25519 keypair,
    /// encrypted at rest — distinct from the on-chain EVM signer used by
    /// `rmpc committee vote-submit`. Exports a base64 public
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

/// Subcommands for `rmpc receipt`.
#[derive(Debug, Subcommand)]
pub enum ReceiptSubcommand {
    /// Fetch (or read) a consensus recommendation receipt, canonicalize it, print
    /// the derived `payload_digest` and `receipt_id`, and report per-analyst
    /// Ed25519 verification. Read-only: no signer, no nonce, no chain. Exits
    /// non-zero on any validation or signature failure.
    Verify {
        /// URL serving the receipt JSON (the swarm API's
        /// `/api/swarm/receipts/{session_id}` route). Mutually exclusive with
        /// `--receipt-file`; exactly one is required.
        #[arg(long = "receipt-url", conflicts_with = "receipt_file")]
        receipt_url: Option<String>,
        /// Local path to the receipt JSON. Mutually exclusive with
        /// `--receipt-url`; exactly one is required.
        #[arg(long = "receipt-file", conflicts_with = "receipt_url")]
        receipt_file: Option<PathBuf>,
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
