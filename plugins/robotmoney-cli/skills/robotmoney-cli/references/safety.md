# Safety and refusal cases

`rmpc` is structured so that **every refusal is intentional**: a hard,
non-zero exit with a named error rather than an advisory warning. The agent
must surface refusals — not suppress them — and never retry a refused write
without the underlying state changing first.

This document maps every refusal to its source in the implementation plan.

## Preflight refusals (implementation-plan §4.4)

Before signing any deposit transaction, the client RPC-reads:

- `gateway.paused()`
- `gateway.agents(self_addr)` (active, validUntil, caps, shareReceiver)
- `usdc.allowance(self, gateway)`
- `usdc.balanceOf(self)`
- `eth_chainId` matches the configured `chain_id`
- `keccak256(eth_getCode(gateway))` matches the configured
  `gateway_runtime_hash`

| Condition | Error code | Meaning |
|---|---|---|
| `gateway.paused() == true` | `ErrGatewayPaused` | Operations are halted by `PAUSER_ROLE`; only `ADMIN_ROLE` can unpause. |
| Agent record missing or `active == false` | `ErrAgentNotAuthorized` | This address is not (or no longer) an authorized agent. |
| `validUntil < block.timestamp` | `ErrAgentExpired` | The authorization has expired; ADMIN must re-authorize. |
| `amount > maxPerPayment` | `ErrPerPaymentCapExceeded` | Operator-set per-payment cap. |
| `windowGross + amount > maxPerWindow` | `ErrPerWindowCapExceeded` | Operator-set per-window (24h) cap. |
| `usdc.balanceOf(self) < amount` | `ErrInsufficientBalance` | Fund the agent's USDC balance. |
| `usdc.allowance(self, gateway) < amount` | `ErrInsufficientAllowance` | Approve the gateway for at least `amount`. |
| `eth_chainId != config.chain_id` | `ErrChainIdMismatch` | The RPC endpoint is on the wrong chain. |
| `keccak256(eth_getCode(gateway)) != gateway_runtime_hash` | `ErrCodeHashMismatch` | The deployed gateway bytecode does not match the pinned hash. |

The MVP gateway is non-upgradeable, so the legitimate path for
`gateway_runtime_hash` to change is a v1 redeployment plus an operator
config bump. The client refuses to sign on mismatch — this is not advisory.

## Nonce lock refusal (implementation-plan §4.6)

| Condition | Error code | Meaning |
|---|---|---|
| Another `rmpc deposit` holds the file lock at `$RMPC_STATE_DIR/agent-<address>.lock` | `ErrConcurrentInvocation` | The MVP CLI is single-flight per agent. Wait for the in-flight invocation to complete (broadcast and receipt or named error). |

The lock spans
`(eth_getTransactionCount → sign → broadcast → receipt)`. A full nonce
manager (pending-tx queue, replacement, gap recovery) is v1 work.

## Fee cap refusal (implementation-plan §4.7)

| Condition | Error code | Meaning |
|---|---|---|
| Computed `maxFeePerGas > config.max_fee_per_gas_cap` | `ErrFeeCapExceeded` | Network base fee or priority fee would exceed operator policy. The cap is operator policy, not best-effort. |

`maxFeePerGas = min(2 * baseFee + priorityFee, max_fee_per_gas_cap)`,
where `priorityFee = max(p50_last_5_blocks, 1 gwei)`. Default cap is 100
gwei for MVP devnet runs; mainnet operators on L2s should set it
substantially lower so the cap is loud when it fires.

## Signer-backend refusals

| Condition | Error code | Meaning |
|---|---|---|
| Software signer selected but `[signer].allow_software_fallback != true` | `ErrSoftwareFallbackDisabled` | The binary exits before any RPC. |
| Encrypted keystore decryption fails (bad passphrase) | `ErrSignerUnlock` | No retry; re-run with the correct passphrase from env or stdin. |
| Public address derived from the keystore does not match the configured agent address | `ErrSignerAddressMismatch` | Wrong key for this config; do not proceed. |

Plaintext key material is held only for the duration of the
`sign_eip1559_hash` call and zeroized via `zeroize` afterward. The
`AgentSigner` trait does not expose `sign_hash`, `sign_message`, or
`sign_typed_data`; the only hash that can reach a backend is the EIP-1559
envelope hash for a typed `GatewayTxRequest` constructed inside the `tx`
module. Future backends cannot widen this.

## Replay refusals

| Condition | Error code | Meaning |
|---|---|---|
| `paymentId` already used (`usedPaymentIds[paymentId] == true`) | `DepositIdAlreadyUsed` | The contract has already processed this `(chain_id, gateway, agent, orderId, amount, idempotencyKey)` tuple. Use `rmpc status --payment-id <id>` to confirm. |

`paymentId = keccak256(abi.encode(chain_id, gateway, agent, orderId, amount,
idempotencyKey))`. **`deadline` is intentionally excluded from the hash** so
that re-running with the same intent collapses to the same identity and is
rejected by the contract. Deadline is a liveness parameter, not an identity
parameter.

## Fork-vs-mainnet warning

The default operating mode is fork or local devnet. Mainnet operation must be
an explicit operator action expressed in the config:

- The agent must not silently switch chains. If the running config's
  `chain_id` differs from the agent's expected default, refuse and surface
  the discrepancy.
- On startup, `rmpc` emits a high-severity log line if `chain_id` matches a
  known mainnet network or if the software signer fallback is in use. The
  agent should propagate that log line to the operator surface.
- `gateway_runtime_hash` mismatches on mainnet are especially serious: do
  not retry, do not "wait and see", do not advise the user to disable the
  check. Surface and stop.

## Network environment label

All `rmpc` outputs include a machine-readable `network_env` field derived from
the chain id at query time. The stable string values are:

| `network_env`      | Chain id | Description                        |
|--------------------|----------|------------------------------------|
| `local_devnet`     | 31337    | Anvil / local devnet               |
| `rm_testnet`       | 84532    | Robot Money testnet (Base Sepolia) |
| `production_base`  | 8453     | Production Base mainnet            |
| `unknown`          | other    | Unrecognised chain                 |

Agents MUST include the `network_env` label in every summarized response.
When `network_env == "production_base"`, agents MUST emit the production
warning before any write action. Unknown chain ids must be reported verbatim;
they do not bypass chain-id or code-hash checks.

## Operator surfaces

These refusals are not the agent's to override:

- Pause / unpause: `PAUSER_ROLE` and `ADMIN_ROLE` only.
- Cap changes, share-receiver changes, agent authorization: `ADMIN_ROLE`
  only, via the human dapp (implementation-plan §12).
- Code-hash rotation: redeploy + operator config bump. The client has no
  "skip" flag and will not gain one.
