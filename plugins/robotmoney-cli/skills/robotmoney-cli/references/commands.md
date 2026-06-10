# rmpc command reference

Complete flag reference for all `rmpc` subcommands. Every command requires
`--config <CONFIG>` unless noted.

## Read commands

### `rmpc self-check`

Print the signer-backend self-check report.

```
rmpc self-check --config <CONFIG> [--pretty]
```

### `rmpc get-vault`

Read vault state directly from chain.

```
rmpc get-vault --config <CONFIG> [--address <ADDR>] [--pretty]
```

### `rmpc get-vaults`

List all vaults registered in the VaultRegistry.

```
rmpc get-vaults --config <CONFIG> [--pretty]
```

### `rmpc get-router`

Read PortfolioRouter state: vault addresses, weight bps, and router cap.

```
rmpc get-router --config <CONFIG> [--pretty]
```

### `rmpc get-governance`

Read RouterGovernance state: active proposal, cadence params, and weights.
Requires `governance_address` in config.

```
rmpc get-governance --config <CONFIG> [--pretty]
```

Output includes: `proposal_id`, `voting_deadline`, `proposed_vaults`,
`proposed_bps`, `votes_for`, `votes_against`, `votes_abstain`.

### `rmpc get-timelock`

Read TimelockController state.

```
rmpc get-timelock --config <CONFIG> [--pretty]
```

### `rmpc get-gateway`

Read gateway state directly from chain.

```
rmpc get-gateway --config <CONFIG> [--pretty]
```

### `rmpc get-agent`

Read an agent's authorization + window usage.

```
rmpc get-agent --config <CONFIG> --agent <ADDR> [--pretty]
```

### `rmpc get-roles`

Read role membership on the gateway for a target address.

```
rmpc get-roles --config <CONFIG> --address <ADDR> [--pretty]
```

### `rmpc get-balance`

Read an ERC-20 token balance for an address (USDC by default).

```
rmpc get-balance --config <CONFIG> --address <ADDR> [--pretty]
```

### `rmpc get-allowance`

Read an ERC-20 allowance(owner, spender) on the configured USDC.

```
rmpc get-allowance --config <CONFIG> --owner <ADDR> --spender <ADDR> [--pretty]
```

### `rmpc get-deposit`

Look up a gateway deposit by its on-chain id.

```
rmpc get-deposit --config <CONFIG> --deposit-id <ID> [--pretty]
```

### `rmpc get-tx`

Look up a transaction's receipt status by hash.

```
rmpc get-tx --config <CONFIG> --tx-hash <HASH>
  [--op-class <CLASS>] [--require-finality <LEVEL>] [--pretty]
```

The response includes a `finality` object (`status`, `confirmations`,
`required_confirmations`, `op_class`) derived from the per-operation-class
confirmation-depth policy (security-model.md §12). `--op-class` is one of
`deposit` (default), `withdraw`, `vault_rebalance`, `admin_governance`.
`--require-finality` (`l2_included` | `l1_finalized`) makes the command
exit with code 5 (`ErrFinalityNotMet`) when the threshold has not been
met; the JSON is still emitted.

## Write commands

### `rmpc deposit`

Sign and broadcast a USDC deposit through the gateway.

```
rmpc deposit --config <CONFIG> --amount <UNITS> --order-id <HEX>
  [--idempotency-key <HEX>] [--deadline-secs <N>]
  [--receipt-timeout-secs <N>] [--gas-limit <N>] [--fee-cap <WEI>]
  [--pretty]
```

### `rmpc withdraw`

Redeem vault shares through the gateway (agent-initiated redemption).

```
rmpc withdraw --config <CONFIG> --shares <N> --source-vault <ADDR>
  --order-id <HEX> [--idempotency-key <HEX>] [--deadline-secs <N>]
  [--receipt-timeout-secs <N>] [--gas-limit <N>] [--fee-cap <WEI>]
  [--pretty]
```

### `rmpc withdraw-router`

Redeem vault shares via the Portfolio Router (multi-vault proportional
redemption, agent-initiated). Calls
`gateway.withdrawFromRouter(orderId, sharesPerLeg, deadline, idempotencyKey)`.
USDC lands at the policy-configured `assetRecipient`; no shares pass through
the gateway. Requires `--confirm` to proceed past the preview.

Run `rmpc get-router` first to inspect the router's current vault order and
decide per-leg share amounts.

```
rmpc withdraw-router --config <CONFIG>
  --shares-per-leg <N,N,...> --order-id <HEX>
  [--idempotency-key <HEX>] [--deadline-secs <N>]
  [--receipt-timeout-secs <N>] [--gas-limit <N>] [--fee-cap <WEI>]
  --confirm [--pretty]
```

### `rmpc status`

Look up a previously submitted payment by its on-chain `paymentId`.

```
rmpc status --config <CONFIG> --payment-id <HEX> [--pretty]
```

## Governance write commands

### `rmpc propose`

Submit a new weight-reallocation proposal to `RouterGovernance.propose()`.
Requires `governance_address` in config and a configured signer.

```
rmpc propose --config <CONFIG> --vaults <ADDR,...> --weights-bps <BPS,...>
  [--gas-limit <N>] [--fee-cap <WEI>] [--receipt-timeout-secs <N>]
  [--pretty]
```

### `rmpc vote`

Cast a vote on an active `RouterGovernance` proposal.
Requires `governance_address` in config and a configured signer.

```
rmpc vote --config <CONFIG> --proposal-id <ID> --choice yes|no|abstain
  [--gas-limit <N>] [--fee-cap <WEI>] [--receipt-timeout-secs <N>]
  [--pretty]
```

`--choice yes` submits `vote(proposalId)` on-chain. `no` and `abstain` are
client-side no-ops (the contract only records FOR votes). Re-calling with the
same choice after a `yes` vote exits 0 (idempotent). A different choice after
an on-chain `yes` exits 2 with `ErrVoteAlreadyCast`.
