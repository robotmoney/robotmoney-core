//! Canonical: docs/technical/contract-upgradeability-plan.md — Release modes and proof
//! (See also: docs/technical/security-model.md §13; issue 1810)
//!
//! Gateway code verification for every signed write.
//!
//! The gateway runs behind an ERC-1967 proxy (issue 1808). The proxy's own
//! runtime code never changes, so the `gateway_runtime_hash` pin alone cannot
//! see an upgrade: the same proxy hash can front an implementation nobody
//! reviewed. Before any signature, rmpc therefore checks three things at ONE
//! pinned block:
//!
//! 1. `keccak256(eth_getCode(gateway)) == gateway_runtime_hash` (the proxy).
//! 2. The ERC-1967 implementation slot names exactly `gateway_implementation`.
//! 3. `keccak256(eth_getCode(implementation)) == gateway_implementation_runtime_hash`.
//!
//! The rules fail closed:
//!
//! - a set slot with no approved implementation configured refuses
//!   (`ErrImplementationNotApproved`);
//! - an approved implementation configured for a gateway whose slot is empty
//!   refuses (the address is not the proxy the operator approved);
//! - a failed slot or implementation-code read refuses
//!   (`ErrImplementationUnverified`);
//! - a gateway with an empty slot and no approved implementation is a direct
//!   (non-proxy) deployment, checked by the code-hash pin alone as before.
//!
//! Only chain reads authorize a write. Nothing here consults the explorer
//! indexer or any other cache.
//!
//! # The other proxies a write reaches
//!
//! The vaults are ERC-1967 proxies too (issue 1808). The
//! address pin (`vault_address`) does
//! not pin the logic behind a proxy, so a write also reads the implementation
//! of the vault it reaches and refuses unless that
//! implementation's code hash is in `proxy_implementation_hashes`
//! ([`verify_reached_proxy`]): the requested vault a deposit lands in. A direct (non-proxy) contract needs no entry:
//! its address pin covers its whole code. The same fail-closed rules apply:
//! a failed read is `ErrImplementationUnverified`, an unlisted, codeless or
//! unpinned implementation is `ErrImplementationNotApproved` naming the proxy
//! (QA plan P3, security review findings review-security-008 and -016).

use std::str::FromStr;

use alloy_primitives::{b256, keccak256, Address, B256};
use alloy_sol_types::SolCall;

use crate::config::Config;
use crate::errors::{Result, RmpcError};
use crate::rpc::{CallRequest, FailoverRpcClient};

/// ERC-1967 implementation slot:
/// `bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`.
pub const ERC1967_IMPLEMENTATION_SLOT: B256 =
    b256!("360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");

/// The operator-approved gateway implementation, from the config pair
/// `gateway_implementation` + `gateway_implementation_runtime_hash`.
/// `None` when neither is set (a direct gateway). Setting only one is a
/// configuration error.
pub fn approved_gateway_implementation(cfg: &Config) -> Result<Option<(Address, B256)>> {
    match (
        cfg.gateway_implementation.as_deref(),
        cfg.gateway_implementation_runtime_hash.as_deref(),
    ) {
        (None, None) => Ok(None),
        (Some(addr), Some(hash)) => {
            let addr = Address::from_str(addr)
                .map_err(|e| RmpcError::ErrConfig(format!("gateway_implementation: {e}")))?;
            let hash = parse_b256(hash, "gateway_implementation_runtime_hash")?;
            Ok(Some((addr, hash)))
        }
        _ => Err(RmpcError::ErrConfig(
            "gateway_implementation and gateway_implementation_runtime_hash must be set together"
                .to_string(),
        )),
    }
}

/// Read the ERC-1967 implementation slot of `proxy` at `block_tag`. `None`
/// when the slot is zero (no proxy). A failed read, or a slot word that is
/// not an address, is `ErrImplementationUnverified`.
pub async fn read_implementation(
    rpc: &FailoverRpcClient,
    proxy: Address,
    block_tag: &str,
) -> Result<Option<Address>> {
    let word = rpc
        .get_storage_at(proxy, ERC1967_IMPLEMENTATION_SLOT, Some(block_tag))
        .await
        .map_err(|e| {
            RmpcError::ErrImplementationUnverified(format!(
                "eth_getStorageAt({proxy:#x}, ERC-1967 implementation slot, {block_tag}): {e}"
            ))
        })?;
    if word[..12].iter().any(|b| *b != 0) {
        return Err(RmpcError::ErrImplementationUnverified(format!(
            "the ERC-1967 implementation slot of {proxy:#x} holds {word:#x}, which is not an address"
        )));
    }
    let implementation = Address::from_slice(&word[12..]);
    Ok((implementation != Address::ZERO).then_some(implementation))
}

/// Verify the gateway proxy code AND its live implementation at
/// `block_tag`. Returns the verified implementation (`None` for a direct
/// gateway). See the module docs for the rules.
pub async fn verify_gateway_code(
    rpc: &FailoverRpcClient,
    cfg: &Config,
    block_tag: &str,
) -> Result<Option<Address>> {
    let gateway = Address::from_str(&cfg.gateway_address)
        .map_err(|e| RmpcError::ErrConfig(format!("gateway_address: {e}")))?;
    let approved = approved_gateway_implementation(cfg)?;

    // 1. The proxy (or direct gateway) code pin.
    let code = rpc.get_code(gateway, Some(block_tag)).await?;
    if code.is_empty() {
        return Err(RmpcError::ErrCodeHashMismatch);
    }
    let expected = parse_b256(&cfg.gateway_runtime_hash, "gateway_runtime_hash")?;
    if keccak256(code.as_ref()) != expected {
        return Err(RmpcError::ErrCodeHashMismatch);
    }

    // 2–3. The implementation behind it.
    let live = read_implementation(rpc, gateway, block_tag).await?;
    match (live, approved) {
        (None, None) => Ok(None),
        (None, Some((approved, _))) => Err(RmpcError::ErrImplementationNotApproved(format!(
            "gateway {gateway:#x} has no ERC-1967 implementation, but gateway_implementation = \
             {approved:#x} is configured"
        ))),
        (Some(live), None) => Err(RmpcError::ErrImplementationNotApproved(format!(
            "gateway {gateway:#x} is a proxy for implementation {live:#x}, and no \
             gateway_implementation is approved in the config"
        ))),
        (Some(live), Some((approved, approved_hash))) => {
            if live != approved {
                return Err(RmpcError::ErrImplementationNotApproved(format!(
                    "gateway {gateway:#x} points at implementation {live:#x}, not the approved \
                     {approved:#x}"
                )));
            }
            let impl_code = rpc.get_code(live, Some(block_tag)).await.map_err(|e| {
                RmpcError::ErrImplementationUnverified(format!(
                    "eth_getCode({live:#x}, {block_tag}): {e}"
                ))
            })?;
            if impl_code.is_empty() {
                return Err(RmpcError::ErrImplementationNotApproved(format!(
                    "implementation {live:#x} has no code"
                )));
            }
            let live_hash = keccak256(impl_code.as_ref());
            if live_hash != approved_hash {
                return Err(RmpcError::ErrImplementationNotApproved(format!(
                    "implementation {live:#x} code hash {live_hash:#x} differs from \
                     gateway_implementation_runtime_hash {approved_hash:#x}"
                )));
            }
            Ok(Some(live))
        }
    }
}

/// [`verify_gateway_code`] at a freshly pinned block, for the writes that
/// run no gateway preflight (`committee vote-submit`, `receipt submit`).
pub async fn verify_gateway_code_now(
    rpc: &FailoverRpcClient,
    cfg: &Config,
) -> Result<Option<Address>> {
    let block = rpc.block_number().await?;
    verify_gateway_code(rpc, cfg, &format!("0x{block:x}")).await
}

/// After signing, before broadcast: `Ok` when the gateway at `latest` still
/// runs the `bound` implementation it was verified against before signing,
/// and still passes [`verify_gateway_code`]. Otherwise the caller discards
/// the signed envelope unsent (`ErrImplementationChanged`, or the
/// verification's own error). Every gateway write calls this between signing
/// and broadcast: [`crate::write_path::WriteSession::submit`],
/// `committee vote-submit` and `receipt submit` (issue 1856).
pub async fn reverify_gateway_after_signing(
    rpc: &FailoverRpcClient,
    cfg: &Config,
    gateway: Address,
    bound: Option<Address>,
) -> Result<()> {
    let live = read_implementation(rpc, gateway, "latest").await?;
    if live != bound {
        return Err(RmpcError::ErrImplementationChanged(format!(
            "gateway implementation changed from {} to {} after preflight; the signed \
             transaction was discarded unsent",
            fmt_implementation(bound),
            fmt_implementation(live)
        )));
    }
    verify_gateway_code(rpc, cfg, "latest").await.map(|_| ())
}

/// After signing, before broadcast: `Ok` when the requested vault still runs
/// the `bound` implementation preflight verified, and still passes
/// [`verify_reached_proxy`] at `latest`. Otherwise the caller discards the
/// signed envelope unsent (`ErrImplementationChanged`, or the verification's
/// own error).
pub async fn reverify_vault_after_signing(
    rpc: &FailoverRpcClient,
    cfg: &Config,
    vault: Address,
    bound: Option<Address>,
) -> Result<()> {
    let live = read_implementation(rpc, vault, "latest").await?;
    if live != bound {
        return Err(RmpcError::ErrImplementationChanged(format!(
            "vault {vault:#x} implementation changed from {} to {} after preflight; the signed \
             transaction was discarded unsent",
            fmt_implementation(bound),
            fmt_implementation(live)
        )));
    }
    verify_reached_proxy(rpc, cfg, "vault", vault, "latest").await
}

/// Reads of the executed block: a load-balanced RPC can return the receipt
/// from one node and answer the next read from a node that has not reached
/// its block yet ("block not found", Deploy 3 P6.55 on mainnet.base.org). A
/// failed read is retried this many times, one second apart, before it
/// refuses.
pub const EXECUTED_BLOCK_READ_ATTEMPTS: u32 = 10;

/// After a write executed: `Ok` when the gateway implementation in the
/// transaction's block is the `bound` one it was signed against. Otherwise
/// `ErrImplementationChanged` (or `ErrImplementationUnverified` when the slot
/// cannot be read after [`EXECUTED_BLOCK_READ_ATTEMPTS`] tries, or the
/// receipt has no block), so the caller never reports a write that ran under
/// another implementation as a success.
pub async fn check_executed_under(
    rpc: &FailoverRpcClient,
    gateway: Address,
    bound: Option<Address>,
    block: Option<u64>,
    tx_hash: &str,
) -> Result<()> {
    let block = block.ok_or_else(|| {
        RmpcError::ErrImplementationUnverified(format!(
            "the receipt of {tx_hash} has no block number"
        ))
    })?;
    let tag = format!("0x{block:x}");
    let mut attempt = 1;
    let live = loop {
        match read_implementation(rpc, gateway, &tag).await {
            Ok(live) => break live,
            Err(e) if attempt >= EXECUTED_BLOCK_READ_ATTEMPTS => return Err(e),
            Err(e) => {
                log::warn!("implementation read at the executed block {block} failed (attempt {attempt}), retrying: {e}");
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    };
    if live == bound {
        return Ok(());
    }
    Err(RmpcError::ErrImplementationChanged(format!(
        "transaction {tx_hash} executed in block {block} while the gateway implementation was \
         {}, not the verified {}",
        fmt_implementation(live),
        fmt_implementation(bound)
    )))
}

/// An implementation for a message: the address, or "none (direct gateway)".
pub fn fmt_implementation(implementation: Option<Address>) -> String {
    implementation.map_or_else(
        || "none (direct gateway)".to_string(),
        |a| format!("{a:#x}"),
    )
}

/// `proxy_implementation_hashes`, parsed. `None` when the key is absent.
pub fn approved_proxy_hashes(cfg: &Config) -> Result<Option<Vec<B256>>> {
    let Some(list) = cfg.proxy_implementation_hashes.as_ref() else {
        return Ok(None);
    };
    list.iter()
        .enumerate()
        .map(|(i, h)| parse_b256(h, &format!("proxy_implementation_hashes[{i}]")))
        .collect::<Result<Vec<_>>>()
        .map(Some)
}

/// Verify one vault or router (`role`, e.g. `"vault"`, `"router"`,
/// `"router leg vault"`) a write reaches, at `block_tag`. A direct contract
/// (empty slot) passes: its address pin covers its whole code. A proxy passes
/// only when its implementation has code whose hash is in
/// `proxy_implementation_hashes`. See the module docs.
pub async fn verify_reached_proxy(
    rpc: &FailoverRpcClient,
    cfg: &Config,
    role: &str,
    proxy: Address,
    block_tag: &str,
) -> Result<()> {
    let approved = approved_proxy_hashes(cfg)?;
    let Some(live) = read_implementation(rpc, proxy, block_tag).await? else {
        return Ok(());
    };
    let label = format!("{role} {proxy:#x}");
    let impl_code = rpc.get_code(live, Some(block_tag)).await.map_err(|e| {
        RmpcError::ErrImplementationUnverified(format!(
            "eth_getCode({live:#x}, {block_tag}) for the {label} implementation: {e}"
        ))
    })?;
    check_reached_proxy(&label, live, impl_code.as_ref(), approved.as_deref())
}

/// The pure rule of [`verify_reached_proxy`] for a proxy (`label`) whose
/// slot names `live`, whose code is `impl_code`, against the approved list
/// (`None` when `proxy_implementation_hashes` is unset).
pub fn check_reached_proxy(
    label: &str,
    live: Address,
    impl_code: &[u8],
    approved: Option<&[B256]>,
) -> Result<()> {
    if impl_code.is_empty() {
        return Err(RmpcError::ErrImplementationNotApproved(format!(
            "{label} is a proxy for implementation {live:#x}, which has no code"
        )));
    }
    let live_hash = keccak256(impl_code);
    match approved {
        None => Err(RmpcError::ErrImplementationNotApproved(format!(
            "{label} is a proxy for implementation {live:#x} (code hash {live_hash:#x}) and \
             proxy_implementation_hashes is not set; pin the reviewed implementation's code hash"
        ))),
        Some(list) if !list.contains(&live_hash) => {
            Err(RmpcError::ErrImplementationNotApproved(format!(
                "{label} implementation {live:#x} code hash {live_hash:#x} is not in \
                 proxy_implementation_hashes"
            )))
        }
        Some(_) => Ok(()),
    }
}

/// One `eth_call` at `tag`, decoded. A revert or a transport error is `Err`.
async fn call_at<C: SolCall>(
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

/// Parse a 0x-prefixed (or bare) 32-byte hex config value.
pub(crate) fn parse_b256(s: &str, field: &str) -> Result<B256> {
    let stripped = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(stripped).map_err(|e| RmpcError::ErrConfig(format!("{field}: {e}")))?;
    if bytes.len() != 32 {
        return Err(RmpcError::ErrConfig(format!(
            "{field}: expected 32 bytes, got {}",
            bytes.len()
        )));
    }
    Ok(B256::from_slice(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::address;

    const IMPL: Address = address!("00000000000000000000000000000000000001a1");
    const CODE: &[u8] = &[0x60, 0x80, 0x60, 0x40];

    fn refusal(r: Result<()>) -> String {
        match r {
            Err(RmpcError::ErrImplementationNotApproved(m)) => m,
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

    /// The vault behind the gateway is a proxy: its address pin matches, yet
    /// an unlisted implementation is refused, and so is a missing
    /// `proxy_implementation_hashes`. The refusal names the vault.
    #[test]
    fn a_proxied_vault_needs_its_implementation_pinned() {
        let approved = [keccak256(CODE)];
        assert!(check_reached_proxy("vault 0xd00", IMPL, CODE, Some(&approved)).is_ok());
        let other = [B256::repeat_byte(0xcd)];
        let m = refusal(check_reached_proxy("vault 0xd00", IMPL, CODE, Some(&other)));
        assert!(m.starts_with("vault 0xd00"), "{m}");
        assert!(m.contains("not in proxy_implementation_hashes"), "{m}");
        let m = refusal(check_reached_proxy("vault 0xd00", IMPL, CODE, None));
        assert!(m.contains("not set"), "{m}");
    }

    #[test]
    fn an_implementation_without_code_is_refused_even_when_its_hash_is_listed() {
        let empty = [keccak256(b"")];
        let m = refusal(check_reached_proxy("router 0xr", IMPL, &[], Some(&empty)));
        assert!(m.contains("no code"), "{m}");
    }
}
