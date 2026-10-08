//! Glue between the smoke harness and the one runbook, "publish contracts".
//!
//! The harness boots the Twin chain (918453), funds keys, and then calls the
//! publish-contracts CLI (Bun TypeScript, `publish-contracts/` in this repo) with the Twin chain
//! arguments. It deploys nothing itself: no `forge script`, no deployer
//! fixups, no demo seeding. Production contracts only; stage differs from
//! mainnet by sheet parameters.
//!
//! Plan: core issue 1499 (S9, core 1488).
//!
//! Secrets: this module never holds a private key. The deployer, Safe owners,
//! emergency and voters are encrypted Foundry keystores minted by the
//! rehearsal key helper (`publish-contracts/src/rehearsal`) in a fresh 0700 directory per run (a
//! redeploy gets a fresh keystore from the new SHA). The keystore passphrase is random, lives
//! in a 0600 file next to the keystores, and is never an argument or an
//! exported variable.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;

use crate::stage_table::StageTable;
use crate::HarnessError;

/// The Twin chain id. Stage and rehearsal run only here.
pub const TWIN_CHAIN_ID: u64 = 918453;

/// The GitHub Environment name the publish call receives for stage.
pub const STAGE_ENVIRONMENT: &str = "stage";

/// The in-repo `publish-contracts` directory (holds `src/cli.ts`), relative to the repo root.
/// There is one deploy driver and it lives in core: no environment variable points elsewhere.
pub const PUBLISH_DIR_REL: &str = "publish-contracts";
/// The Twin chain stage sheet committed in this repo (parameter lines only), relative to the repo root.
pub const STAGE_SHEET_REL: &str = "deployments/twin-918453/stage-sheet.env";
/// Env var: an alternative stage sheet (parameter lines only). Selected by input, never edited between runs.
pub const STAGE_SHEET_ENV: &str = "STAGE_SHEET";
/// Env var: where the driver writes its manifests (one JSON per stage in stage-table.json).
pub const MANIFEST_DIR_ENV: &str = "PUBLISH_MANIFEST_DIR";
/// File name of the deployer keystore inside the key directory (the rehearsal key helper names it).
pub const DEPLOYER_KEY_NAME: &str = "DEPLOYER";

/// Sheet keys the harness may add to the stage sheet from its caller (for
/// example a quorum or voting period). Anything else
/// is refused, so a test can only change a parameter, never the scheme.
pub const OVERRIDABLE_SHEET_KEYS: &[&str] = &[
    "TVL_CAP",
    "PER_DEPOSIT_CAP",
    "QUORUM_THRESHOLD",
    "VOTING_PERIOD",
    "EXECUTION_DELAY",
    "TIMELOCK_MIN_DELAY",
];

#[derive(Debug, Clone)]
pub struct PublishConfig {
    /// The in-repo `publish-contracts` directory.
    pub publish_dir: PathBuf,
    /// Stage sheet, parameter lines only.
    pub stage_sheet: PathBuf,
    /// Core commit the contracts are built from.
    pub core_sha: String,
}

impl PublishConfig {
    pub fn from_env(repo_root: &Path) -> Result<Self, HarnessError> {
        let publish_dir = repo_root.join(PUBLISH_DIR_REL);
        if !publish_dir.join("src/cli.ts").is_file() {
            return Err(HarnessError::other(format!(
                "{}/src/cli.ts not found: run from a core checkout that holds {PUBLISH_DIR_REL}/",
                publish_dir.display()
            )));
        }
        let stage_sheet = match std::env::var(STAGE_SHEET_ENV) {
            Ok(v) if !v.is_empty() => PathBuf::from(v),
            _ => repo_root.join(STAGE_SHEET_REL),
        };
        let core_sha = git_head(repo_root)?;
        Ok(Self {
            publish_dir,
            stage_sheet,
            core_sha,
        })
    }

    fn cli(&self) -> PathBuf {
        self.publish_dir.join("src/cli.ts")
    }

    pub(crate) fn rehearsal_cli(&self) -> PathBuf {
        self.publish_dir.join("src/rehearsal/cli.ts")
    }
}

fn git_head(repo_root: &Path) -> Result<String, HarnessError> {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_root)
        .output()?;
    if !out.status.success() {
        return Err(HarnessError::other("git rev-parse HEAD failed"));
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(HarnessError::other(format!(
            "HEAD is not a 40-hex sha: {sha}"
        )));
    }
    Ok(sha)
}

/// Encrypted keystores and the sheet fragment of addresses the key helper printed.
#[derive(Debug, Clone)]
pub struct RehearsalKeys {
    /// 0700 directory that holds `keys/` and the passphrase file.
    pub root: PathBuf,
    pub key_dir: PathBuf,
    pub password_file: PathBuf,
    /// `ADMIN_ADDRESS`, `EMERGENCY_ADDRESS`, `VOTER_ADDRESSES`, `SAFE_OWNERS`, ...
    pub fragment: BTreeMap<String, String>,
}

impl RehearsalKeys {
    pub fn address(&self, key: &str) -> Result<&str, HarnessError> {
        self.fragment
            .get(key)
            .map(|s| s.as_str())
            .ok_or_else(|| HarnessError::other(format!("the key helper printed no {key}")))
    }

    pub fn address_list(&self, key: &str) -> Vec<String> {
        self.fragment
            .get(key)
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Parse the `NAME=value` / `export NAME=value` lines the key helper prints.
pub fn parse_sheet_fragment(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            let v = v.trim().trim_matches('"').trim_matches('\'');
            if !k.is_empty()
                && k.bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            {
                out.insert(k.to_string(), v.to_string());
            }
        }
    }
    out
}

/// A random 48-hex-character passphrase from the OS, written to a 0600 file.
fn write_random_password(path: &Path) -> Result<(), HarnessError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut raw = [0u8; 24];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut raw)?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(hex::encode(raw).as_bytes())?;
    Ok(())
}

/// A directory name no earlier boot used: pid, a process-wide counter and the clock.
/// Two boots in one process (a redeploy from a new SHA) never share a keystore directory.
pub fn fresh_root_name() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static BOOTS: AtomicU64 = AtomicU64::new(0);
    let n = BOOTS.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("rehearsal-{}-{n}-{nanos}", std::process::id())
}

/// Mint a fresh set of rehearsal keystores under `parent` (a memory-backed
/// directory when one exists). One call per boot, so every redeploy has a fresh keystore.
pub fn make_keys(cfg: &PublishConfig, parent: &Path) -> Result<RehearsalKeys, HarnessError> {
    use std::os::unix::fs::DirBuilderExt;
    let root = parent.join(fresh_root_name());
    std::fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(&root)?;
    let key_dir = root.join("keys");
    let password_file = root.join("passphrase");
    write_random_password(&password_file)?;
    let out = Command::new("bun")
        .arg(cfg.rehearsal_cli())
        .args(["keys", "--dir"])
        .arg(&key_dir)
        .arg("--password-file")
        .arg(&password_file)
        .args(["--chain-id", &TWIN_CHAIN_ID.to_string()])
        .stdin(Stdio::null())
        .output()?;
    if !out.status.success() {
        return Err(HarnessError::other(format!(
            "rehearsal key helper failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let fragment = parse_sheet_fragment(&String::from_utf8_lossy(&out.stdout));
    for needed in [
        "ADMIN_ADDRESS",
        "SAFE_OWNERS",
        "SAFE_THRESHOLD",
        "EMERGENCY_ADDRESS",
    ] {
        if !fragment.contains_key(needed) {
            return Err(HarnessError::other(format!(
                "the key helper's sheet fragment has no {needed}"
            )));
        }
    }
    Ok(RehearsalKeys {
        root,
        key_dir,
        password_file,
        fragment,
    })
}

/// Build the sheet for this run: the stage sheet's parameter lines, then the
/// identity lines (addresses only). Identity keys already present in the stage
/// sheet are replaced, so the file never carries one key twice. Returns the text.
pub fn render_sheet(
    stage_sheet_text: &str,
    identity: &BTreeMap<String, String>,
    param_overrides: &[(&str, &str)],
) -> Result<String, HarnessError> {
    for (k, _) in param_overrides {
        if !OVERRIDABLE_SHEET_KEYS.contains(k) {
            return Err(HarnessError::other(format!(
                "sheet key {k} is not an overridable parameter (allowed: {})",
                OVERRIDABLE_SHEET_KEYS.join(", ")
            )));
        }
    }
    let mut replaced: Vec<&str> = identity.keys().map(|k| k.as_str()).collect();
    replaced.extend(param_overrides.iter().map(|(k, _)| *k));
    let mut out = String::new();
    for line in stage_sheet_text.lines() {
        let t = line.trim_start();
        let body = t.strip_prefix("export ").unwrap_or(t);
        let key = body.split('=').next().unwrap_or("").trim();
        if replaced.contains(&key) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("# --- identity lines (addresses only), generated per run ---\n");
    for (k, v) in identity {
        out.push_str(&format!("export {k}={v}\n"));
    }
    if !param_overrides.is_empty() {
        out.push_str("# --- parameter overrides from the caller ---\n");
        for (k, v) in param_overrides {
            out.push_str(&format!("export {k}={v}\n"));
        }
    }
    Ok(out)
}

/// The signer string publish contracts accepts for the deployer keystore:
/// `keystore:PATH:PASSFILE`. Paths only, never a key or a passphrase.
pub fn signer_spec(keys: &RehearsalKeys) -> String {
    format!(
        "keystore:{}:{}",
        keys.key_dir.join(DEPLOYER_KEY_NAME).display(),
        keys.password_file.display()
    )
}

/// The argument list publish contracts takes on the Twin chain.
pub fn publish_args(
    verb: &str,
    rpc: &str,
    sheet: &Path,
    signer: &str,
    core_sha: &str,
) -> Vec<String> {
    vec![
        verb.to_string(),
        "--chain".into(),
        TWIN_CHAIN_ID.to_string(),
        "--rpc".into(),
        rpc.to_string(),
        "--sheet".into(),
        sheet.display().to_string(),
        "--signer".into(),
        signer.to_string(),
        "--environment".into(),
        STAGE_ENVIRONMENT.into(),
        "--core-sha".into(),
        core_sha.to_string(),
    ]
}

/// One deployment: the generated sheet, the keystores and the manifest directory.
#[derive(Debug, Clone)]
pub struct Published {
    pub sheet_path: PathBuf,
    pub manifest_dir: PathBuf,
    pub keys: RehearsalKeys,
    pub cfg: PublishConfig,
    pub rpc_url: String,
}

/// What one CLI run printed and how it ended. Used where a non-zero exit is the thing under test.
#[derive(Debug, Clone)]
pub struct CliRun {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Spawn the CLI and return its raw outcome. Only a failure to start the process is an error here.
fn run_cli_raw(
    cfg: &PublishConfig,
    p: &Published,
    verb: &str,
    extra: &[String],
) -> Result<CliRun, HarnessError> {
    let signer = signer_spec(&p.keys);
    let mut args = publish_args(verb, &p.rpc_url, &p.sheet_path, &signer, &cfg.core_sha);
    if verb.is_empty() {
        // no verb: the caller names a `--stage` (the CLI refuses a verb and a stage together)
        args.remove(0);
    }
    args.extend(run_dir_args(&p.manifest_dir));
    args.extend(extra.iter().cloned());
    let mut cmd = Command::new("bun");
    cmd.arg(cfg.cli())
        .args(&args)
        .env(MANIFEST_DIR_ENV, &p.manifest_dir)
        .stdin(Stdio::null());
    apply_publish_env(&mut cmd, TWIN_CHAIN_ID);
    let out = cmd.output()?;
    Ok(CliRun {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

fn run_cli(
    cfg: &PublishConfig,
    p: &Published,
    verb: &str,
    extra: &[String],
) -> Result<String, HarnessError> {
    let r = run_cli_raw(cfg, p, verb, extra)?;
    if r.code != 0 {
        return Err(HarnessError::DeployFailed(format!(
            "publish contracts `{verb}` exited {:?}: {}{}",
            r.code,
            r.stdout
                .lines()
                .rev()
                .take(20)
                .collect::<Vec<_>>()
                .join("\n"),
            r.stderr
        )));
    }
    Ok(r.stdout)
}

/// Where the CLI keeps the run's own state: its evidence (run manifest, reports) and the measured frozen counts. Both
/// sit next to the manifests, in this run's work directory. The default would put them in the checkout, where the next
/// boot on the same SHA would find the old run and the clean-tree check would see untracked files.
pub fn run_dir_args(manifest_dir: &Path) -> Vec<String> {
    let work = manifest_dir.parent().unwrap_or(manifest_dir);
    vec![
        "--evidence".into(),
        work.join("evidence").display().to_string(),
        "--counts-dir".into(),
        work.join("counts").display().to_string(),
    ]
}

/// The sheet text with the value of one key replaced by `value` (the whole line, comment included). Errors when the key is not in the sheet,
/// so a renamed key cannot turn a forced failure into a quiet pass.
pub fn with_sheet_value(text: &str, key: &str, value: &str) -> Result<String, HarnessError> {
    let mut found = false;
    let mut out = String::new();
    for line in text.lines() {
        let t = line.trim_start();
        let body = t.strip_prefix("export ").unwrap_or(t);
        if body.split('=').next().map(str::trim) == Some(key) && body.contains('=') {
            found = true;
            out.push_str(&format!("export {key}={value}\n"));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !found {
        return Err(HarnessError::other(format!("sheet key {key} not found")));
    }
    Ok(out)
}

/// The publish-contracts CLI refuses an unattended publish without `YES=1` (exit 17) and refuses `YES=1` on
/// chain 8453. So `YES=1` and no `CONFIRM` go to the Twin chain (918453) only. Any other chain gets
/// no `YES`, inherited values included.
pub fn apply_publish_env(cmd: &mut Command, chain_id: u64) {
    if chain_id == TWIN_CHAIN_ID {
        cmd.env("YES", "1").env_remove("CONFIRM");
    } else {
        cmd.env_remove("YES");
    }
}

impl Published {
    /// Write the sheet, then run `publish` (deploy all four vaults, hand over
    /// to the real Safe, verify). Fails on a non-zero exit or when the
    /// manifest set is short.
    pub fn deploy(
        cfg: &PublishConfig,
        rpc_url: &str,
        keys: RehearsalKeys,
        identity: &BTreeMap<String, String>,
        param_overrides: &[(&str, &str)],
        work_dir: &Path,
    ) -> Result<Self, HarnessError> {
        let stage_text = std::fs::read_to_string(&cfg.stage_sheet).map_err(|e| {
            HarnessError::other(format!("stage sheet {}: {e}", cfg.stage_sheet.display()))
        })?;
        let sheet = render_sheet(&stage_text, identity, param_overrides)?;
        let sheet_path = work_dir.join("run-sheet.env");
        std::fs::write(&sheet_path, sheet)?;
        let manifest_dir = work_dir.join("manifests");
        std::fs::create_dir_all(&manifest_dir)?;
        let p = Published {
            sheet_path,
            manifest_dir,
            keys,
            cfg: cfg.clone(),
            rpc_url: rpc_url.to_string(),
        };
        run_cli(cfg, &p, "publish", &[])?;
        let table = StageTable::load_default()?;
        let n = table.count_present(&p.manifest_dir);
        let want = table.expected_manifest_count();
        if n != want {
            return Err(HarnessError::DeployFailed(format!(
                "publish contracts wrote {n} of {want} stage manifests in {} (missing: {})",
                p.manifest_dir.display(),
                table.missing(&p.manifest_dir).join(", ")
            )));
        }
        Ok(p)
    }

    /// Run one governance row through the real Safe and the timelock.
    /// Returns the parsed rows; every row must carry a tx hash and receipt status 1.
    pub fn govern(&self, row: &str, args: &[&str]) -> Result<Vec<GovernRow>, HarnessError> {
        let mut extra = vec!["--row".to_string(), row.to_string()];
        extra.extend(args.iter().map(|s| s.to_string()));
        let out = run_cli(&self.cfg, self, "govern", &extra)?;
        let rows = parse_govern_output(&out)?;
        check_govern_rows(&rows)?;
        Ok(rows)
    }

    /// Run one generic Safe -> Timelock call (schedule, real delay by warp, execute) through the real Safe.
    /// A Twin-only test verb of the CLI (refused on 8453) for actions that are not mainnet govern rows.
    /// `label` names the call in the run manifest. Returns the first tx hash.
    pub fn govern_call(
        &self,
        label: &str,
        target: &str,
        calldata: &str,
    ) -> Result<Vec<GovernRow>, HarnessError> {
        let extra: Vec<String> = [
            "--call-label",
            label,
            "--call-target",
            target,
            "--call-data",
            calldata,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let out = run_cli(&self.cfg, self, "govern", &extra)?;
        let rows = parse_govern_output(&out)?;
        check_govern_rows(&rows)?;
        Ok(rows)
    }

    /// Schedule one Safe -> Timelock operation through the publish-contracts Safe tool and leave it PENDING
    /// (no delay warp, no execute): `propose`, then two owner `sign`s (the 2-of-3 quorum), then `execute` of
    /// the Safe transaction by the deployer as gas payer. The real Safe proxy holds PROPOSER_ROLE, so the
    /// timelock only accepts this when the real quorum signed. Returns nothing: read the operation from
    /// the timelock (`hashOperation`, `isOperationPending`).
    pub fn schedule_pending_op(
        &self,
        safe: &str,
        timelock: &str,
        target: &str,
        data: &str,
        salt: &str,
    ) -> Result<(), HarnessError> {
        let cli = self.cfg.publish_dir.join("src/safe/cli.ts");
        let work = tempfile::tempdir()?;
        let bundle = work.path().join("bundle.json");
        let owner = |name: &str| {
            format!(
                "keystore:{}:{}",
                self.keys.key_dir.join(name).display(),
                self.keys.password_file.display()
            )
        };
        let chain = TWIN_CHAIN_ID.to_string();
        let bundle_s = bundle.display().to_string();
        let run = |sub: &str, flags: &[&str]| -> Result<String, HarnessError> {
            let mut cmd = Command::new("bun");
            cmd.arg(&cli)
                .arg(sub)
                .args(["--rpc", &self.rpc_url, "--chain-id", &chain])
                .args(flags)
                .current_dir(
                    self.cfg
                        .publish_dir
                        .parent()
                        .unwrap_or(&self.cfg.publish_dir),
                )
                .stdin(Stdio::null());
            apply_publish_env(&mut cmd, TWIN_CHAIN_ID);
            let out = cmd.output()?;
            if !out.status.success() {
                return Err(HarnessError::DeployFailed(format!(
                    "safe tool `{sub}` exited {:?}: {}{}",
                    out.status.code(),
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                )));
            }
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        };
        run(
            "propose",
            &[
                "--safe",
                safe,
                "--timelock",
                timelock,
                "--action",
                "schedule",
                "--target",
                target,
                "--data",
                data,
                "--salt",
                salt,
                "--out",
                &bundle_s,
            ],
        )?;
        for name in ["SAFE_OWNER_A", "SAFE_OWNER_B"] {
            run("sign", &["--bundle", &bundle_s, "--signer", &owner(name)])?;
        }
        run(
            "execute",
            &["--bundle", &bundle_s, "--signer", &signer_spec(&self.keys)],
        )?;
        Ok(())
    }

    /// Run the one verifier. Exits non-zero (an Err here) unless every label passes.
    /// Returns the verifier's output so a caller can diff its labels against mainnet's.
    pub fn verify(&self) -> Result<String, HarnessError> {
        run_cli(&self.cfg, self, "verify", &[])
    }

    /// Core 1619: run the one verifier against a sheet that disagrees with the chain, so stage 12 fails for real. The CLI then pauses deposits
    /// on all four vaults by itself. Returns the raw outcome: the exit code is the thing under test (13, the verifier's own).
    pub fn verify_against_sheet(&self, sheet_path: &Path) -> Result<CliRun, HarnessError> {
        let p = Published {
            sheet_path: sheet_path.to_path_buf(),
            ..self.clone()
        };
        run_cli_raw(&self.cfg, &p, "verify", &[])
    }

    /// Issue 1670: one `--stage` run (no verb) with extra arguments, returning the raw outcome. The exit code is the thing under test.
    pub fn stage_raw(&self, extra: &[&str]) -> Result<CliRun, HarnessError> {
        let extra: Vec<String> = extra.iter().map(|s| s.to_string()).collect();
        run_cli_raw(&self.cfg, self, "", &extra)
    }

    /// Core 1619: `pause-all` by hand. Fails on a non-zero exit (a vault not confirmed paused is exit 25).
    pub fn pause_all(&self) -> Result<String, HarnessError> {
        run_cli(&self.cfg, self, "pause-all", &[])
    }

    /// The directory the CLI keeps its evidence in for this run (run manifest, rollout report).
    pub fn evidence_dir(&self) -> PathBuf {
        self.manifest_dir
            .parent()
            .unwrap_or(&self.manifest_dir)
            .join("evidence")
    }

    /// The whole stage-13 govern matrix, the same on stage and mainnet.
    pub fn govern_matrix(&self) -> Result<Vec<GovernRow>, HarnessError> {
        let out = run_cli(&self.cfg, self, "govern", &[])?;
        let rows = parse_govern_output(&out)?;
        check_govern_rows(&rows)?;
        Ok(rows)
    }
}

// -- govern output ----------------------------------------------------

/// One line of the govern run: `{"row":"...","phase":"scheduled","txHash":"0x..","status":1,"readyAt":1700000000}`. Extra fields are ignored here.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct GovernRow {
    pub row: String,
    #[serde(rename = "txHash", default)]
    pub tx_hash: String,
    #[serde(default)]
    pub status: u64,
}

pub fn parse_govern_output(stdout: &str) -> Result<Vec<GovernRow>, HarnessError> {
    let mut rows = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(r) = serde_json::from_str::<GovernRow>(line) {
            rows.push(r);
        }
    }
    if rows.is_empty() {
        return Err(HarnessError::other("the govern run printed no row lines"));
    }
    Ok(rows)
}

/// Every row must carry a 32-byte tx hash and receipt status 1.
pub fn check_govern_rows(rows: &[GovernRow]) -> Result<(), HarnessError> {
    for r in rows {
        let h = r.tx_hash.strip_prefix("0x").unwrap_or("");
        if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(HarnessError::other(format!(
                "govern row {} has no tx hash ('{}')",
                r.row, r.tx_hash
            )));
        }
        if r.status != 1 {
            return Err(HarnessError::other(format!(
                "govern row {} receipt status is {}, want 1",
                r.row, r.status
            )));
        }
    }
    Ok(())
}

// -- manifests --------------------------------------------------------

/// The deployed topology, read from the driver's manifests. The manifests are
/// the only source of addresses: nothing here is hard-coded or guessed.
#[derive(Debug, Clone)]
pub struct Topology {
    pub gateway: String,
    pub usdc: String,
    pub vault: String,
    pub aave_adapter: String,
    pub compound_adapter: String,
    pub moonwell_flagship_adapter: String,
    pub registry: String,
    pub router: String,
    pub governance: String,
    pub ic_policy: String,
    pub consensus_receipt: String,
    pub timelock: String,
    pub safe: String,
    /// rmUSDC, rmPROTO, rmAGENT, rmRWA.
    pub vaults: BTreeMap<String, String>,
}

fn read_file(dir: &Path, file: &str) -> Result<serde_json::Value, HarnessError> {
    let p = dir.join(file);
    let text = std::fs::read_to_string(&p)
        .map_err(|e| HarnessError::DeploymentJson(p.clone(), e.to_string()))?;
    serde_json::from_str(&text).map_err(|e| HarnessError::DeploymentJson(p, e.to_string()))
}

fn field(v: &serde_json::Value, file: &str, key: &str) -> Result<String, HarnessError> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| HarnessError::other(format!("manifest {file} has no string field {key}")))
}

fn opt_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// USDC is a constant on every chain (plan principle 12).
pub const BASE_USDC: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

pub fn load_topology(dir: &Path) -> Result<Topology, HarnessError> {
    load_topology_with(dir, &StageTable::load_default()?)
}

/// Manifest names come from the stage table. The USDC vault manifest holds the vault, the adapters
/// and the asset; the gateway manifest holds the gateway; the timelock manifest holds the Safe.
pub fn load_topology_with(dir: &Path, table: &StageTable) -> Result<Topology, HarnessError> {
    let stem = |stage: &str| -> Result<(String, serde_json::Value), HarnessError> {
        let file = table.manifest_of(stage)?;
        let v = read_file(dir, &file)?;
        Ok((file, v))
    };
    let (vault_f, vault_j) = stem("vault")?;
    let (gw_f, gw_j) = stem("gateway")?;
    let (reg_f, registry) = stem("registry")?;
    let (rtr_f, router) = stem("router")?;
    let (gov_f, governance) = stem("governance")?;
    let (ic_f, ic) = stem("ic-policy")?;
    let (tl_f, timelock) = stem("timelock")?;
    let mut vaults = BTreeMap::new();
    for (label, file) in table.vault_manifests() {
        let j = read_file(dir, &file)?;
        vaults.insert(label, field(&j, &file, "vault")?);
    }
    for k in ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"] {
        if !vaults.contains_key(k) {
            return Err(HarnessError::other(format!("no manifest for vault {k}")));
        }
    }
    let usdc = {
        let u = opt_field(&vault_j, "usdc");
        if u.is_empty() {
            BASE_USDC.to_string()
        } else {
            u
        }
    };
    Ok(Topology {
        gateway: field(&gw_j, &gw_f, "gateway")?,
        usdc,
        vault: field(&vault_j, &vault_f, "vault")?,
        aave_adapter: opt_field(&vault_j, "aave_adapter"),
        compound_adapter: opt_field(&vault_j, "compound_adapter"),
        moonwell_flagship_adapter: opt_field(&vault_j, "moonwell_flagship_adapter"),
        registry: field(&registry, &reg_f, "registry")?,
        router: field(&router, &rtr_f, "router")?,
        governance: field(&governance, &gov_f, "governance")?,
        ic_policy: field(&ic, &ic_f, "policy")?,
        consensus_receipt: field(&ic, &ic_f, "consensus_receipt")?,
        timelock: field(&timelock, &tl_f, "timelock")?,
        safe: field(&timelock, &tl_f, "safe")?,
        vaults,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_boot_gets_its_own_keystore_directory() {
        let names: std::collections::BTreeSet<String> =
            (0..50).map(|_| fresh_root_name()).collect();
        assert_eq!(
            names.len(),
            50,
            "a redeploy must never reuse a keystore directory"
        );
    }

    #[test]
    fn signer_spec_is_keystore_path_and_passphrase_file() {
        let keys = RehearsalKeys {
            root: PathBuf::from("/r"),
            key_dir: PathBuf::from("/r/keys"),
            password_file: PathBuf::from("/r/passphrase"),
            fragment: BTreeMap::new(),
        };
        assert_eq!(
            signer_spec(&keys),
            "keystore:/r/keys/DEPLOYER:/r/passphrase"
        );
    }

    /// `verify` is the one verifier on every target: the argument list differs only in the verb.
    #[test]
    fn verify_args_equal_publish_args_but_the_verb() {
        let a = publish_args(
            "publish",
            "http://r",
            Path::new("/s"),
            "keystore:/k/DEPLOYER:/k/pw",
            "abc",
        );
        let b = publish_args(
            "verify",
            "http://r",
            Path::new("/s"),
            "keystore:/k/DEPLOYER:/k/pw",
            "abc",
        );
        assert_eq!(a[1..], b[1..]);
        assert_eq!(b[0], "verify");
    }

    #[test]
    fn fragment_parser_reads_export_and_plain_lines() {
        let f = parse_sheet_fragment(
            "# sheet fragment\nexport ADMIN_ADDRESS=0xabc\nSAFE_THRESHOLD=2\nnot a line\n",
        );
        assert_eq!(f.get("ADMIN_ADDRESS").map(String::as_str), Some("0xabc"));
        assert_eq!(f.get("SAFE_THRESHOLD").map(String::as_str), Some("2"));
        assert_eq!(f.len(), 2);
    }

    #[test]
    fn sheet_replaces_identity_keys_and_refuses_unknown_overrides() {
        let mut id = BTreeMap::new();
        id.insert("ADMIN_ADDRESS".to_string(), "0xnew".to_string());
        let s = render_sheet(
            "export ADMIN_ADDRESS=0xold\nexport TIMELOCK_MIN_DELAY=60\n",
            &id,
            &[("QUORUM_THRESHOLD", "5")],
        )
        .unwrap();
        assert!(!s.contains("0xold"));
        assert!(s.contains("export ADMIN_ADDRESS=0xnew"));
        assert!(s.contains("export TIMELOCK_MIN_DELAY=60"));
        assert!(s.contains("export QUORUM_THRESHOLD=5"));
        assert!(render_sheet("", &id, &[("REHEARSAL", "1")]).is_err());
    }

    #[test]
    fn run_state_lives_in_the_work_dir_not_the_checkout() {
        let a = run_dir_args(Path::new("/w/manifests"));
        assert_eq!(
            a,
            vec!["--evidence", "/w/evidence", "--counts-dir", "/w/counts"]
        );
    }

    #[test]
    fn publish_args_are_the_twin_chain_set() {
        let a = publish_args(
            "publish",
            "http://127.0.0.1:18545",
            Path::new("/s.env"),
            "keystore:/k/DEPLOYER:/k/pw",
            "abc",
        );
        assert_eq!(
            a,
            vec![
                "publish",
                "--chain",
                "918453",
                "--rpc",
                "http://127.0.0.1:18545",
                "--sheet",
                "/s.env",
                "--signer",
                "keystore:/k/DEPLOYER:/k/pw",
                "--environment",
                "stage",
                "--core-sha",
                "abc"
            ]
        );
    }

    #[test]
    fn govern_rows_need_tx_hash_and_status_one() {
        let ok = format!(
            "{{\"row\":\"set-quorum\",\"txHash\":\"0x{}\",\"status\":1}}\nnoise\n",
            "ab".repeat(32)
        );
        let rows = parse_govern_output(&ok).unwrap();
        assert!(check_govern_rows(&rows).is_ok());
        let bad_status = ok.replace("\"status\":1", "\"status\":0");
        assert!(check_govern_rows(&parse_govern_output(&bad_status).unwrap()).is_err());
        let no_hash = "{\"row\":\"x\",\"status\":1}";
        assert!(check_govern_rows(&parse_govern_output(no_hash).unwrap()).is_err());
        assert!(parse_govern_output("nothing here").is_err());
    }

    fn env_of(cmd: &Command, k: &str) -> Option<Option<String>> {
        cmd.get_envs()
            .find(|(n, _)| *n == k)
            .map(|(_, v)| v.map(|s| s.to_string_lossy().to_string()))
    }

    #[test]
    fn twin_chain_gets_yes_and_no_confirm() {
        let mut c = Command::new("true");
        apply_publish_env(&mut c, 918453);
        assert_eq!(env_of(&c, "YES"), Some(Some("1".to_string())));
        assert_eq!(env_of(&c, "CONFIRM"), Some(None), "CONFIRM must be removed");
    }

    #[test]
    fn chain_8453_never_gets_yes() {
        for chain in [8453u64, 1] {
            let mut c = Command::new("true");
            apply_publish_env(&mut c, chain);
            assert_eq!(
                env_of(&c, "YES"),
                Some(None),
                "YES must be removed on {chain}"
            );
        }
    }

    #[test]
    fn with_sheet_value_replaces_one_key_and_refuses_a_missing_one() {
        let text = "A=1\nexport VAULT_RWA_TVL_CAP=1000000000   # cap\nB=2\n";
        let out = with_sheet_value(text, "VAULT_RWA_TVL_CAP", "7").unwrap();
        assert_eq!(out, "A=1\nexport VAULT_RWA_TVL_CAP=7\nB=2\n");
        assert!(with_sheet_value(text, "VAULT_RWA_TVL", "7").is_err());
    }

    #[test]
    fn topology_reads_the_manifest_names_the_table_gives() {
        let real = std::fs::read_to_string(crate::stage_table::default_table_path()).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let a = |c: char| format!("0x{}", c.to_string().repeat(40));
        let table = StageTable::parse(&real).unwrap();
        let write = |t: &StageTable, rename: bool| {
            let dir = tmp.path().join(if rename { "r" } else { "n" });
            std::fs::create_dir_all(&dir).unwrap();
            let n = |f: String| {
                if rename && f == "router.json" {
                    "router-x.json".to_string()
                } else {
                    f
                }
            };
            let w = |stage: &str, body: String| {
                std::fs::write(dir.join(n(t.manifest_of(stage).unwrap())), body).unwrap();
            };
            w("vault", format!("{{\"vault\":\"{}\"}}", a('1')));
            w("gateway", format!("{{\"gateway\":\"{}\"}}", a('2')));
            w("registry", format!("{{\"registry\":\"{}\"}}", a('3')));
            w("router", format!("{{\"router\":\"{}\"}}", a('4')));
            w("governance", format!("{{\"governance\":\"{}\"}}", a('5')));
            w(
                "ic-policy",
                format!(
                    "{{\"policy\":\"{}\",\"consensus_receipt\":\"{}\"}}",
                    a('6'),
                    a('7')
                ),
            );
            w(
                "timelock",
                format!("{{\"timelock\":\"{}\",\"safe\":\"{}\"}}", a('8'), a('9')),
            );
            for (i, (_, f)) in t.vault_manifests().into_iter().enumerate().skip(1) {
                std::fs::write(
                    dir.join(n(f)),
                    format!("{{\"vault\":\"0x{}\"}}", format!("{:x}", i + 10).repeat(20)),
                )
                .unwrap();
            }
            dir
        };
        let d = write(&table, false);
        let topo = load_topology_with(&d, &table).unwrap();
        assert_eq!(topo.gateway, a('2'));
        assert_eq!(topo.safe, a('9'));
        assert_eq!(topo.vaults.len(), 4);
        assert_eq!(topo.vaults["rmUSDC"], a('1'));
        // Rename the router manifest in a temp copy of the table: the reader follows it.
        let renamed = StageTable::parse(&real.replace("router.json", "router-x.json")).unwrap();
        let d2 = write(&renamed, true);
        assert_eq!(load_topology_with(&d2, &renamed).unwrap().router, a('4'));
        // The original table no longer finds the router manifest in the renamed directory.
        assert!(load_topology_with(&d2, &table).is_err());
    }
}
