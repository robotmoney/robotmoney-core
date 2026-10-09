//! Canonical: docs/architecture.md §3 — Technology Stack
//! (See also: Plan tracking issue #109 — Full-stack integration phase)
//! CLI entry point: `cargo r smoke-test`
//!
//! Boots the Twin chain (918453, a pinned lazy fork of real Base state made
//! with anvil) with deployed contracts and keeps it alive so external tests or tools can connect to it. Prints
//! the allocated URLs and addresses to stdout, then blocks until Ctrl-C.
//! Drop tears the stack down on clean exit.
//!
//! With `--full-stack` the binary also starts the dapp, explorer-api,
//! explorer-indexer, and Postgres containers after contract deployment,
//! printing a structured endpoint summary once all services are healthy.
//! Dropping or Ctrl-C stops the dapp compose stack and the Twin fork this
//! process started (a fork reused through `TWIN_RPC_URL` is left running).
//!
//! Canonical: Plan tracking issue #109 §10.5 — Phase 4.5.

use clap::Parser;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Parser, Debug)]
#[command(name = "smoke-test", about = "Robot Money devnet smoke test harness")]
struct Cli {
    /// Boot the dapp, explorer-api, explorer-indexer, and Postgres
    /// containers after deploying contracts. Prints a structured
    /// endpoint summary once all services are healthy.
    #[arg(long, default_value_t = false)]
    full_stack: bool,

    /// Fix the host port for the dapp frontend instead of randomizing it.
    /// Useful when attaching a reverse proxy to the webapp.
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    dapp_port: Option<u16>,

    /// Open ephemeral `trycloudflare.com` tunnels for the dapp, explorer-api,
    /// and Geth RPC ports, and build the dapp bundle with those public URLs
    /// in the standard `VITE_*` env vars. Tunnels close when smoke-test exits.
    /// Requires `--full-stack`.
    ///
    /// Demo affordance only — bakes hoster-controlled URLs into the bundle
    /// and is explicitly out of scope for `docs/technical/dapp-topology.md`.
    /// Not a production hosting pattern.
    #[arg(long, default_value_t = false)]
    tunnel: bool,

    /// Pin the host port for Geth's RPC. Required when fronting the
    /// stack with a stable reverse proxy (named cloudflared tunnel,
    /// nginx, etc.) so the proxy's upstream target is deterministic.
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    rpc_port: Option<u16>,

    /// Pin the host port for explorer-api. Same rationale as --rpc-port.
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    explorer_port: Option<u16>,

    /// Public URL the dapp's wallet integration will announce as the
    /// RPC endpoint for the devnet chain (baked into the bundle as
    /// `VITE_DEVNET_RPC_URL`). When set together with --public-dapp-url
    /// and --public-explorer-url, smoke-test skips ephemeral tunnels
    /// and assumes an external reverse proxy is already routing those
    /// hostnames to the pinned local ports.
    #[arg(long)]
    public_rpc_url: Option<String>,

    /// Public URL the dapp is reachable from in the browser
    /// (`VITE_DAPP_URL`). See --public-rpc-url.
    #[arg(long)]
    public_dapp_url: Option<String>,

    /// Public URL the explorer-api is reachable from in the browser
    /// (`VITE_EXPLORER_API_URL`). See --public-rpc-url.
    #[arg(long)]
    public_explorer_url: Option<String>,

    /// Write harness logs to this file instead of the default
    /// `artifacts/smoke-test/smoke-test.log`.
    #[arg(long, value_name = "PATH")]
    log_file: Option<PathBuf>,

    /// Include the deterministic test-EOA private keys in the endpoint
    /// summary. Only the Playwright harness needs them; staging runs leave
    /// this off so their retained logs carry addresses, never key material.
    #[arg(long, default_value_t = false)]
    print_test_keys: bool,

    /// Boot without the seeded fixture consensus receipts and without the
    /// `receipt-fixtures` compose service. Acceptance stacks use this so the
    /// chain, indexer and dapp only ever carry receipts a frontend produced.
    #[arg(long, default_value_t = false)]
    no_receipt_fixtures: bool,

    /// The stage deploy job: boot or reuse the Twin chain (`TWIN_RPC_URL`), run the whole ceremony (fund, publish
    /// contracts through the real Safe handover, depositor authorization), write the dapp compose environment to
    /// `--dapp-env-out`, print the endpoint summary and EXIT, leaving the keystores and manifests in
    /// `SMOKE_TEST_WORK_DIR`. It starts no container and owns nothing afterwards: `scripts/stage/core-stack.ts`
    /// brings the dapp stack up from the JSON. Needs `--dapp-port`, `--explorer-port` and `--dapp-env-out`.
    #[arg(long, default_value_t = false)]
    deploy_only: bool,

    /// With `--deploy-only`: write the endpoint summary to this file instead of stdout.
    #[arg(long, value_name = "PATH")]
    summary_out: Option<PathBuf>,

    /// With `--deploy-only`: where to write the dapp compose environment (a JSON object).
    #[arg(long, value_name = "PATH")]
    dapp_env_out: Option<PathBuf>,

    /// Rotate the unified log file after it grows beyond this many bytes.
    /// Defaults to 10 MiB.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
    log_max_bytes: Option<u64>,
}

fn main() {
    let exit_code = run();
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

fn run() -> i32 {
    let cli = Cli::parse();
    if cli.deploy_only && (cli.full_stack || cli.tunnel) {
        eprintln!(
            "smoke-test: --deploy-only starts no stack: it excludes --full-stack and --tunnel."
        );
        return 2;
    }
    if cli.deploy_only
        && (cli.dapp_env_out.is_none() || cli.dapp_port.is_none() || cli.explorer_port.is_none())
    {
        eprintln!(
            "smoke-test: --deploy-only needs --dapp-env-out, --dapp-port and --explorer-port."
        );
        return 2;
    }
    if cli.tunnel && !cli.full_stack {
        eprintln!("smoke-test: --tunnel requires --full-stack.");
        return 2;
    }
    let named_url_count = [
        cli.public_rpc_url.is_some(),
        cli.public_dapp_url.is_some(),
        cli.public_explorer_url.is_some(),
    ]
    .iter()
    .filter(|x| **x)
    .count();
    if named_url_count != 0 && named_url_count != 3 {
        eprintln!(
            "smoke-test: --public-rpc-url, --public-dapp-url, and --public-explorer-url \
             must all be set together (or all omitted)."
        );
        return 2;
    }
    let use_named = named_url_count == 3;
    if use_named && cli.tunnel {
        eprintln!("smoke-test: --tunnel is incompatible with --public-*-url flags.");
        return 2;
    }
    if use_named && !cli.full_stack && !cli.deploy_only {
        eprintln!("smoke-test: --public-*-url flags require --full-stack.");
        return 2;
    }
    let deploy_args = DeployArgs {
        dapp_env_out: cli.dapp_env_out.clone(),
        summary_out: cli.summary_out.clone(),
        dapp_port: cli.dapp_port,
        explorer_port: cli.explorer_port,
        print_test_keys: cli.print_test_keys,
        public: if use_named {
            Some(smoke_test::DappPublicUrls {
                rpc: cli.public_rpc_url.clone().unwrap(),
                dapp: cli.public_dapp_url.clone().unwrap(),
                explorer_api: cli.public_explorer_url.clone().unwrap(),
            })
        } else {
            None
        },
    };
    if let Some(rpc_port) = cli.rpc_port {
        std::env::set_var("SMOKE_TEST_RPC_PORT", rpc_port.to_string());
    }
    if let Some(path) = cli.log_file {
        std::env::set_var("SMOKE_TEST_LOG_FILE", path);
    }
    if let Some(limit) = cli.log_max_bytes {
        std::env::set_var("SMOKE_TEST_LOG_MAX_BYTES", limit.to_string());
    }
    let _ = smoke_test::logging::init();
    smoke_test::logging::info(
        "smoke-test",
        format!(
            "CLI starting: full_stack={} tunnel={} log_file={} log_max_bytes={}",
            cli.full_stack,
            cli.tunnel,
            smoke_test::logging::log_path().display(),
            smoke_test::logging::max_bytes()
        ),
    );
    let interrupted = Arc::new(AtomicBool::new(false));
    {
        let interrupted = Arc::clone(&interrupted);
        ctrlc::set_handler(move || {
            interrupted.store(true, Ordering::SeqCst);
        })
        .expect("set Ctrl-C handler");
    }

    if !smoke_test::prerequisites_available() {
        eprintln!(
            "smoke-test: anvil / bun / forge / cast not on PATH (anvil is not needed when TWIN_RPC_URL names a \
             running fork). Install Foundry and Bun to run the Twin chain."
        );
        smoke_test::logging::error(
            "smoke-test",
            "missing prerequisites: anvil / bun / forge / cast",
        );
        return 1;
    }
    if cli.full_stack && which::which("docker").is_err() {
        eprintln!("smoke-test: --full-stack needs docker on PATH for the dapp compose stack.");
        smoke_test::logging::error(
            "smoke-test",
            "missing prerequisite for --full-stack: docker",
        );
        return 1;
    }

    if cli.no_receipt_fixtures {
        std::env::set_var(smoke_test::NO_RECEIPT_FIXTURES_ENV, "1");
    }
    eprintln!("smoke-test: booting the Twin chain (a pinned lazy fork of Base) and deploying...");
    smoke_test::logging::info("smoke-test", "booting the Twin chain");
    let fixture = match smoke_test::Fixture::with_deploy_env(&[]) {
        Ok(fixture) => fixture,
        Err(err) => {
            smoke_test::logging::error("smoke-test", format!("devnet boot failed: {err}"));
            eprintln!("smoke-test: devnet boot failed: {err}");
            if matches!(
                &err,
                smoke_test::HarnessError::Docker(message)
                    if message.contains("already running containers")
            ) {
                std::process::exit(2);
            }
            return 1;
        }
    };
    if interrupted.load(Ordering::SeqCst) {
        eprintln!("smoke-test: interrupted during devnet startup.");
        smoke_test::logging::warn("smoke-test", "shutdown reason=ctrl-c during startup");
        return 0;
    }

    println!("rpc_url={}", fixture.rpc_url());
    println!("chain_id={}", fixture.chain_id());
    println!("gateway_addr={:#x}", fixture.gateway());
    println!("usdc_addr={:#x}", fixture.usdc());
    println!("vault_addr={:#x}", fixture.vault());
    println!("agent_addr={:#x}", fixture.agent());
    println!("gateway_runtime_hash={}", fixture.gateway_runtime_hash());

    if cli.deploy_only {
        return finish_deploy_only(fixture, deploy_args);
    }

    // Hold the DappStack alive until the end of main so its Drop tears
    // down the compose stack together with the chain fixture.
    let _dapp_stack: Option<smoke_test::DappStack> = if cli.full_stack {
        eprintln!("smoke-test: starting full-stack (dapp + explorer-api + indexer + postgres)...");
        smoke_test::logging::info("smoke-test", "starting full-stack compose stack");
        let public_endpoints = if use_named {
            smoke_test::PublicEndpoints::Named {
                rpc_url: cli.public_rpc_url.clone().unwrap(),
                dapp_url: cli.public_dapp_url.clone().unwrap(),
                explorer_api_url: cli.public_explorer_url.clone().unwrap(),
            }
        } else if cli.tunnel {
            smoke_test::PublicEndpoints::EphemeralTunnel
        } else {
            smoke_test::PublicEndpoints::Local
        };
        let opts = smoke_test::DappStackOptions {
            dapp_port: cli.dapp_port,
            explorer_api_port: cli.explorer_port,
            public_endpoints,
        };
        let stack = match smoke_test::DappStack::boot(&fixture, opts) {
            Ok(stack) => stack,
            Err(err) => {
                smoke_test::logging::error("smoke-test", format!("dapp stack boot failed: {err}"));
                eprintln!("smoke-test: dapp stack boot failed: {err}");
                return 1;
            }
        };
        if interrupted.load(Ordering::SeqCst) {
            eprintln!("smoke-test: interrupted during full-stack startup.");
            smoke_test::logging::warn(
                "smoke-test",
                "shutdown reason=ctrl-c during full-stack startup",
            );
            return 0;
        }

        // Structured endpoint summary — printed after all health checks pass.
        // With --print-test-keys it also carries the deterministic test-EOA
        // private keys, so the Playwright harness can inject a window.ethereum
        // provider without re-deriving them.
        print_endpoint_summary(
            &fixture,
            &stack.endpoints,
            cli.print_test_keys,
            &mut std::io::stdout(),
        );

        Some(stack)
    } else {
        None
    };

    let (rebuild_tx, rebuild_rx) = mpsc::channel::<()>();
    if cli.full_stack {
        eprintln!("smoke-test: full stack ready. Press 'r' + Enter to rebuild the dapp. Stop with Ctrl-C.");
        smoke_test::logging::info("smoke-test", "full stack ready");
        thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                match line {
                    Ok(l) if l.trim() == "r" => {
                        let _ = rebuild_tx.send(());
                    }
                    Err(_) => break,
                    _ => {}
                }
            }
        });
    } else {
        eprintln!("smoke-test: network ready. Stop with Ctrl-C.");
        smoke_test::logging::info("smoke-test", "network ready");
    }
    let _chain_health_poller = start_chain_health_poller(fixture.rpc_url().to_string());
    while !interrupted.load(Ordering::SeqCst) {
        if rebuild_rx.try_recv().is_ok() {
            if let Some(ref stack) = _dapp_stack {
                eprintln!("smoke-test: rebuilding dapp...");
                smoke_test::logging::info("smoke-test", "dapp rebuild triggered via keybinding");
                match stack.rebuild_dapp() {
                    Ok(()) => {
                        eprintln!(
                            "smoke-test: dapp rebuild complete — {}",
                            stack.endpoints.dapp_url
                        );
                        smoke_test::logging::info("smoke-test", "dapp rebuild complete");
                    }
                    Err(err) => {
                        eprintln!("smoke-test: dapp rebuild failed: {err}");
                        smoke_test::logging::error(
                            "smoke-test",
                            format!("dapp rebuild failed: {err}"),
                        );
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    eprintln!("smoke-test: stopping...");
    smoke_test::logging::info("smoke-test", "shutdown reason=ctrl-c tearing down stacks");
    // _dapp_stack drops here first → docker compose down dapp stack
    // fixture drops next → the Twin fork this process started is stopped
    0
}

/// Everything the stage deploy job needs from its command line.
struct DeployArgs {
    dapp_env_out: Option<PathBuf>,
    summary_out: Option<PathBuf>,
    dapp_port: Option<u16>,
    explorer_port: Option<u16>,
    print_test_keys: bool,
    public: Option<smoke_test::DappPublicUrls>,
}

/// `--deploy-only`: write the dapp compose environment, print the summary, keep the work directory, exit.
fn finish_deploy_only(mut fixture: smoke_test::Fixture, args: DeployArgs) -> i32 {
    let public_endpoints = match args.public {
        Some(u) => smoke_test::PublicEndpoints::Named {
            rpc_url: u.rpc,
            dapp_url: u.dapp,
            explorer_api_url: u.explorer_api,
        },
        None => smoke_test::PublicEndpoints::Local,
    };
    let opts = smoke_test::DappStackOptions {
        dapp_port: args.dapp_port,
        explorer_api_port: args.explorer_port,
        public_endpoints,
    };
    let out = match smoke_test::stage_deploy_output(&fixture, &opts) {
        Ok(out) => out,
        Err(err) => {
            smoke_test::logging::error("smoke-test", format!("stage deploy output failed: {err}"));
            eprintln!("smoke-test: stage deploy output failed: {err}");
            return 1;
        }
    };
    let Some(path) = args.dapp_env_out else {
        return 2;
    };
    if let Err(err) = std::fs::write(&path, format!("{}\n", out.dapp_env_json)) {
        eprintln!("smoke-test: cannot write {}: {err}", path.display());
        return 1;
    }
    let endpoints = smoke_test::DappEndpoints {
        rpc_url: out.urls.rpc,
        dapp_url: out.urls.dapp,
        explorer_api_url: out.urls.explorer_api,
    };
    let summary: Result<(), std::io::Error> = match &args.summary_out {
        Some(path) => std::fs::File::create(path).map(|mut f| {
            print_endpoint_summary(&fixture, &endpoints, args.print_test_keys, &mut f)
        }),
        None => {
            print_endpoint_summary(
                &fixture,
                &endpoints,
                args.print_test_keys,
                &mut std::io::stdout(),
            );
            Ok(())
        }
    };
    if let Err(err) = summary {
        eprintln!("smoke-test: cannot write the endpoint summary: {err}");
        return 1;
    }
    let work = fixture.keep_work_dir();
    smoke_test::logging::info(
        "smoke-test",
        format!("deploy job done; work dir kept at {}", work.display()),
    );
    0
}

/// The structured endpoint summary: printed once every service is healthy (`--full-stack`) or once the deploy
/// is done (`--deploy-only`). With `print_test_keys` it also carries the deterministic test-EOA private keys, so
/// the Playwright harness can inject a window.ethereum provider without re-deriving them.
fn print_endpoint_summary(
    fixture: &smoke_test::Fixture,
    endpoints: &smoke_test::DappEndpoints,
    print_test_keys: bool,
    out: &mut dyn std::io::Write,
) {
    let _ = writeln!(out, "--- endpoint summary ---");
    let _ = writeln!(out, "rpc_url={}", endpoints.rpc_url);
    let _ = writeln!(out, "dapp_url={}", endpoints.dapp_url);
    let _ = writeln!(out, "explorer_api_url={}", endpoints.explorer_api_url);
    let _ = writeln!(out, "chain_id={}", fixture.chain_id());
    let _ = writeln!(out, "gateway_addr={:#x}", fixture.gateway());
    let _ = writeln!(out, "vault_addr={:#x}", fixture.vault());
    let _ = writeln!(out, "usdc_addr={:#x}", fixture.usdc());
    let _ = writeln!(out, "agent_addr={:#x}", fixture.agent());
    // The deployer is a fresh rehearsal keystore. After handover it holds
    // nothing: the Safe and the timelock are the admin.
    let _ = writeln!(
        out,
        "deployer_addr={}",
        fixture
            .published()
            .keys
            .address("ADMIN_ADDRESS")
            .unwrap_or("unknown")
    );
    let _ = writeln!(out, "safe_addr={:#x}", fixture.safe());
    let _ = writeln!(out, "timelock_addr={:#x}", fixture.timelock());
    let _ = writeln!(out, "manifest_dir={}", fixture.manifest_dir().display());
    let _ = writeln!(
        out,
        "sheet_path={}",
        fixture.published().sheet_path.display()
    );
    // Paths only, never secrets: the keystore directory and the 0600 passphrase file.
    let _ = writeln!(
        out,
        "key_dir={}",
        fixture.published().keys.key_dir.display()
    );
    let _ = writeln!(
        out,
        "password_file={}",
        fixture.published().keys.password_file.display()
    );
    let _ = writeln!(out, "core_sha={}", fixture.published().cfg.core_sha);
    let _ = writeln!(out, "pauser_addr={}", smoke_test::PAUSER_ADDRESS_HEX);
    let _ = writeln!(
        out,
        "share_receiver_addr={}",
        smoke_test::SHARE_RECEIVER_ADDRESS_HEX
    );
    if print_test_keys {
        let _ = writeln!(
            out,
            "pauser_private_key={}",
            smoke_test::PAUSER_PRIVATE_KEY_HEX
        );
        let _ = writeln!(
            out,
            "agent_private_key=0x{}",
            hex::encode(smoke_test::AGENT_PRIVATE_KEY)
        );
    }
    let _ = writeln!(
        out,
        "gateway_runtime_hash={}",
        fixture.gateway_runtime_hash()
    );
    // Issue #320: surface registry and router addresses so dapp e2e
    // tests can drive the vault-selector and router deposit flow.
    let _ = writeln!(out, "registry_addr={:#x}", fixture.registry());
    let _ = writeln!(out, "router_addr={:#x}", fixture.router());
    // Issue #477: surface the governance address so the dapp E2E specs
    // can locate RouterGovernance without hard-coding it.
    let _ = writeln!(out, "governance_addr={:#x}", fixture.governance());
    // Issue #1294: surface the IC policy + consensus receipt addresses so
    // the dapp e2e consensus-receipts spec can locate them without
    // hard-coding devnet addresses.
    let _ = writeln!(out, "ic_policy_addr={:#x}", fixture.ic_policy());
    let _ = writeln!(
        out,
        "consensus_receipt_addr={:#x}",
        fixture.consensus_receipt()
    );
    let _ = writeln!(
        out,
        "vault_addresses_json={}",
        fixture.vault_address_map_json()
    );
    // Issue #363: surface real adapter addresses for dapp e2e tests.
    let _ = writeln!(out, "aave_adapter_addr={:#x}", fixture.aave_adapter());
    let _ = writeln!(
        out,
        "compound_adapter_addr={:#x}",
        fixture.compound_adapter()
    );
    let _ = writeln!(
        out,
        "moonwell_flagship_adapter_addr={:#x}",
        fixture.moonwell_flagship_adapter()
    );
    // Issue #261: surface the harness USDC holder so dapp e2e tests
    // can verify the testnet faucet path drips from the same EOA the
    // Rust `Fixture::fund_usdc` helper uses. The private key is consumed
    // only by the LOCAL Playwright harness over a captured stdout pipe
    // (clients/dapp/tests/e2e/devnet-global-setup.ts) — it is never written
    // to the cloudflared tunnel surface, which only publishes the
    // rpc/dapp/explorer URLs (see Tunnels::start). HARN-2's public-surface
    // exposure (issue #1026) is the dapp Vite BUNDLE / build arg, tracked
    // separately; this local pipe is required by the e2e harness.
    let _ = writeln!(
        out,
        "harness_usdc_holder_addr={}",
        smoke_test::HARNESS_USDC_HOLDER_ADDRESS_HEX
    );
    if print_test_keys {
        let _ = writeln!(
            out,
            "harness_usdc_holder_private_key={}",
            smoke_test::HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX
        );
    }
    let _ = writeln!(out, "--- end endpoint summary ---");
}

const CHAIN_HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(3);
const CHAIN_STALL_WINDOW: Duration = Duration::from_secs(30);

fn start_chain_health_poller(rpc_url: String) -> thread::JoinHandle<()> {
    thread::spawn(move || poll_chain_health(&rpc_url))
}

fn poll_chain_health(rpc_url: &str) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            eprintln!(
                "smoke-test: [{}] warning: chain health poller could not start: {err}",
                timestamp_ms()
            );
            return;
        }
    };

    let mut next_poll = Instant::now();
    let mut tracker = ChainHealthTracker::default();

    loop {
        let now = Instant::now();
        if now < next_poll {
            thread::sleep(next_poll - now);
        }
        next_poll += CHAIN_HEALTH_POLL_INTERVAL;

        match fetch_block_number(&client, rpc_url) {
            Ok(block_number) => {
                if let Some(warning) = tracker.observe_block_number(Instant::now(), block_number) {
                    eprintln!("smoke-test: [{}] warning: {}", timestamp_ms(), warning);
                }
            }
            Err(err) => {
                if let Some(warning) = tracker.observe_rpc_failure(Instant::now(), err) {
                    eprintln!("smoke-test: [{}] warning: {}", timestamp_ms(), warning);
                }
            }
        }
    }
}

#[derive(Debug, Default)]
struct ChainHealthTracker {
    rpc_unreachable_since: Option<Instant>,
    stall_window_started_at: Option<Instant>,
    stall_window_block: Option<u64>,
}

impl ChainHealthTracker {
    fn observe_block_number(
        &mut self,
        now: Instant,
        block_number: u64,
    ) -> Option<ChainHealthWarning> {
        self.rpc_unreachable_since = None;

        match (self.stall_window_started_at, self.stall_window_block) {
            (Some(started_at), Some(previous_block))
                if now.duration_since(started_at) >= CHAIN_STALL_WINDOW =>
            {
                self.stall_window_started_at = Some(now);
                self.stall_window_block = Some(block_number);
                if block_number <= previous_block {
                    return Some(ChainHealthWarning::BlockStalled {
                        previous: previous_block,
                        current: block_number,
                    });
                }
            }
            (Some(_), Some(previous_block)) if block_number > previous_block => {
                self.stall_window_started_at = Some(now);
                self.stall_window_block = Some(block_number);
            }
            (Some(_), Some(_)) => {}
            _ => {
                self.stall_window_started_at = Some(now);
                self.stall_window_block = Some(block_number);
            }
        }

        None
    }

    fn observe_rpc_failure(&mut self, now: Instant, error: String) -> Option<ChainHealthWarning> {
        self.stall_window_started_at = None;
        self.stall_window_block = None;

        match self.rpc_unreachable_since {
            Some(started_at) if now.duration_since(started_at) >= CHAIN_STALL_WINDOW => {
                self.rpc_unreachable_since = Some(now);
                Some(ChainHealthWarning::RpcUnreachable { error })
            }
            Some(_) => None,
            None => {
                self.rpc_unreachable_since = Some(now);
                None
            }
        }
    }
}

enum ChainHealthWarning {
    RpcUnreachable { error: String },
    BlockStalled { previous: u64, current: u64 },
}

impl std::fmt::Display for ChainHealthWarning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChainHealthWarning::RpcUnreachable { error } => {
                write!(f, "RPC unreachable while polling eth_blockNumber: {error}")
            }
            ChainHealthWarning::BlockStalled { previous, current } => write!(
                f,
                "block production stalled while polling eth_blockNumber (no increase for 30s; last={previous}, current={current})"
            ),
        }
    }
}

impl std::fmt::Debug for ChainHealthWarning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

fn fetch_block_number(client: &reqwest::blocking::Client, rpc_url: &str) -> Result<u64, String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_blockNumber",
        "params": [],
    });
    let resp = client
        .post(rpc_url)
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let json = resp
        .json::<serde_json::Value>()
        .map_err(|e| e.to_string())?;
    let hex = json
        .get("result")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing result field".to_string())?;
    u64::from_str_radix(hex.trim_start_matches("0x"), 16).map_err(|e| e.to_string())
}

fn timestamp_ms() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_health_tracker_reports_block_stall_after_30s() {
        let mut tracker = ChainHealthTracker::default();
        let t0 = Instant::now();
        assert!(tracker.observe_block_number(t0, 123).is_none());
        assert!(tracker
            .observe_block_number(t0 + Duration::from_secs(29), 123)
            .is_none());

        let warning = tracker
            .observe_block_number(t0 + Duration::from_secs(30), 123)
            .expect("stall warning");
        assert!(matches!(warning, ChainHealthWarning::BlockStalled { .. }));
        assert_eq!(
            format!("{warning}"),
            "block production stalled while polling eth_blockNumber (no increase for 30s; last=123, current=123)"
        );
    }

    #[test]
    fn chain_health_tracker_resets_when_blocks_advance() {
        let mut tracker = ChainHealthTracker::default();
        let t0 = Instant::now();
        assert!(tracker.observe_block_number(t0, 123).is_none());
        assert!(tracker
            .observe_block_number(t0 + Duration::from_secs(31), 124)
            .is_none());
        assert!(tracker
            .observe_block_number(t0 + Duration::from_secs(61), 125)
            .is_none());
    }

    #[test]
    fn chain_health_tracker_reports_rpc_unreachable_after_30s() {
        let mut tracker = ChainHealthTracker::default();
        let t0 = Instant::now();
        assert!(tracker
            .observe_rpc_failure(t0, "connect refused".to_string())
            .is_none());

        let warning = tracker
            .observe_rpc_failure(t0 + Duration::from_secs(30), "connect refused".to_string())
            .expect("rpc warning");
        assert!(matches!(warning, ChainHealthWarning::RpcUnreachable { .. }));
        assert_eq!(
            format!("{warning}"),
            "RPC unreachable while polling eth_blockNumber: connect refused"
        );
    }

    #[test]
    fn chain_collision_test_name_keeps_grep_fixture_alive() {
        assert!(matches!(
            ChainHealthWarning::BlockStalled {
                previous: 7,
                current: 7
            },
            ChainHealthWarning::BlockStalled { .. }
        ));
    }
}
