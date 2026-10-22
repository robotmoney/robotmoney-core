# Safety and refusal cases

`rmpc` is structured so that **every refusal is intentional**: a hard,
non-zero exit with a named error rather than an advisory warning. The agent
must surface refusals — not suppress them — and never retry a refused write
without the underlying state changing first.

This document maps every refusal to its source in the implementation plan.

## Preflight refusals (implementation-plan §4.4)

Before signing any deposit transaction, the client RPC-reads:

- `gateway.depositsPaused()`, and `depositsPaused()` on the vault
- `gateway.agents(self_addr)` (active, validUntil, caps, shareReceiver)
- `gateway.agentOwner(self_addr)`, when the config pins `agent_owner`
- `gateway.effectiveDepositWindowGross(self_addr)`
- `usdc.allowance(self, gateway)`
- `usdc.balanceOf(self)`
- `eth_chainId` matches the configured `chain_id`
- `keccak256(eth_getCode(gateway))` matches the configured
  `gateway_runtime_hash`
- the gateway's ERC-1967 implementation slot names the configured
  `gateway_implementation`, and that implementation's code hash matches
  `gateway_implementation_runtime_hash`
- when the vault the write reaches is a proxy:
  its implementation's code hash is listed in `proxy_implementation_hashes`
- the requested vault (`--vault`, default `vault_address`): it must be in the policy's selected destinations (`allowed_destinations`), and its pause state and implementation are read

Every read runs at one pinned block. The same gateway check runs before
any write signs.

Every refusal prints one JSON document on stdout with `"status":"refused"`
and the name in `error`, and exits 2. Match on `error`, never on `message`.

| Condition | Error code | Meaning |
|---|---|---|
| `depositsPaused() == true` on the gateway or the vault | `ErrDepositsPaused` | New deposits are halted by `DEPOSIT_PAUSER_ROLE`; only `ADMIN_ROLE` can unpause. Deposits only: a withdrawal is never refused for a pause. |
| Agent record missing or `active == false` | `ErrAgentNotAuthorized` | This address is not (or no longer) an authorized agent. |
| `agents(self).shareReceiver` differs from the config's `share_receiver`, or `agentOwner(self)` differs from its `agent_owner` | `ErrAgentBindingMismatch` | Someone other than the operator bound this agent address, so its deposits would mint shares to them. Do not retry. Tell the operator. Checked only when the config pins the value. |
| `validUntil < now` | `ErrPolicyExpired` | The authorization has expired; its owner must re-authorize. |
| `amount > maxPerPayment` | `ErrDepositCapExceeded` | Operator-set per-payment cap. The message names `maxPerPayment`. |
| `windowGross + amount > maxPerWindow` | `ErrDepositCapExceeded` | Operator-set rolling 24h cap. The message names `maxPerWindow`. |
| `usdc.allowance(self, gateway) < amount` | `ErrAllowanceInsufficient` | Approve the gateway for at least `amount`. |
| `usdc.balanceOf(self) < amount` | `ErrBalanceInsufficient` | Fund the agent's USDC balance. |
| `eth_chainId != config.chain_id` | `ErrChainIdMismatch` | The RPC endpoint is on the wrong chain. |
| `keccak256(eth_getCode(gateway)) != gateway_runtime_hash` | `ErrCodeHashMismatch` | The deployed gateway bytecode does not match the pinned hash. |
| The implementation slot names another address, the implementation code hash differs, a proxy has no approved implementation configured, or an approved implementation is configured for a gateway with an empty slot | `ErrImplementationNotApproved` | The gateway proxy points at logic the operator did not approve. The proxy hash can still match. |
| The implementation slot or the implementation code cannot be read | `ErrImplementationUnverified` | The client cannot prove which logic would run. It never signs on an unverified implementation. |
| The implementation changed after preflight (the signed transaction is discarded unsent), or the transaction executed under another implementation (carries `tx_hash`) | `ErrImplementationChanged` | Review what changed before any retry. A write that executed is not reported as a success. |
| The vault the write reaches is a proxy and its implementation's code hash is not in `proxy_implementation_hashes` (or the key is missing) | `ErrImplementationNotApproved` | Same as above, for that contract: the message names it (`vault 0x…`, `router 0x…`). Do not retry. Tell the operator. |

## Destination refusals

| Condition | Error code | Meaning |
|---|---|---|
| `--vault` is not in the agent's selected destinations, or the gateway reverts `InvalidDestination` | `ErrDestinationNotSelected` | The depositor did not select this vault. Nothing is signed. Ask the depositor to update the policy. |

## Simulation refusals

After the preflight, every write runs its exact calldata as an `eth_call`
from the agent. A revert with a known reason is refused by name before
anything is signed, so no gas is spent. The message names the contract error.

| Simulated revert | Error code | Meaning |
|---|---|---|
| `AgentPolicyExpired` | `ErrPolicyExpired` | Expired by chain time. |
| `VaultNotRegistered`, `RedeemVaultNotRegistered`, `VaultNotActive` (Retired), `VaultRetired`, `VaultShutdown` | `ErrVaultDisabled` | The target vault is not registered or is disabled. A retired vault is withdraw-only through its own `redeem`. |
| `AmountExceedsPerPaymentCap`, `WindowCapExceeded` | `ErrDepositCapExceeded` | As in the preflight table. |

Any other simulated revert is not named. The transaction is sent. If it then
reverts on chain the refusal is `ErrTxReverted` with the `tx_hash`.

A proxied gateway's own code hash never changes when it is upgraded, so
`gateway_runtime_hash` alone cannot detect an upgrade. An approved upgrade
means updating `gateway_implementation` and
`gateway_implementation_runtime_hash` from the new release manifest. A
direct (non-proxy) gateway sets neither. A proxied vault, router or router
leg is pinned the same way through `proxy_implementation_hashes`. The client
refuses to sign on any mismatch — this is not advisory.

## Nonce lock refusal (implementation-plan §4.6)

| Condition | Error code | Meaning |
|---|---|---|
| Another `rmpc deposit` holds the file lock at `$RMPC_STATE_DIR/agent-<address>.lock` | `ErrConcurrentInvocation` | The MVP CLI is single-flight per agent. Wait for the in-flight invocation to complete (broadcast and receipt or named error). |

The lock spans
`(eth_getTransactionCount → sign → broadcast → receipt)`. A full nonce
manager (pending-tx queue, replacement, gap recovery) is v1 work.

## Gas limit refusal

| Condition | Error code | Meaning |
|---|---|---|
| `--gas-limit` below the gateway entry floor for the deposit | `ErrGasLimitBelowFloor` | The gateway checks `gasleft()` at entry: 2,000,000 for a vault deposit, 400,000 + 2,550,000 per `getEffectiveWeights()` leg for a router deposit. Below it the deposit reverts `InsufficientGas` and burns the gas, so the client refuses before signing. Omit `--gas-limit` to use the derived default. |

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
| Software signer selected but `[signer].allow_software_fallback != true` | `ErrSoftwareSignerDisallowed` | The binary exits before any RPC. |
| Encrypted keystore decryption fails (bad passphrase) | `ErrKeystoreDecrypt` | Exit 3 with no JSON on stdout; the name is in the log. No retry; re-run with the correct passphrase in `RMPC_KEYSTORE_PASSPHRASE`. |

Plaintext key material is held only for the duration of the
`sign_eip1559_hash` call and zeroized via `zeroize` afterward. The
`AgentSigner` trait does not expose `sign_hash`, `sign_message`, or
`sign_typed_data`; the only hash that can reach a backend is the EIP-1559
envelope hash for a typed `GatewayTxRequest` constructed inside the `tx`
module. Future backends cannot widen this.

## Replay refusals

| Condition | Error code | Meaning |
|---|---|---|
| This client already sent the same `(orderId, amount, idempotencyKey)` | `ErrOrderIdAlreadySubmitted` | The local replay cache refuses before signing and returns the prior `tx_hash`. Use `rmpc status --payment-id <id>` to confirm. |
| `paymentId` already used on chain (`PaymentIdAlreadyUsed`) | `ErrTxReverted` | The contract has already processed this `(chain_id, gateway, agent, orderId, amount, idempotencyKey)` tuple. Use `rmpc status --payment-id <id>` to confirm. |

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
| `production_base`  | 8453     | Production Base mainnet            |
| `unknown`          | other    | Unrecognised chain                 |

Agents MUST include the `network_env` label in every summarized response.
When `network_env == "production_base"`, agents MUST emit the production
warning before any write action. Unknown chain ids must be reported verbatim;
they do not bypass chain-id or code-hash checks.

## Operator surfaces

These refusals are not the agent's to override:

- Pause / unpause deposits: `DEPOSIT_PAUSER_ROLE` and `ADMIN_ROLE` only.
- Cap changes, share-receiver changes, agent authorization: `ADMIN_ROLE`
  only, via the human dapp (implementation-plan §12).
- Code-hash rotation: redeploy + operator config bump. The client has no
  "skip" flag and will not gain one.
