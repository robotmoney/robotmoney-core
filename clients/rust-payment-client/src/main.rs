//! Canonical: Plan tracking issue #109 §4 — Phase 1 Rust client
//!
//! `rmpc` — Robot Money payment client CLI entry point.
//!
//! All command logic lives in [`rust_payment_client::commands`]; this file
//! is a thin shim that parses argv, initialises logging, and dispatches.

use std::path::Path;

use clap::Parser;
use rust_payment_client::cli::{
    Cli, Command, CommitteeIdentitySubcommand, CommitteeSubcommand, GovernanceSubcommand,
    ReceiptSubcommand,
};
use rust_payment_client::commands;
use rust_payment_client::config::Config;
use rust_payment_client::logging;

fn main() {
    let cli = Cli::parse();

    // Best-effort logging init from the subcommand's config file. We
    // refuse to skip logging silently: if the config can't load, we'll
    // still run with defaults so the operator gets at least the boot
    // banner. Subcommands re-load the config themselves and surface
    // proper errors there.
    let config_path = match &cli.command {
        Command::Deposit { config, .. } => Some(config.as_path()),
        Command::Status { config, .. } => Some(config.as_path()),
        Command::SelfCheck { config, .. } => Some(config.as_path()),
        Command::GetVault { config, .. } => Some(config.as_path()),
        Command::GetVaults { config, .. } => Some(config.as_path()),
        Command::GetRouter { config, .. } => Some(config.as_path()),
        Command::GetGovernance { config, .. } => Some(config.as_path()),
        Command::GetTimelock { config, .. } => Some(config.as_path()),
        Command::GetGateway { config, .. } => Some(config.as_path()),
        Command::GetAgent { config, .. } => Some(config.as_path()),
        Command::GetRoles { config, .. } => Some(config.as_path()),
        Command::GetBalance { config, .. } => Some(config.as_path()),
        Command::GetAllowance { config, .. } => Some(config.as_path()),
        Command::GetDeposit { config, .. } => Some(config.as_path()),
        Command::GetTx { config, .. } => Some(config.as_path()),
        Command::Propose { config, .. } => Some(config.as_path()),
        Command::Vote { config, .. } => Some(config.as_path()),
        Command::Withdraw { config, .. } => Some(config.as_path()),
        Command::WithdrawRouter { config, .. } => Some(config.as_path()),
        Command::Committee { config, .. } => Some(config.as_path()),
        Command::Receipt { config, .. } => Some(config.as_path()),
        Command::Governance { config, .. } => Some(config.as_path()),
        // No operator config TOML — this is a local-only Ed25519 identity
        // helper with no RPC/chain surface (issue #1111).
        Command::CommitteeIdentity { .. } => None,
    };
    init_logging_best_effort(config_path);

    let exit_code = match cli.command {
        Command::Deposit {
            config,
            amount,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            fee_cap,
            destination,
            min_shares_per_leg,
            pretty,
        } => commands::deposit::run(commands::deposit::Args {
            config_path: config,
            amount,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            fee_cap_wei: fee_cap,
            destination,
            min_shares_per_leg,
            pretty,
        }),
        Command::SelfCheck { config, pretty } => commands::self_check::run(&config, pretty),
        Command::Status {
            config,
            payment_id,
            pretty,
        } => commands::status::run(&config, &payment_id, pretty),
        Command::GetVault {
            config,
            address,
            pretty,
        } => commands::get_vault::run(&config, address.as_deref(), pretty),
        Command::GetVaults { config, pretty } => commands::get_vaults::run(&config, pretty),
        Command::GetRouter { config, pretty } => commands::get_router::run(&config, pretty),
        Command::GetGovernance { config, pretty } => commands::get_governance::run(&config, pretty),
        Command::GetTimelock { config, pretty } => commands::get_timelock::run(&config, pretty),
        Command::GetGateway { config, pretty } => commands::get_gateway::run(&config, pretty),
        Command::GetAgent {
            config,
            agent,
            pretty,
        } => commands::get_agent::run(&config, &agent, pretty),
        Command::GetRoles {
            config,
            address,
            pretty,
        } => commands::get_roles::run(&config, &address, pretty),
        Command::GetBalance {
            config,
            address,
            pretty,
        } => commands::get_balance::run(&config, &address, pretty),
        Command::GetAllowance {
            config,
            owner,
            spender,
            pretty,
        } => commands::get_allowance::run(&config, &owner, &spender, pretty),
        Command::GetDeposit {
            config,
            deposit_id,
            pretty,
        } => commands::get_deposit::run(&config, &deposit_id, pretty),
        Command::GetTx {
            config,
            tx_hash,
            pretty,
        } => commands::get_tx::run(&config, &tx_hash, pretty),
        Command::Propose {
            config,
            vaults,
            weights_bps,
            gas_limit,
            fee_cap,
            receipt_timeout_secs,
            pretty,
        } => commands::propose::run(commands::propose::Args {
            config_path: config,
            vaults,
            weights_bps,
            gas_limit,
            fee_cap_wei: fee_cap,
            receipt_timeout_secs,
            pretty,
        }),
        Command::Vote {
            config,
            proposal_id,
            choice,
            gas_limit,
            fee_cap,
            receipt_timeout_secs,
            pretty,
        } => {
            let choice = match commands::vote::VoteChoice::from_str_ci(&choice) {
                Some(c) => c,
                None => {
                    eprintln!(
                        "rmpc vote: --choice must be one of: yes, no, abstain (got {choice:?})"
                    );
                    std::process::exit(3);
                }
            };
            commands::vote::run(commands::vote::Args {
                config_path: config,
                proposal_id,
                choice,
                gas_limit,
                fee_cap_wei: fee_cap,
                receipt_timeout_secs,
                pretty,
            })
        }
        Command::Withdraw {
            config,
            shares,
            source_vault,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            fee_cap,
            pretty,
        } => commands::withdraw::run(commands::withdraw::Args {
            config_path: config,
            shares,
            source_vault,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            fee_cap_wei: fee_cap,
            pretty,
        }),
        Command::WithdrawRouter {
            config,
            shares_per_leg,
            vaults,
            min_assets_per_leg,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            fee_cap,
            confirm,
            pretty,
        } => commands::withdraw_router::run(commands::withdraw_router::Args {
            config_path: config,
            shares_per_leg,
            vaults,
            min_assets_per_leg,
            order_id,
            idempotency_key,
            deadline_secs,
            receipt_timeout_secs,
            gas_limit,
            fee_cap_wei: fee_cap,
            confirm,
            pretty,
        }),
        Command::Committee {
            config,
            subcommand,
            pretty,
        } => match subcommand {
            CommitteeSubcommand::Register {
                agent,
                agent_id,
                order_id,
                deadline_secs,
                receipt_timeout_secs,
                gas_limit,
                fee_cap,
            } => commands::committee::run_register(commands::committee::RegisterArgs {
                config_path: config,
                agent,
                agent_id,
                order_id,
                deadline_secs,
                receipt_timeout_secs,
                gas_limit,
                fee_cap_wei: fee_cap,
                pretty,
            }),
            CommitteeSubcommand::VoteSubmit {
                vault,
                stance,
                target_weight_bps,
                confidence,
                rationale_uri,
                vote_json_hash,
                prompt_hash,
                inputs_digest,
                schema_version,
                timestamp,
                order_id,
                deadline_secs,
                receipt_timeout_secs,
                gas_limit,
                fee_cap,
            } => {
                let stance = match commands::committee::Stance::from_str_ci(&stance) {
                    Some(s) => s,
                    None => {
                        eprintln!(
                            "rmpc committee vote-submit: --stance must be one of: overweight, neutral, underweight (got {stance:?})"
                        );
                        std::process::exit(3);
                    }
                };
                commands::committee::run_vote_submit(commands::committee::VoteSubmitArgs {
                    config_path: config,
                    vault,
                    stance,
                    target_weight_bps,
                    confidence,
                    rationale_uri,
                    vote_json_hash,
                    prompt_hash,
                    inputs_digest,
                    schema_version,
                    timestamp,
                    order_id,
                    deadline_secs,
                    receipt_timeout_secs,
                    gas_limit,
                    fee_cap_wei: fee_cap,
                    pretty,
                })
            }
        },
        Command::Receipt {
            config,
            subcommand,
            pretty,
        } => match subcommand {
            ReceiptSubcommand::Verify {
                receipt_url,
                receipt_file,
            } => {
                let source = match (receipt_url, receipt_file) {
                    (Some(u), None) => commands::receipt::ReceiptSource::Url(u),
                    (None, Some(f)) => commands::receipt::ReceiptSource::File(f),
                    _ => {
                        eprintln!(
                            "rmpc receipt verify: exactly one of --receipt-url or \
                             --receipt-file is required"
                        );
                        std::process::exit(3);
                    }
                };
                commands::receipt::run_verify(commands::receipt::VerifyArgs {
                    config_path: config,
                    source,
                    pretty,
                })
            }
            ReceiptSubcommand::Submit {
                receipt_url,
                receipt_file,
                expected_digest,
                receipt_timeout_secs,
                gas_limit,
                fee_cap,
            } => commands::receipt::run_submit(commands::receipt::SubmitArgs {
                config_path: config,
                receipt_url,
                receipt_file,
                expected_digest,
                receipt_timeout_secs,
                gas_limit,
                fee_cap_wei: fee_cap,
                pretty,
            }),
        },
        Command::Governance {
            config,
            subcommand,
            pretty,
        } => match subcommand {
            GovernanceSubcommand::DraftProposal {
                receipt_id,
                receipt_url,
                receipt_file,
                from_block,
                to_block,
                receipt_url_template,
            } => {
                let source = match (receipt_url, receipt_file) {
                    (Some(u), None) => Some(commands::governance_draft::ReceiptSource::Url(u)),
                    (None, Some(f)) => Some(commands::governance_draft::ReceiptSource::File(f)),
                    (None, None) => None,
                    (Some(_), Some(_)) => {
                        eprintln!(
                            "rmpc governance draft-proposal: at most one of --receipt-url or \
                             --receipt-file may be given"
                        );
                        std::process::exit(3);
                    }
                };
                commands::governance_draft::run(commands::governance_draft::Args {
                    config_path: config,
                    receipt_id,
                    source,
                    from_block,
                    to_block,
                    receipt_url_template,
                    pretty,
                })
            }
        },
        Command::CommitteeIdentity {
            path,
            subcommand,
            pretty,
        } => match subcommand {
            CommitteeIdentitySubcommand::Create => {
                commands::committee_identity::run_create(&path, pretty)
            }
            CommitteeIdentitySubcommand::ShowPublicKey => {
                commands::committee_identity::run_show_public_key(&path, pretty)
            }
            CommitteeIdentitySubcommand::Sign {
                payload,
                payload_file,
            } => {
                let source = match (payload, payload_file) {
                    (Some(p), None) => commands::committee_identity::PayloadSource::Inline(p),
                    (None, Some(f)) => commands::committee_identity::PayloadSource::File(f),
                    _ => {
                        eprintln!(
                            "rmpc committee-identity sign: exactly one of --payload or \
                             --payload-file is required"
                        );
                        std::process::exit(3);
                    }
                };
                commands::committee_identity::run_sign(&path, source, pretty)
            }
        },
    };
    std::process::exit(exit_code);
}

/// Load the config file (if any) just to extract its `[log]` block,
/// apply env overrides, and start the loggers. Failures here are
/// non-fatal — the subcommand will report config errors via its own
/// JSON output. We deliberately fall back to fully-default logging so
/// the audit trail is always populated.
fn init_logging_best_effort(config_path: Option<&Path>) {
    let log_cfg = config_path
        .and_then(|p| Config::from_path(p).ok())
        .map(|c| c.log)
        .unwrap_or_default()
        .with_env_overrides();

    if let Err(e) = logging::init(&log_cfg) {
        // Print to stderr only — pre-init we can't use the `log` macros.
        eprintln!("rmpc[WARN] logging init failed: {e}");
    }
}
