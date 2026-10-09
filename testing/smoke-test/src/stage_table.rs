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
}

#[derive(Debug, Clone, Deserialize)]
struct VaultRow {
    key: String,
    manifest: String,
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

    /// Every manifest a full publish writes: one per stage that has one.
    pub fn all_manifests(&self) -> Vec<String> {
        self.stages
            .iter()
            .filter_map(|s| s.manifest.as_deref())
            .map(file_name)
            .collect()
    }

    pub fn expected_manifest_count(&self) -> usize {
        self.all_manifests().len()
    }

    /// `(rmUSDC, vault manifest file)` and so on: the table's vault key with the `rm` prefix.
    pub fn vault_manifests(&self) -> Vec<(String, String)> {
        self.vaults
            .iter()
            .map(|v| (format!("rm{}", v.key), file_name(&v.manifest)))
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
