//! Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §10 — signed authorizations across an upgrade
//! Implements: core issue 1810 (QA plan v1 P3, Decisions D5) — rmpc checks the live gateway
//!             implementation before it signs, and reads and prints implementation and freeze state.
//!
//! Behind an ERC-1967 proxy the gateway address keeps one runtime code, the
//! proxy's, while the timelock can swap the logic behind it. The
//! `gateway_runtime_hash` pin therefore proves only that the address is a
//! proxy. This module reads the implementation the proxy delegates to and the
//! code at that address, both at one block, and refuses to sign unless that
//! code hash is one the operator pinned in `gateway_implementation_hashes`.
//!
//! Rules, each a refusal before any signature:
//!
//! - every read fails closed: an RPC error is returned to the caller, never
//!   read as "not a proxy";
//! - the implementation slot and the implementation's code are read at the
//!   same explicit block, so an upgrade landing between the two reads cannot
//!   pair one implementation's address with another's code;
//! - a zero slot is a direct (pre-ADR-0014) gateway, whose whole code the
//!   runtime-hash pin already covers. A config that pins implementation hashes
//!   for it is refused: the operator expected a proxy;
//! - a non-zero slot needs `gateway_implementation_hashes` to hold the live
//!   implementation's code hash, else `ErrImplementationNotApproved`. An
//!   implementation with no code is refused the same way.
//!
//! What a pending upgrade means for a signature (QA plan Decisions D5): an
//! agent consent binds `implementationVersion()` through its EIP-712 domain,
//! so an upgrade that changes what a consent means voids every consent signed
//! before it. A transaction in flight runs against whatever implementation is
//! live when it lands; the timelock's public delay is the warning, and the
//! next rmpc write refuses until the operator approves the new code hash.
//!
//! The same rules cover the other proxies a write reaches through the
//! gateway (ADR-0014 §1: the vaults and the router). The address pins
//! (`vault_address`, `gateway.vault()`, `gateway.router()`) do not pin the
//! logic behind a proxy, so a write also reads each reached vault's and the
//! router's implementation at one block and refuses unless its code hash is
//! in `proxy_implementation_hashes` ([`verify_reached_proxy`]). The two
//! writes that do not run the depositor preflight (`committee vote-submit`,
//! `receipt submit`) run checks 1, 2 and 2b through
//! [`verify_gateway_before_signing`].
//!
//! Indexed state never feeds this check: the explorer API is never read here.

use std::str::FromStr;

use alloy_primitives::{b256, keccak256, Address, B256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::errors::{Result, RmpcError};
use crate::gateway::{PortfolioRouter, RobotMoneyGateway};
use crate::rpc::{CallRequest, FailoverRpcClient};

/// The `proxy` value of a gateway refusal.
pub const GATEWAY: &str = "gateway";

/// `bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`.
pub const ERC1967_IMPLEMENTATION_SLOT: B256 =
    b256!("360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");

/// What one block says about the gateway's implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImplementationRead {
    /// The block both reads were made at.
    pub block_number: u64,
    /// The ERC-1967 implementation. `None` when the slot is zero: a direct
    /// gateway, not a proxy.
    pub implementation: Option<Address>,
    /// `keccak256` of the implementation's runtime code at `block_number`.
    /// `None` for a direct gateway.
    pub code_hash: Option<B256>,
    /// True when the slot names an address with no code at `block_number`.
    pub implementation_code_empty: bool,
}

/// The `0x…` block tag of `block_number`.
pub fn block_tag(block_number: u64) -> String {
    format!("0x{block_number:x}")
}

/// Read the ERC-1967 implementation slot of `proxy` and that implementation's
/// code, both at `block_number`.
pub async fn read_implementation(
    rpc: &FailoverRpcClient,
    proxy: Address,
    block_number: u64,
) -> Result<ImplementationRead> {
    let tag = block_tag(block_number);
    let word = rpc
        .get_storage_at(proxy, ERC1967_IMPLEMENTATION_SLOT, Some(&tag))
        .await?;
    let implementation = Address::from_word(word);
    if implementation == Address::ZERO {
        return Ok(ImplementationRead {
            block_number,
            implementation: None,
            code_hash: None,
            implementation_code_empty: false,
        });
    }
    let code = rpc.get_code(implementation, Some(&tag)).await?;
    Ok(ImplementationRead {
        block_number,
        implementation: Some(implementation),
        code_hash: Some(keccak256(code.as_ref())),
        implementation_code_empty: code.is_empty(),
    })
}

/// `gateway_implementation_hashes`, parsed. `None` when the key is absent.
pub fn approved_hashes(cfg: &Config) -> Result<Option<Vec<B256>>> {
    parse_hashes(
        cfg.gateway_implementation_hashes.as_ref(),
        "gateway_implementation_hashes",
    )
}

/// `proxy_implementation_hashes`, parsed. `None` when the key is absent.
pub fn approved_proxy_hashes(cfg: &Config) -> Result<Option<Vec<B256>>> {
    parse_hashes(
        cfg.proxy_implementation_hashes.as_ref(),
        "proxy_implementation_hashes",
    )
}

fn parse_hashes(list: Option<&Vec<String>>, key: &str) -> Result<Option<Vec<B256>>> {
    let Some(list) = list else {
        return Ok(None);
    };
    list.iter()
        .enumerate()
        .map(|(i, h)| {
            B256::from_str(h).map_err(|e| RmpcError::ErrConfig(format!("{key}[{i}]: {e}")))
        })
        .collect::<Result<Vec<_>>>()
        .map(Some)
}

/// Refuse unless `read` names an implementation the config approves (the
/// rules in the module doc).
pub fn check_approved(read: &ImplementationRead, cfg: &Config) -> Result<()> {
    let approved = approved_hashes(cfg)?;
    let Some(implementation) = read.implementation else {
        if approved.is_some() {
            return Err(RmpcError::ErrImplementationNotApproved {
                proxy: GATEWAY.into(),
                implementation: "none".into(),
                code_hash: "none".into(),
                reason: "gateway_implementation_hashes is set but the gateway's ERC-1967 \
                         implementation slot is empty: it is not a proxy"
                    .into(),
            });
        }
        return Ok(());
    };
    let code_hash = read.code_hash.unwrap_or_default();
    let refuse = |reason: &str| RmpcError::ErrImplementationNotApproved {
        proxy: GATEWAY.into(),
        implementation: format!("{implementation:#x}"),
        code_hash: format!("{code_hash:#x}"),
        reason: reason.to_string(),
    };
    if read.implementation_code_empty {
        return Err(refuse("the implementation has no code"));
    }
    match approved {
        None => Err(refuse(
            "the gateway is a proxy and gateway_implementation_hashes is not set; \
             pin the reviewed implementation's code hash",
        )),
        Some(list) if !list.contains(&code_hash) => Err(refuse(
            "its code hash is not in gateway_implementation_hashes",
        )),
        Some(_) => Ok(()),
    }
}

/// The write-path step: read the implementation at the current block and
/// check it. Returns the read so callers can report it.
pub async fn verify_gateway_implementation(
    rpc: &FailoverRpcClient,
    cfg: &Config,
    gateway: Address,
) -> Result<ImplementationRead> {
    let block_number = rpc.block_number().await?;
    let read = read_implementation(rpc, gateway, block_number).await?;
    check_approved(&read, cfg)?;
    Ok(read)
}

/// Checks 1, 2 and 2b of the write preflight, for the writes that sign a
/// gateway transaction without running the depositor preflight
/// (`committee vote-submit`, `receipt submit`): the RPC serves `chain_id`
/// (`ErrChainIdMismatch`), the gateway's code hashes to
/// `gateway_runtime_hash` (`ErrCodeHashMismatch`; empty code is a mismatch),
/// and the implementation behind a proxied gateway is approved
/// (`ErrImplementationNotApproved`). Every failed read is returned as an
/// error, so the caller refuses before any signature.
pub async fn verify_gateway_before_signing(
    rpc: &FailoverRpcClient,
    cfg: &Config,
    gateway: Address,
) -> Result<ImplementationRead> {
    if rpc.chain_id().await? != cfg.chain_id {
        return Err(RmpcError::ErrChainIdMismatch);
    }
    let pinned = B256::from_str(&cfg.gateway_runtime_hash)
        .map_err(|e| RmpcError::ErrConfig(format!("gateway_runtime_hash: {e}")))?;
    let code = rpc.get_code(gateway, None).await?;
    if code.is_empty() || keccak256(code.as_ref()) != pinned {
        return Err(RmpcError::ErrCodeHashMismatch);
    }
    verify_gateway_implementation(rpc, cfg, gateway).await
}

/// Refuse unless `read` (of the vault or router `proxy`, described by
/// `role`) is a direct contract or a proxy whose implementation code hash is
/// in `proxy_implementation_hashes`. A direct contract needs no entry: the
/// address pin covers its whole code.
pub fn check_proxy_approved(
    read: &ImplementationRead,
    cfg: &Config,
    role: &str,
    proxy: Address,
) -> Result<()> {
    let approved = approved_proxy_hashes(cfg)?;
    let Some(implementation) = read.implementation else {
        return Ok(());
    };
    let code_hash = read.code_hash.unwrap_or_default();
    let refuse = |reason: &str| RmpcError::ErrImplementationNotApproved {
        proxy: format!("{role} {proxy:#x}"),
        implementation: format!("{implementation:#x}"),
        code_hash: format!("{code_hash:#x}"),
        reason: reason.to_string(),
    };
    if read.implementation_code_empty {
        return Err(refuse("the implementation has no code"));
    }
    match approved {
        None => Err(refuse(
            "it is a proxy and proxy_implementation_hashes is not set; \
             pin the reviewed implementation's code hash",
        )),
        Some(list) if !list.contains(&code_hash) => Err(refuse(
            "its code hash is not in proxy_implementation_hashes",
        )),
        Some(_) => Ok(()),
    }
}

/// Read and check one vault or router the write reaches (the rules of
/// [`check_proxy_approved`]), at the current block.
pub async fn verify_reached_proxy(
    rpc: &FailoverRpcClient,
    cfg: &Config,
    role: &str,
    proxy: Address,
) -> Result<ImplementationRead> {
    let block_number = rpc.block_number().await?;
    let read = read_implementation(rpc, proxy, block_number).await?;
    check_proxy_approved(&read, cfg, role, proxy)?;
    Ok(read)
}

/// A router-destination deposit reaches the router and every vault of its
/// effective weight vector. Check each of them, all at one block.
pub async fn verify_router_and_legs(
    rpc: &FailoverRpcClient,
    cfg: &Config,
    router: Address,
) -> Result<()> {
    let block_number = rpc.block_number().await?;
    let tag = block_tag(block_number);
    let read = read_implementation(rpc, router, block_number).await?;
    check_proxy_approved(&read, cfg, "router", router)?;
    let weights = call_at(
        rpc,
        router,
        &tag,
        PortfolioRouter::getEffectiveWeightsCall {},
    )
    .await?;
    for vault in weights.vaults {
        let read = read_implementation(rpc, vault, block_number).await?;
        check_proxy_approved(&read, cfg, "router leg vault", vault)?;
    }
    Ok(())
}

/// `gateway.router()`, checked like any other reached proxy (the router a
/// `withdraw-router` redeems through). A zero router has no router path and
/// is returned unchecked: the gateway then refuses the call itself.
pub async fn verify_gateway_router(
    rpc: &FailoverRpcClient,
    cfg: &Config,
    gateway: Address,
) -> Result<Address> {
    let router = call_at(rpc, gateway, "latest", RobotMoneyGateway::routerCall {})
        .await?
        ._0;
    if router != Address::ZERO {
        verify_reached_proxy(rpc, cfg, "router", router).await?;
    }
    Ok(router)
}

/// The upgrade views of a proxied gateway at one block, for printing.
/// Every field is `None` when its read failed or the gateway is not a proxy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct UpgradeViews {
    /// `upgradeAuthority()`: the timelock that may upgrade or freeze.
    pub upgrade_authority: Option<String>,
    /// `upgradesFrozen()`: true once the proxy is frozen for good.
    pub upgrades_frozen: Option<bool>,
    /// `implementationVersion()`: the domain version agent consents bind.
    pub implementation_version: Option<String>,
}

/// One `eth_call` at `tag`, decoded. A revert or a transport error is `Err`.
pub async fn call_at<C: SolCall>(
    rpc: &FailoverRpcClient,
    to: Address,
    tag: &str,
    call: C,
) -> Result<C::Return> {
    let out = rpc
        .eth_call(
            &CallRequest {
                to,
                from: None,
                data: call.abi_encode().into(),
            },
            Some(tag),
        )
        .await?;
    C::abi_decode_returns(&out, true)
        .map_err(|e| RmpcError::ErrRpcDecode(format!("{} decode: {e}", C::SIGNATURE)))
}

/// `implementationVersion()` of the gateway at `tag`.
pub async fn implementation_version(
    rpc: &FailoverRpcClient,
    gateway: Address,
    tag: &str,
) -> Result<String> {
    Ok(call_at(
        rpc,
        gateway,
        tag,
        RobotMoneyGateway::implementationVersionCall {},
    )
    .await?
    ._0)
}

/// Read `upgradeAuthority()`, `upgradesFrozen()` and `implementationVersion()`
/// at `tag`. Each failed read is returned as `(field, message)` next to the
/// values that did read.
pub async fn read_upgrade_views(
    rpc: &FailoverRpcClient,
    gateway: Address,
    tag: &str,
) -> (UpgradeViews, Vec<(&'static str, String)>) {
    let mut views = UpgradeViews::default();
    let mut errors = Vec::new();
    match call_at(
        rpc,
        gateway,
        tag,
        RobotMoneyGateway::upgradeAuthorityCall {},
    )
    .await
    {
        Ok(r) => views.upgrade_authority = Some(format!("{:#x}", r._0)),
        Err(e) => errors.push(("upgrade_authority", e.to_string())),
    }
    match call_at(rpc, gateway, tag, RobotMoneyGateway::upgradesFrozenCall {}).await {
        Ok(r) => views.upgrades_frozen = Some(r._0),
        Err(e) => errors.push(("upgrades_frozen", e.to_string())),
    }
    match implementation_version(rpc, gateway, tag).await {
        Ok(v) => views.implementation_version = Some(v),
        Err(e) => errors.push(("implementation_version", e.to_string())),
    }
    (views, errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SignerConfig;
    use alloy_primitives::address;
    use std::path::PathBuf;

    const IMPL: Address = address!("00000000000000000000000000000000000001a1");

    fn cfg(hashes: Option<Vec<String>>) -> Config {
        Config {
            chain_id: 31337,
            rpc_url: Some("http://placeholder".into()),
            rpc_urls: None,
            gateway_address: "0x0000000000000000000000000000000000000b00".into(),
            usdc_address: "0x0000000000000000000000000000000000000c00".into(),
            vault_address: "0x0000000000000000000000000000000000000d00".into(),
            gateway_runtime_hash: format!("0x{}", "11".repeat(32)),
            gateway_implementation_hashes: hashes,
            proxy_implementation_hashes: None,
            max_fee_per_gas_cap: None,
            max_priority_fee_per_gas_cap: None,
            state_dir: None,
            registry_address: None,
            router_address: None,
            governance_address: None,
            timelock_address: None,
            timelock_from_block: None,
            gateway_from_block: None,
            ic_policy_address: None,
            receipt_address: None,
            vault_addresses: None,
            share_receiver: None,
            agent_owner: None,
            signer: SignerConfig {
                allow_software_fallback: true,
                keystore_path: PathBuf::from("/tmp/ks.enc"),
            },
            log: Default::default(),
        }
    }

    fn proxied(code_hash: B256) -> ImplementationRead {
        ImplementationRead {
            block_number: 7,
            implementation: Some(IMPL),
            code_hash: Some(code_hash),
            implementation_code_empty: false,
        }
    }

    fn direct() -> ImplementationRead {
        ImplementationRead {
            block_number: 7,
            implementation: None,
            code_hash: None,
            implementation_code_empty: false,
        }
    }

    fn refusal(r: Result<()>) -> String {
        match r {
            Err(RmpcError::ErrImplementationNotApproved { reason, .. }) => reason,
            other => panic!("expected ErrImplementationNotApproved, got {other:?}"),
        }
    }

    #[test]
    fn slot_constant_is_the_eip1967_formula() {
        let h = keccak256(b"eip1967.proxy.implementation");
        let slot = alloy_primitives::U256::from_be_bytes(h.0) - alloy_primitives::U256::from(1u8);
        assert_eq!(
            B256::from(slot.to_be_bytes::<32>()),
            ERC1967_IMPLEMENTATION_SLOT
        );
    }

    #[test]
    fn a_direct_gateway_needs_no_implementation_pin() {
        assert!(check_approved(&direct(), &cfg(None)).is_ok());
    }

    #[test]
    fn a_pin_for_a_gateway_that_is_not_a_proxy_is_refused() {
        let reason = refusal(check_approved(
            &direct(),
            &cfg(Some(vec![format!("{:#x}", B256::repeat_byte(0xab))])),
        ));
        assert!(reason.contains("not a proxy"), "{reason}");
    }

    #[test]
    fn a_proxy_without_a_pin_is_refused() {
        let reason = refusal(check_approved(
            &proxied(B256::repeat_byte(0xab)),
            &cfg(None),
        ));
        assert!(reason.contains("not set"), "{reason}");
    }

    #[test]
    fn an_unlisted_implementation_is_refused_and_a_listed_one_passes() {
        let approved = B256::repeat_byte(0xab);
        let c = cfg(Some(vec![
            format!("{:#x}", B256::repeat_byte(0x01)),
            format!("{approved:#x}"),
        ]));
        assert!(check_approved(&proxied(approved), &c).is_ok());
        let reason = refusal(check_approved(&proxied(B256::repeat_byte(0xcd)), &c));
        assert!(
            reason.contains("not in gateway_implementation_hashes"),
            "{reason}"
        );
    }

    #[test]
    fn an_implementation_without_code_is_refused_even_when_its_hash_is_listed() {
        let empty = keccak256(b"");
        let read = ImplementationRead {
            implementation_code_empty: true,
            ..proxied(empty)
        };
        let reason = refusal(check_approved(
            &read,
            &cfg(Some(vec![format!("{empty:#x}")])),
        ));
        assert!(reason.contains("no code"), "{reason}");
    }

    fn proxy_cfg(hashes: Option<Vec<String>>) -> Config {
        Config {
            proxy_implementation_hashes: hashes,
            ..cfg(None)
        }
    }

    const VAULT: Address = address!("0000000000000000000000000000000000000d00");

    #[test]
    fn a_direct_vault_needs_no_proxy_pin() {
        assert!(check_proxy_approved(&direct(), &proxy_cfg(None), "vault", VAULT).is_ok());
    }

    /// The vault behind the gateway is a proxy: the `vault_address` pin
    /// matches, yet a swapped implementation is refused, and so is a missing
    /// `proxy_implementation_hashes`. The refusal names the vault, not the
    /// gateway.
    #[test]
    fn a_proxied_vault_needs_its_implementation_pinned() {
        let approved = B256::repeat_byte(0xab);
        let c = proxy_cfg(Some(vec![format!("{approved:#x}")]));
        assert!(check_proxy_approved(&proxied(approved), &c, "vault", VAULT).is_ok());
        match check_proxy_approved(&proxied(B256::repeat_byte(0xcd)), &c, "vault", VAULT) {
            Err(RmpcError::ErrImplementationNotApproved { proxy, reason, .. }) => {
                assert_eq!(proxy, format!("vault {VAULT:#x}"));
                assert!(
                    reason.contains("not in proxy_implementation_hashes"),
                    "{reason}"
                );
            }
            other => panic!("expected ErrImplementationNotApproved, got {other:?}"),
        }
        match check_proxy_approved(&proxied(approved), &proxy_cfg(None), "vault", VAULT) {
            Err(RmpcError::ErrImplementationNotApproved { reason, .. }) => {
                assert!(reason.contains("not set"), "{reason}")
            }
            other => panic!("expected ErrImplementationNotApproved, got {other:?}"),
        }
    }

    #[test]
    fn a_gateway_pin_does_not_approve_a_vault_implementation() {
        let h = B256::repeat_byte(0xab);
        let c = Config {
            gateway_implementation_hashes: Some(vec![format!("{h:#x}")]),
            ..proxy_cfg(Some(vec![format!("{:#x}", B256::repeat_byte(0x01))]))
        };
        assert!(check_proxy_approved(&proxied(h), &c, "vault", VAULT).is_err());
    }

    #[test]
    fn a_malformed_pin_is_a_config_error() {
        let r = check_approved(
            &proxied(B256::repeat_byte(0xab)),
            &cfg(Some(vec!["0x1234".into()])),
        );
        assert!(matches!(r, Err(RmpcError::ErrConfig(_))), "{r:?}");
    }
}
