//! Manifest names for the Twin harness, read at runtime from `scripts/deploy/stage-table.json`
//! (the single source of truth for what the deploy writes). No manifest file name is hard-coded in
//! the harness: `publish.rs` and the integration tests ask this module.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::HarnessError;

#[derive(Debug, Clone, Deserialize)]
struct Stage {
    name: String,
    #[serde(default)]
    manifest: Option<String>,
    /// Issue 1892: the system the stage belongs to (`vaults`, `gateway` or `fund`). Absent in a table from before the split: every stage is the vaults run.
    #[serde(default)]
    system: Option<String>,
}

/// The vaults system's name in the table (issue 1892).
pub const VAULTS_SYSTEM: &str = "vaults";

/// The gateway system's name in the table (issue 1892).
pub const GATEWAY_SYSTEM: &str = "gateway";

/// The systems this harness publishes: the vaults run, then the gateway run. Any other system in the table
/// (Deploy 4's `fund`, the one-vault prototype) is its own independent run that this harness never makes, so
/// its manifests are neither expected nor counted here.
const HARNESS_SYSTEMS: [&str; 2] = [VAULTS_SYSTEM, GATEWAY_SYSTEM];

impl Stage {
    /// The stage's system; a stage of a table from before the split is a vaults stage.
    fn system_name(&self) -> &str {
        self.system.as_deref().unwrap_or(VAULTS_SYSTEM)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultRow {
    key: String,
    manifest: String,
    /// Issue 1705: the vault stage leaves deposits paused (absent in an older table: false).
    #[serde(default)]
    deploy_paused: bool,
    /// Issue 1705: the vault's unpause row is a stage 13 row.
    #[serde(default)]
    unpause_in_stage13: bool,
}

/// The deposit rule of one vault from the table (issue 1705): its `rm<KEY>` name, whether it deploys paused, and whether stage 13 unpauses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultDepositRule {
    pub name: String,
    pub deploy_paused: bool,
    pub unpause_in_stage13: bool,
}

impl VaultDepositRule {
    /// The paused state after stage 13 ran every unpause row the sheet lists: open when the row is a stage 13 row, else its deploy state.
    pub fn paused_after_stage13(&self) -> bool {
        self.deploy_paused && !self.unpause_in_stage13
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct StageTable {
    stages: Vec<Stage>,
    vaults: Vec<VaultRow>,
}

/// `scripts/deploy/stage-table.json` under the repo root this crate lives in.
pub fn default_table_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/deploy/stage-table.json")
}

fn file_name(manifest: &str) -> String {
    Path::new(manifest)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| manifest.to_string())
}

impl StageTable {
    pub fn load(path: &Path) -> Result<Self, HarnessError> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| HarnessError::DeploymentJson(path.to_path_buf(), e.to_string()))?;
        Self::parse(&text).map_err(|e| HarnessError::DeploymentJson(path.to_path_buf(), e))
    }

    /// The table of the checkout the harness runs in (the working directory's repo root), else the one this crate
    /// was built from. A binary built in an image runs against a mounted checkout, so the build path is not enough.
    pub fn load_default() -> Result<Self, HarnessError> {
        match test_utils::find_workspace_root() {
            Some(root) => Self::load(&root.join("scripts/deploy/stage-table.json")),
            None => Self::load(&default_table_path()),
        }
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        serde_json::from_str(text).map_err(|e| e.to_string())
    }

    /// The manifest file name (no directory) of a stage.
    pub fn manifest_of(&self, stage: &str) -> Result<String, HarnessError> {
        self.stages
            .iter()
            .find(|s| s.name == stage)
            .and_then(|s| s.manifest.as_deref())
            .map(file_name)
            .ok_or_else(|| {
                HarnessError::other(format!("stage-table.json: stage '{stage}' has no manifest"))
            })
    }

    /// Every manifest a full harness publish (the vaults run, then the gateway run) writes: one per stage of those
    /// systems that has one.
    pub fn all_manifests(&self) -> Vec<String> {
        self.stages
            .iter()
            .filter(|s| HARNESS_SYSTEMS.contains(&s.system_name()))
            .filter_map(|s| s.manifest.as_deref())
            .map(file_name)
            .collect()
    }

    pub fn expected_manifest_count(&self) -> usize {
        self.all_manifests().len()
    }

    /// Issue 1892: the manifests the vaults system writes (every `vaults` stage, and every stage of a table from before the split). A vaults run writes these and no
    /// gateway or fund manifest.
    pub fn vaults_manifests(&self) -> Vec<String> {
        self.system_manifests(VAULTS_SYSTEM)
    }

    /// Issue 1892: the manifests the gateway system writes (`gateway.json`, `gateway-handover.json`). Empty in a table from before the split.
    pub fn gateway_manifests(&self) -> Vec<String> {
        self.system_manifests(GATEWAY_SYSTEM)
    }

    fn system_manifests(&self, system: &str) -> Vec<String> {
        self.stages
            .iter()
            .filter(|s| s.system_name() == system)
            .filter_map(|s| s.manifest.as_deref())
            .map(file_name)
            .collect()
    }

    /// The vaults system's manifests that are missing in `dir`.
    pub fn vaults_missing(&self, dir: &Path) -> Vec<String> {
        self.vaults_manifests()
            .into_iter()
            .filter(|f| !dir.join(f).is_file())
            .collect()
    }

    /// The gateway system's manifests that exist in `dir` (a vaults-only run has none).
    pub fn gateway_present(&self, dir: &Path) -> Vec<String> {
        self.gateway_manifests()
            .into_iter()
            .filter(|f| dir.join(f).is_file())
            .collect()
    }

    /// `(rmUSDC, vault manifest file)` and so on: the table's vault key with the `rm` prefix.
    pub fn vault_manifests(&self) -> Vec<(String, String)> {
        self.vaults
            .iter()
            .map(|v| (format!("rm{}", v.key), file_name(&v.manifest)))
            .collect()
    }

    /// The deposit rule of every vault, in table order (issue 1705).
    pub fn vault_deposit_rules(&self) -> Vec<VaultDepositRule> {
        self.vaults
            .iter()
            .map(|v| VaultDepositRule {
                name: format!("rm{}", v.key),
                deploy_paused: v.deploy_paused,
                unpause_in_stage13: v.unpause_in_stage13,
            })
            .collect()
    }

    /// How many of the table's manifests exist in `dir`.
    pub fn count_present(&self, dir: &Path) -> usize {
        self.all_manifests()
            .iter()
            .filter(|f| dir.join(f).is_file())
            .count()
    }

    pub fn missing(&self, dir: &Path) -> Vec<String> {
        self.all_manifests()
            .into_iter()
            .filter(|f| !dir.join(f).is_file())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_table_has_no_core_json_and_follows_the_deploy() {
        let t = StageTable::load_default().unwrap();
        let all = t.all_manifests();
        assert!(!all.contains(&"core.json".to_string()));
        assert!(all.iter().all(|f| !f.starts_with("vault-")));
        assert!(all.contains(&"vault.json".to_string()));
        assert_eq!(t.expected_manifest_count(), all.len());
        assert_eq!(t.vault_manifests().len(), 4);
    }

    #[test]
    fn real_table_splits_the_vaults_and_the_gateway_manifests() {
        let t = StageTable::load_default().unwrap();
        let (v, g) = (t.vaults_manifests(), t.gateway_manifests());
        assert!(!v.is_empty());
        assert_eq!(g, ["gateway.json", "gateway-handover.json"]);
        assert!(v.iter().all(|f| !g.contains(f)));
        assert_eq!(v.len() + g.len(), t.expected_manifest_count());
        // a vaults-only directory: every vaults manifest, no gateway one
        let tmp = tempfile::tempdir().unwrap();
        for f in &v {
            std::fs::write(tmp.path().join(f), "{}").unwrap();
        }
        assert!(t.vaults_missing(tmp.path()).is_empty());
        assert!(t.gateway_present(tmp.path()).is_empty());
        std::fs::write(tmp.path().join("gateway.json"), "{}").unwrap();
        assert_eq!(t.gateway_present(tmp.path()), ["gateway.json"]);
    }

    #[test]
    fn a_third_system_is_neither_vaults_nor_gateway_nor_expected() {
        let t = StageTable::parse(
            r#"{"stages":[{"name":"a","manifest":"d/<chain>/a.json","system":"vaults"},{"name":"g","manifest":"d/<chain>/g.json","system":"gateway"},{"name":"f","manifest":"d/<chain>/f.json","system":"fund"}],"vaults":[]}"#,
        )
        .unwrap();
        assert_eq!(t.vaults_manifests(), ["a.json"]);
        assert_eq!(t.gateway_manifests(), ["g.json"]);
        assert_eq!(t.all_manifests(), ["a.json", "g.json"]);
        assert_eq!(t.expected_manifest_count(), 2);
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.json"), "{}").unwrap();
        assert!(t.vaults_missing(tmp.path()).is_empty());
        assert_eq!(t.missing(tmp.path()), ["g.json"]);
        assert_eq!(t.manifest_of("f").unwrap(), "f.json");
    }

    #[test]
    fn real_table_keeps_the_fund_system_out_of_the_harness_runs() {
        let t = StageTable::load_default().unwrap();
        let all = t.all_manifests();
        for f in [
            "fund.json",
            "fund-libs.json",
            "queue.json",
            "fund-timelock.json",
        ] {
            assert!(
                !all.contains(&f.to_string()),
                "{f} is not a harness manifest"
            );
        }
        assert_eq!(t.manifest_of("fund").unwrap(), "fund.json");
    }

    #[test]
    fn a_table_without_systems_is_all_vaults() {
        let t = StageTable::parse(
            r#"{"stages":[{"name":"a","manifest":"d/<chain>/a.json"}],"vaults":[]}"#,
        )
        .unwrap();
        assert_eq!(t.vaults_manifests(), ["a.json"]);
        assert!(t.gateway_manifests().is_empty());
    }

    #[test]
    fn real_table_carries_the_four_vault_deposit_rules() {
        let t = StageTable::load_default().unwrap();
        let rules = t.vault_deposit_rules();
        let names: Vec<&str> = rules.iter().map(|r| r.name.as_str()).collect();
        // core 2008, ADR-0018: rmHARD is the fourth router vault, in the retired rmAGENT slot.
        assert_eq!(names, ["rmUSDC", "rmPROTO", "rmRWA", "rmHARD"]);
        // issue 1705 Q1 (a): all four deploy paused and stage 13 opens all four
        assert!(rules
            .iter()
            .all(|r| r.deploy_paused && r.unpause_in_stage13));
        assert!(rules.iter().all(|r| !r.paused_after_stage13()));
    }

    #[test]
    fn a_stage_without_a_manifest_does_not_count() {
        let t = StageTable::parse(
            r#"{"stages":[{"name":"a","manifest":"d/<chain>/a.json"},{"name":"b","manifest":null}],"vaults":[]}"#,
        )
        .unwrap();
        assert_eq!(t.expected_manifest_count(), 1);
        assert!(t.manifest_of("b").is_err());
        assert_eq!(t.manifest_of("a").unwrap(), "a.json");
    }

    #[test]
    fn readers_follow_a_renamed_manifest_in_a_temp_copy() {
        let real = std::fs::read_to_string(default_table_path()).unwrap();
        let renamed = real.replace("<chain>/vault.json", "<chain>/usdc-vault-renamed.json");
        assert_ne!(real, renamed, "the table must name vault.json");
        let tmp = tempfile::tempdir().unwrap();
        let table_path = tmp.path().join("stage-table.json");
        std::fs::write(&table_path, renamed).unwrap();
        let t = StageTable::load(&table_path).unwrap();
        assert_eq!(t.manifest_of("vault").unwrap(), "usdc-vault-renamed.json");
        let mdir = tmp.path().join("m");
        std::fs::create_dir(&mdir).unwrap();
        let real_table = StageTable::load_default().unwrap();
        for f in real_table.all_manifests() {
            std::fs::write(mdir.join(f), "{}").unwrap();
        }
        assert_eq!(
            real_table.count_present(&mdir),
            real_table.expected_manifest_count()
        );
        assert_eq!(t.count_present(&mdir), t.expected_manifest_count() - 1);
        assert_eq!(
            t.missing(&mdir),
            vec!["usdc-vault-renamed.json".to_string()]
        );
        std::fs::write(mdir.join("usdc-vault-renamed.json"), "{}").unwrap();
        assert_eq!(t.count_present(&mdir), t.expected_manifest_count());
    }
}
