//! Canonical: docs/testing/smoke-test-design.md (Devnet + USDC faucet sections).
//! Implements: issue #255 — genesis alloc builder for the Geth+Lighthouse devnet.
//!
//! This module ingests a Base-mainnet state snapshot (the Anvil `--dump-state`
//! JSON committed at `testing/fixtures/fork-state/CURRENT.anvil-state`) and
//! produces a geth-genesis-compatible `alloc` map restricted to the address
//! allowlist declared in `testing/ethereum-testnet/config/fork-block.json`.
//!
//! On top of the ingested Base state the builder:
//! 1. Overlays the harness EOAs (deployer, pauser, share receiver, agent,
//!    HARNESS_USDC_HOLDER) with ETH balances for gas.
//! 2. Patches USDC storage to grant `HARNESS_USDC_HOLDER` a clean-history
//!    USDC balance — by writing the balance slot inside USDC's storage map
//!    AND incrementing `totalSupply`. The storage layout follows Circle's
//!    `FiatTokenV2_1`: balances live in mapping at slot 9, totalSupply at
//!    slot 1.
//!
//! The output is a [`GenesisAlloc`] that serializes to the exact shape geth
//! expects under `genesis.json::alloc`. The CLI binary
//! `smoke-test-genesis-ingester` (added in this module) writes it to disk so
//! the Docker `setup` container can merge it into the generated genesis.
//!
//! ## USDC storage seed
//!
//! `CURRENT.anvil-state` is produced by Anvil's `--dump-state`, which only
//! captures bytecode for addresses that have been explicitly warmed; full
//! storage is NOT preserved. To make `USDC.symbol()` / `name()` /
//! `totalSupply()` resolve to real Base values on the devnet, the builder
//! layers a committed seed file (`testing/fixtures/fork-state/usdc-storage-seed.json`)
//! onto the proxy account and registers the FiatTokenV2_2 implementation
//! contract so the proxy's delegatecall resolves. See
//! `docs/testing/smoke-test-design.md` for the capture procedure.

use std::collections::BTreeMap;
use std::path::Path;

use alloy_primitives::{keccak256, Address, B256, U256};
use serde::{Deserialize, Serialize};

use crate::fork_manifest::{ForkManifest, ManifestError};

// -- Canonical addresses ---------------------------------------------------

/// Canonical Base mainnet USDC proxy (Circle FiatTokenV2_1).
pub const BASE_USDC_ADDR: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/// FiatTokenV2_1 storage slot index for the `balances` mapping. The slot
/// holding `balances[holder]` is `keccak256(abi.encode(holder, 9))`.
///
/// Verified empirically against Base mainnet at block 45743443 with
/// `cast storage 0x8335… $(cast index address <holder> 9)` matching
/// `balanceOf(<holder>)`.
pub const FIAT_TOKEN_BALANCES_SLOT: u64 = 9;

/// FiatTokenV2_1 storage slot for `totalSupply_`.
///
/// Despite the FiatTokenV1 source code declaring `totalSupply_` early, the
/// inheritance chain shifts it down: `Ownable` (slot 0), `Pausable`
/// (slot 1: pauser, slot 2: paused — packed), `Blacklistable` (slot 3:
/// blacklister, slot 4: blacklisted mapping). Then FiatTokenV1 adds
/// `name` (slot 5? — actually slot 4 is the name string), `symbol`,
/// `decimals`, `currency`, `masterMinter`+`initialized` packed, then
/// `balances`, `allowed`, `totalSupply_`. Verified against Base mainnet:
/// `cast call totalSupply()` == `cast storage USDC 11`.
pub const FIAT_TOKEN_TOTAL_SUPPLY_SLOT: u64 = 11;

/// ZeppelinOS proxy implementation slot:
/// `keccak256("org.zeppelinos.proxy.implementation")`. Circle's
/// FiatTokenProxy predates EIP-1967 and uses this older scheme. The seed
/// file at `testing/fixtures/fork-state/usdc-storage-seed.json` records
/// this slot's value so the devnet proxy can delegatecall the
/// implementation we register alongside it.
pub const ZEPPELINOS_PROXY_IMPL_SLOT: &str =
    "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

/// ZeppelinOS proxy admin slot:
/// `keccak256("org.zeppelinos.proxy.admin")`.
pub const ZEPPELINOS_PROXY_ADMIN_SLOT: &str =
    "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b";

// -- Output shape ----------------------------------------------------------

/// A single account entry in geth's `genesis.json::alloc`.
///
/// `code` is emitted as `0x`-prefixed hex when non-empty; omitted otherwise.
/// `storage` is emitted only when non-empty. `balance` is always emitted (geth
/// requires it) as decimal-or-hex per geth convention; we emit hex with `0x`
/// prefix.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AllocEntry {
    /// 0x-prefixed hex (e.g. "0x0", "0x1bc16d674ec80000" for 2 ETH).
    pub balance: String,
    /// Optional nonce; geth defaults to 0 when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<u64>,
    /// 0x-prefixed hex bytecode. Omitted when the account is an EOA.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Storage slot map. Keys and values are 0x-prefixed 32-byte hex.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub storage: BTreeMap<String, String>,
}

/// Geth-genesis-compatible `alloc` map. Address keys are 0x-prefixed
/// lowercase 20-byte hex (geth normalises either case, but we emit lowercase
/// for stable diffs).
#[derive(Debug, Clone, Default, Serialize)]
pub struct GenesisAlloc(pub BTreeMap<String, AllocEntry>);

// -- Input shape (Anvil --dump-state JSON) --------------------------------

/// Subset of Anvil's `--dump-state` JSON. We only need `accounts`; the rest
/// (block, transactions, historical_states) is ignored.
#[derive(Debug, Deserialize)]
struct AnvilState {
    accounts: BTreeMap<String, AnvilAccount>,
}

/// One account entry in Anvil's dump. Anvil emits `balance` as `0x…` hex,
/// `nonce` as either a decimal integer or a `0x…` hex string (both forms are
/// observed across different Anvil versions and fork snapshots — e.g. proxied
/// contracts added at Base-mainnet block 45743443 carry `"nonce":"0x1"`),
/// `code` as `0x…` hex (including `0x` for empty EOAs), and `storage` as a
/// `{ "0x…32bytes" : "0x…32bytes" }` map.
#[derive(Debug, Deserialize, Clone)]
struct AnvilAccount {
    #[serde(default, deserialize_with = "de_nonce")]
    nonce: u64,
    #[serde(default)]
    balance: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    storage: BTreeMap<String, String>,
}

/// Deserialize a nonce that may be either a JSON number (`1`) or a `0x`-hex
/// string (`"0x1"`). Both forms appear in Anvil `--dump-state` output
/// depending on the snapshot origin.
fn de_nonce<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    use serde::de::{Error, Unexpected};
    use serde_json::Value;
    let v = Value::deserialize(d)?;
    match &v {
        Value::Number(n) => n
            .as_u64()
            .ok_or_else(|| D::Error::invalid_value(Unexpected::Other("non-u64 number"), &"u64")),
        Value::String(s) => {
            let hex = s.trim_start_matches("0x");
            u64::from_str_radix(hex, 16)
                .map_err(|_| D::Error::invalid_value(Unexpected::Str(s), &"hex u64 string"))
        }
        // JSON `null` treated as 0 (matches `#[serde(default)]` semantics).
        Value::Null => Ok(0),
        other => Err(D::Error::invalid_type(
            Unexpected::Other(other.as_str().unwrap_or("unknown")),
            &"u64 or 0x-hex string",
        )),
    }
}

// -- Builder errors --------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum IngesterError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("snapshot json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("manifest: {0}")]
    Manifest(#[from] ManifestError),
    #[error(
        "ingester: address {address} listed in fork-block.json::ingested_addresses is not present in snapshot"
    )]
    MissingIngestedAddress { address: String },
    #[error(
        "ingester: snapshot lacks canonical Base USDC ({BASE_USDC_ADDR}); refusing to patch storage without a real USDC entry"
    )]
    MissingUsdc,
    #[error("ingester: usdc-storage-seed.json: {0}")]
    UsdcSeed(String),
    #[error("ingester: {0}")]
    Other(String),
}

// -- USDC storage seed ----------------------------------------------------

/// Default repo-relative path to the committed USDC seed file.
pub const USDC_SEED_PATH: &str = "testing/fixtures/fork-state/usdc-storage-seed.json";

/// Typed view over `testing/fixtures/fork-state/usdc-storage-seed.json`.
///
/// Carries the proxy's critical storage slots (owner, name, symbol, decimals,
/// totalSupply, masterMinter, proxy impl pointer, …) plus the implementation
/// contract's bytecode. The genesis alloc builder applies the proxy storage
/// onto the USDC proxy account ingested from the snapshot, and registers the
/// implementation account separately so the proxy's delegatecall resolves on
/// the devnet.
#[derive(Debug, Clone, Deserialize)]
pub struct UsdcStorageSeed {
    pub fork_block: u64,
    pub chain: String,
    pub proxy: UsdcProxySeed,
    pub implementation: UsdcImplSeed,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UsdcProxySeed {
    pub address: String,
    pub storage: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UsdcImplSeed {
    pub address: String,
    pub code: String,
}

impl UsdcStorageSeed {
    /// Load + validate the seed file from disk. Validates the proxy address
    /// matches the canonical Base USDC and the implementation slot inside the
    /// proxy storage points at the seeded implementation address.
    pub fn load(path: &Path) -> Result<Self, IngesterError> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| IngesterError::UsdcSeed(format!("read {}: {e}", path.display())))?;
        let seed: UsdcStorageSeed = serde_json::from_str(&raw)
            .map_err(|e| IngesterError::UsdcSeed(format!("parse {}: {e}", path.display())))?;
        seed.validate()?;
        Ok(seed)
    }

    fn validate(&self) -> Result<(), IngesterError> {
        let want: Address = BASE_USDC_ADDR.parse().unwrap();
        let got: Address = self
            .proxy
            .address
            .parse()
            .map_err(|e| IngesterError::UsdcSeed(format!("bad proxy address: {e}")))?;
        if got != want {
            return Err(IngesterError::UsdcSeed(format!(
                "proxy address mismatch: seed {got:#x} vs canonical {want:#x}"
            )));
        }
        let impl_addr: Address = self
            .implementation
            .address
            .parse()
            .map_err(|e| IngesterError::UsdcSeed(format!("bad impl address: {e}")))?;
        let impl_slot_val = self
            .proxy
            .storage
            .get(ZEPPELINOS_PROXY_IMPL_SLOT)
            .ok_or_else(|| {
                IngesterError::UsdcSeed("missing ZeppelinOS implementation slot".into())
            })?;
        let stored = U256::from_str_radix(impl_slot_val.trim_start_matches("0x"), 16)
            .map_err(|e| IngesterError::UsdcSeed(format!("impl slot value parse: {e}")))?;
        let impl_as_u256 = U256::from_be_slice(&{
            let mut buf = [0u8; 32];
            buf[12..].copy_from_slice(impl_addr.as_slice());
            buf
        });
        if stored != impl_as_u256 {
            return Err(IngesterError::UsdcSeed(format!(
                "implementation slot {stored:#x} does not point at declared impl {impl_addr:#x}"
            )));
        }
        if !self.implementation.code.starts_with("0x") || self.implementation.code.len() < 4 {
            return Err(IngesterError::UsdcSeed(
                "implementation.code must be non-empty 0x-prefixed hex".into(),
            ));
        }
        Ok(())
    }
}

// -- Public API ------------------------------------------------------------

/// Default ETH (wei, decimal) allocation for each harness EOA. 1_000 ETH —
/// matches the per-account balance Anvil hands out to its `--mnemonic` test
/// accounts so existing test code that assumes "plenty of gas" keeps working.
pub const DEFAULT_HARNESS_ETH_WEI: &str = "0x3635c9adc5dea00000"; // 1_000 * 1e18

/// The full set of harness EOAs that must receive an ETH grant in genesis.
/// Order is irrelevant — the output map is `BTreeMap`-sorted.
///
/// These addresses are the public counterparts of the private keys defined
/// at the top of `lib.rs`. They are repeated here as string literals (rather
/// than imported) so the ingester binary can run standalone with a clear
/// audit trail of every key it touches.
pub fn harness_eoas() -> Vec<Address> {
    [
        // deployer
        "0x8943545177806ED17B9F23F0a21ee5948eCaa776",
        // pauser
        "0x614561D2d143621E126e87831AEF287678B442b8",
        // share receiver
        "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec",
        // agent
        "0xf93Ee4Cf8c6c40b329b0c0626F28333c132CF241",
        // HARNESS_USDC_HOLDER
        "0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5",
    ]
    .iter()
    .map(|s| s.parse().expect("static harness address parses"))
    .collect()
}

/// Build a `GenesisAlloc` from a snapshot file path + a validated manifest.
///
/// Steps:
/// 1. Load the Anvil-format snapshot JSON.
/// 2. For each address in `manifest.ingested_addresses`, copy the snapshot's
///    bytecode + balance + storage verbatim into the output alloc. (Empty
///    storage entries in the snapshot are preserved — see module docs on
///    the snapshot limitation.)
/// 3. Overlay each harness EOA with `DEFAULT_HARNESS_ETH_WEI` and nonce 0.
///    If an overlay collides with an ingested address, the harness overlay
///    wins for `balance`/`nonce` but the ingested `code`/`storage` is kept;
///    this should never happen for normal manifests because the validator
///    rejects overlap between `harness_usdc_holder` and `ingested_addresses`.
/// 4. Apply USDC storage patches: `balances[harness] += grant` and
///    `totalSupply += grant`. Both reads use the existing slot value as a
///    starting point so prior real values (once the storage seed is
///    populated, see #255 step 7) are not stomped on.
pub fn build_alloc(
    snapshot_path: &Path,
    manifest: &ForkManifest,
) -> Result<GenesisAlloc, IngesterError> {
    let raw = std::fs::read_to_string(snapshot_path)?;
    let snap: AnvilState = serde_json::from_str(&raw)?;
    // Resolve the seed file alongside the snapshot. Both live under
    // `testing/fixtures/fork-state/` so we look there first; callers that
    // want a different layout can use `build_alloc_with_seed`.
    let seed_path = snapshot_path
        .parent()
        .map(|p| p.join("usdc-storage-seed.json"))
        .unwrap_or_else(|| std::path::PathBuf::from("usdc-storage-seed.json"));
    let seed = if seed_path.exists() {
        Some(UsdcStorageSeed::load(&seed_path)?)
    } else {
        None
    };
    build_alloc_from_anvil(&snap, manifest, seed.as_ref())
}

/// Like [`build_alloc`] but with an explicit seed override. Used by tests
/// that want to construct the seed in-memory.
pub fn build_alloc_with_seed(
    snapshot_path: &Path,
    manifest: &ForkManifest,
    seed: Option<&UsdcStorageSeed>,
) -> Result<GenesisAlloc, IngesterError> {
    let raw = std::fs::read_to_string(snapshot_path)?;
    let snap: AnvilState = serde_json::from_str(&raw)?;
    build_alloc_from_anvil(&snap, manifest, seed)
}

fn build_alloc_from_anvil(
    snap: &AnvilState,
    manifest: &ForkManifest,
    seed: Option<&UsdcStorageSeed>,
) -> Result<GenesisAlloc, IngesterError> {
    let mut out: BTreeMap<String, AllocEntry> = BTreeMap::new();

    // 1. Ingested Base accounts (allowlist).
    let lower_accounts: BTreeMap<String, &AnvilAccount> = snap
        .accounts
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v))
        .collect();
    for addr in &manifest.ingested_addresses {
        let key = address_key(addr);
        let snap_acct =
            lower_accounts
                .get(&key)
                .ok_or_else(|| IngesterError::MissingIngestedAddress {
                    address: format!("{addr:#x}"),
                })?;
        out.insert(key, anvil_to_alloc(snap_acct));
    }

    // 2. Harness EOAs.
    for eoa in harness_eoas() {
        let key = address_key(&eoa);
        out.entry(key).or_insert_with(|| AllocEntry {
            balance: DEFAULT_HARNESS_ETH_WEI.to_string(),
            nonce: None,
            code: None,
            storage: BTreeMap::new(),
        });
    }

    // 3. USDC storage seed: layer committed slots (owner/name/symbol/…)
    //    onto the proxy account and register the implementation contract
    //    so the proxy's delegatecall resolves on the devnet.
    let usdc_key = address_key(
        &BASE_USDC_ADDR
            .parse::<Address>()
            .expect("static USDC address parses"),
    );

    if let Some(seed) = seed {
        let proxy_entry = out.get_mut(&usdc_key).ok_or(IngesterError::MissingUsdc)?;
        for (slot, val) in &seed.proxy.storage {
            proxy_entry
                .storage
                .insert(slot.to_ascii_lowercase(), val.clone());
        }
        // Implementation account: code + a placeholder balance of 0.
        let impl_addr: Address = seed
            .implementation
            .address
            .parse()
            .map_err(|e| IngesterError::UsdcSeed(format!("impl address parse: {e}")))?;
        let impl_key = address_key(&impl_addr);
        out.entry(impl_key).or_insert_with(|| AllocEntry {
            balance: "0x0".to_string(),
            nonce: None,
            code: Some(seed.implementation.code.clone()),
            storage: BTreeMap::new(),
        });
    }

    let usdc_entry = out.get_mut(&usdc_key).ok_or(IngesterError::MissingUsdc)?;

    let grant = U256::from(manifest.harness_usdc_grant_units);

    // balances[holder] slot = keccak256(abi.encode(holder, 9))
    let balance_slot = balances_slot(&manifest.harness_usdc_holder, FIAT_TOKEN_BALANCES_SLOT);
    let balance_slot_key = b256_hex(&balance_slot);
    let existing_balance = read_slot_u256(&usdc_entry.storage, &balance_slot_key);
    let new_balance = existing_balance.saturating_add(grant);
    usdc_entry
        .storage
        .insert(balance_slot_key, u256_hex(&new_balance));

    // totalSupply slot = 1
    let total_supply_key = slot_index_hex(FIAT_TOKEN_TOTAL_SUPPLY_SLOT);
    let existing_supply = read_slot_u256(&usdc_entry.storage, &total_supply_key);
    let new_supply = existing_supply.saturating_add(grant);
    usdc_entry
        .storage
        .insert(total_supply_key, u256_hex(&new_supply));

    Ok(GenesisAlloc(out))
}

// -- Helpers ---------------------------------------------------------------

fn address_key(a: &Address) -> String {
    // alloy's Address::to_string emits checksum; we want stable lowercase
    // for diff hygiene in the produced JSON.
    format!("{:#x}", a)
}

fn anvil_to_alloc(a: &AnvilAccount) -> AllocEntry {
    let code_opt = if a.code.is_empty() || a.code == "0x" {
        None
    } else {
        Some(a.code.clone())
    };
    let balance = if a.balance.is_empty() {
        "0x0".to_string()
    } else {
        a.balance.clone()
    };
    let nonce = if a.nonce == 0 { None } else { Some(a.nonce) };
    AllocEntry {
        balance,
        nonce,
        code: code_opt,
        storage: a.storage.clone(),
    }
}

/// `keccak256(abi.encode(holder, slot))` for a solidity `mapping(address => …)`.
/// The encoding is `bytes32(holder)` followed by `bytes32(slot)` — 64 bytes
/// total — fed through keccak256.
pub fn balances_slot(holder: &Address, mapping_slot: u64) -> B256 {
    let mut buf = [0u8; 64];
    // Left-pad 20-byte address into a 32-byte word at offset [12..32].
    buf[12..32].copy_from_slice(holder.as_slice());
    // Mapping slot as big-endian u256 in bytes [32..64].
    buf[56..64].copy_from_slice(&mapping_slot.to_be_bytes());
    keccak256(buf)
}

fn slot_index_hex(slot: u64) -> String {
    let mut buf = [0u8; 32];
    buf[24..32].copy_from_slice(&slot.to_be_bytes());
    format!("0x{}", hex::encode(buf))
}

fn b256_hex(b: &B256) -> String {
    format!("0x{}", hex::encode(b.as_slice()))
}

fn u256_hex(v: &U256) -> String {
    format!("0x{}", hex::encode(v.to_be_bytes::<32>()))
}

fn read_slot_u256(storage: &BTreeMap<String, String>, key: &str) -> U256 {
    storage
        .get(key)
        .and_then(|s| {
            let trimmed = s.trim_start_matches("0x");
            if trimmed.is_empty() {
                return Some(U256::ZERO);
            }
            U256::from_str_radix(trimmed, 16).ok()
        })
        .unwrap_or(U256::ZERO)
}

// -- Tests -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fork_manifest::ForkManifest;

    /// Path to the committed Anvil fixture relative to repo root.
    const FIXTURE_REL: &str = "testing/fixtures/fork-state/CURRENT.anvil-state";
    const MANIFEST_REL: &str = "testing/ethereum-testnet/config/fork-block.json";

    fn repo_root() -> std::path::PathBuf {
        // CARGO_MANIFEST_DIR = .../testing/smoke-test
        let here = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        here.parent().unwrap().parent().unwrap().to_path_buf()
    }

    #[test]
    fn balances_slot_matches_known_solidity_layout() {
        // Cross-checked against `cast index address <holder> 9`:
        //
        //   $ cast index address 0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5 9
        //   0x13dd27dad043dede11b47aba7345d9986c798174fb05852bd379777f42846ee5
        //
        // (Verified at fixture-pin time; the address is the
        // HARNESS_USDC_HOLDER from fork-block.json.)
        let holder: Address = "0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5"
            .parse()
            .unwrap();
        let slot = balances_slot(&holder, 9);
        assert_eq!(
            b256_hex(&slot),
            "0x13dd27dad043dede11b47aba7345d9986c798174fb05852bd379777f42846ee5"
        );
    }

    #[test]
    fn slot_index_hex_matches_padded_uint256() {
        assert_eq!(
            slot_index_hex(1),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        assert_eq!(
            slot_index_hex(9),
            "0x0000000000000000000000000000000000000000000000000000000000000009"
        );
    }

    #[test]
    fn u256_hex_pads_to_32_bytes() {
        assert_eq!(
            u256_hex(&U256::from(1u64)),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        assert_eq!(
            u256_hex(&U256::from(255u64)),
            "0x00000000000000000000000000000000000000000000000000000000000000ff"
        );
    }

    #[test]
    fn read_slot_handles_missing_short_and_full() {
        let mut s = BTreeMap::new();
        s.insert(
            "0x0000000000000000000000000000000000000000000000000000000000000001".into(),
            "0x0a".into(),
        );
        assert_eq!(
            read_slot_u256(
                &s,
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            ),
            U256::from(10u64)
        );
        assert_eq!(
            read_slot_u256(
                &s,
                "0x0000000000000000000000000000000000000000000000000000000000000099"
            ),
            U256::ZERO
        );
    }

    #[test]
    fn build_alloc_over_committed_fixture() {
        let root = repo_root();
        let snap = root.join(FIXTURE_REL);
        let m_path = root.join(MANIFEST_REL);
        if !snap.exists() || !m_path.exists() {
            // Fixture not checked out; skip.
            return;
        }
        let manifest = ForkManifest::load(&m_path).expect("manifest valid");
        let alloc = build_alloc(&snap, &manifest).expect("alloc built");

        // 1. Every ingested address ends up in the output.
        for a in &manifest.ingested_addresses {
            assert!(
                alloc.0.contains_key(&address_key(a)),
                "ingested address {a:?} missing from output alloc"
            );
        }

        // 2. Every harness EOA ends up in the output with at least the
        //    default ETH balance.
        for eoa in harness_eoas() {
            let entry = alloc
                .0
                .get(&address_key(&eoa))
                .unwrap_or_else(|| panic!("harness EOA {eoa:?} missing"));
            assert_eq!(
                entry.balance, DEFAULT_HARNESS_ETH_WEI,
                "harness EOA {eoa:?} did not receive ETH grant"
            );
        }

        // 3. USDC entry has the harness balance slot set to exactly the
        //    grant (snapshot has no prior balance for the harness EOA).
        let usdc_key = address_key(&BASE_USDC_ADDR.parse::<Address>().unwrap());
        let usdc = alloc.0.get(&usdc_key).expect("USDC alloc entry exists");
        assert!(usdc.code.is_some(), "USDC must carry ingested bytecode");
        let bal_slot = b256_hex(&balances_slot(&manifest.harness_usdc_holder, 9));
        let stored = usdc.storage.get(&bal_slot).expect("balance slot present");
        let expected = u256_hex(&U256::from(manifest.harness_usdc_grant_units));
        assert_eq!(stored, &expected, "balance slot != grant amount");

        // 4. totalSupply slot was bumped by the grant amount. Note: when the
        //    seed file is present the prior value is non-zero (real Base
        //    totalSupply), so we assert >= grant rather than ==.
        let ts_slot = slot_index_hex(FIAT_TOKEN_TOTAL_SUPPLY_SLOT);
        let stored_ts = usdc
            .storage
            .get(&ts_slot)
            .expect("totalSupply slot present");
        let stored_ts_u = U256::from_str_radix(stored_ts.trim_start_matches("0x"), 16).unwrap();
        assert!(
            stored_ts_u >= U256::from(manifest.harness_usdc_grant_units),
            "totalSupply slot {stored_ts_u} < grant {}",
            manifest.harness_usdc_grant_units
        );

        // 5. Seeded slots are present at expected positions: name, symbol,
        //    decimals, totalSupply, implementation pointer.
        let want_slots = [
            (
                "0x0000000000000000000000000000000000000000000000000000000000000004",
                "name",
            ),
            (
                "0x0000000000000000000000000000000000000000000000000000000000000005",
                "symbol",
            ),
            (
                "0x0000000000000000000000000000000000000000000000000000000000000006",
                "decimals",
            ),
            (ZEPPELINOS_PROXY_IMPL_SLOT, "impl pointer"),
        ];
        for (slot, label) in want_slots {
            assert!(
                usdc.storage.contains_key(slot),
                "seeded slot for {label} missing"
            );
        }
        // Implementation account is registered as its own alloc entry.
        let impl_addr: Address = "0x2cE6311ddAE708829Bc0784C967b7d77D19FD779"
            .parse()
            .unwrap();
        let impl_entry = alloc
            .0
            .get(&address_key(&impl_addr))
            .expect("USDC impl account registered");
        assert!(
            impl_entry.code.as_deref().map(|c| c.len()).unwrap_or(0) > 1000,
            "USDC impl bytecode missing or stub"
        );

        // 6. Output is JSON-serializable.
        let _ = serde_json::to_string(&alloc).expect("alloc serializes");
    }

    #[test]
    fn missing_ingested_address_errors() {
        let snap = AnvilState {
            accounts: BTreeMap::new(),
        };
        let manifest = ForkManifest::from_str(
            r#"{
                "chain": "base",
                "block_number": 1,
                "block_hash": "0x1111111111111111111111111111111111111111111111111111111111111111",
                "snapshot_uri": "file://x",
                "ingested_addresses": ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
                "harness_usdc_holder": "0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5",
                "harness_usdc_grant_units": "1000000",
                "pinned": false
            }"#,
        )
        .unwrap();
        let err = build_alloc_from_anvil(&snap, &manifest, None).unwrap_err();
        assert!(matches!(err, IngesterError::MissingIngestedAddress { .. }));
    }

    #[test]
    fn missing_usdc_errors() {
        // Snapshot has the non-USDC ingested address but not USDC itself.
        let mut accounts = BTreeMap::new();
        accounts.insert(
            "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd".into(),
            AnvilAccount {
                nonce: 0,
                balance: "0x0".into(),
                code: "0xdeadbeef".into(),
                storage: BTreeMap::new(),
            },
        );
        let snap = AnvilState { accounts };
        let manifest = ForkManifest::from_str(
            r#"{
                "chain": "base",
                "block_number": 1,
                "block_hash": "0x1111111111111111111111111111111111111111111111111111111111111111",
                "snapshot_uri": "file://x",
                "ingested_addresses": ["0x4F835c9F54bCF17daf9040f60Cb72951CCbb49Dd"],
                "harness_usdc_holder": "0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5",
                "harness_usdc_grant_units": "1000000",
                "pinned": false
            }"#,
        )
        .unwrap();
        let err = build_alloc_from_anvil(&snap, &manifest, None).unwrap_err();
        assert!(matches!(err, IngesterError::MissingUsdc));
    }
}
