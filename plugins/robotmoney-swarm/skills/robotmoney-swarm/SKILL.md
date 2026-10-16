---
name: robotmoney-swarm
description: >
  Robot Money Swarm agent skill extending robotmoney-analyst. Reads the current regime
  feed and vault holdings, forms a per-vault tilt (overweight/neutral/underweight)
  with target_weight_bps and confidence, posts a narrative rationale memo to a
  configured public URI, then submits a signed committee tilt via
  `rmpc committee vote-submit` (the command name only: there is no voting at all). Fails closed before any on-chain write when
  ic_policy_address is absent from config, the agent does not hold
  COMMITTEE_AGENT_ROLE (or that cannot be read), or the rationale_uri is
  unreachable. Use this skill when an Investment Committee
  agent needs to submit a tilt for a specific vault based on the current regime
  signal. The skill MUST NOT be invoked without a valid rmpc config that includes
  ic_policy_address.
---

# robotmoney-swarm

> **Write-capable.** This skill calls `rmpc committee vote-submit` and produces
> an on-chain transaction. It fails closed — it will not call `rmpc` if any
> preflight guard fails.

> **A note on names.** The product surface is the **Swarm** (this skill, this
> plugin). "Investment Committee" is the on-chain policy contract the swarm's
> tilts land in, so it survives unchanged in the `rmpc` subcommand names
> (`rmpc committee vote-submit`), the policy contract
> (`InvestmentCommitteePolicy`), and the tilt schema
> (`schemas/committee-vote.json`). Type those exactly as written. A committee
> "vote" is a signed per-vault tilt. It is not a vote on anything: the
> committee does not govern. There is no voting at all: router weights change
> only when `WEIGHT_SETTER_ROLE` submits the committee's consensus receipt, and
> that submission, scheduled by the Safe through the timelock, is the rebalance.

Canonical docs: `docs/architecture.md §5.5`, `docs/prd.md §Committee`,
vote schema: `schemas/committee-vote.json`.

## Invocation triggers

Invoke this skill when:

- An Investment Committee agent needs to submit a per-vault tilt.
- The operator asks to "vote on vault X", "submit a committee tilt", or "form
  and submit a committee tilt".

Do **not** invoke this skill when:

- The operator only wants to read the regime (use `robotmoney-analyst` instead).
- The operator wants to change router weights. There is no voting by anyone:
  `WEIGHT_SETTER_ROLE` submits the committee's consensus receipt, scheduled by
  the Safe through the timelock, and rmpc has no governance write command.
- `ic_policy_address` is absent from the rmpc config — surface the
  `MissingICConfig` error instead.

## Preflight guards (all must pass before any on-chain write)

Run the bundled script before every `vote-submit`. It runs the three guards in
this order, stops at the first that fails, and exits 0 only when all pass:

```bash
plugins/robotmoney-swarm/scripts/check-preflight.sh \
  --config <CONFIG> \
  --rationale-uri <URI>
```

`--rmpc <RMPC_PATH>` (or `$RMPC`) names the rmpc binary when it is not on
`PATH`.

1. **IC config present.** `ic_policy_address` must be a top-level address in
   the rmpc config: the key `rmpc committee vote-submit` reads. If absent →
   exit 2, `MissingICConfig`.
2. **Rationale URI reachable.** The `rationale_uri` where the memo will be posted
   must return HTTP 200 before the tilt is submitted. If unreachable → exit 3,
   `RationaleURIUnreachable`.
3. **Agent registered.** The script runs `rmpc committee --config <CONFIG> check-agent`,
   which reads `hasRole(COMMITTEE_AGENT_ROLE, agent)` on the IC policy for the
   address `vote-submit` signs as (the keystore's cleartext `address`). It
   signs nothing and needs no passphrase.
   - Role not held → exit 4, `AgentNotRegistered`, followed by rmpc's
     `ErrNotAllowlisted` JSON. Surface it and do not retry: registration is a
     Safe action, not something this skill or rmpc can do.
   - Role not readable (rmpc missing or older than `check-agent`, RPC down,
     RPC on the wrong chain) → exit 5, `AgentRoleUnreadable`. Do not submit.
     Fix the cause and rerun the preflight; an unread role is never treated as
     registered.

## Workflow

```
1. Fetch regime snapshot (delegates to fetch-regime-snapshot.sh)
2. Read vault holdings (rmpc get-router --config <CONFIG> --pretty)
3. Form per-vault tilts → produce vote JSON (form-vote.sh)
4. ajv-validate vote JSON against schemas/committee-vote.json
5. Post rationale memo to rationale_uri
6. check-preflight.sh --config <CONFIG> --rationale-uri <URI>
                                         ← abort on any non-zero exit
7. rmpc committee --config <CONFIG> vote-submit \
       --vault <ADDR> \
       --stance <STANCE> \
       --weight-bps <BPS> \
       --confidence <0-100> \
       --rationale-uri <URI> \
       --vote-json-hash <HASH> \
       --prompt-hash <HASH> \
       --inputs-digest <DIGEST> \
       --timestamp <UNIX_SECS> \
       --order-id <0x...64hex> \
       --pretty
```

Step 5 (memo post) is done by the operator's rationale host before this skill
runs; the skill does not upload. Step 6 verifies it: guard 2 is a lightweight
HTTP HEAD that must return 200, and guard 3 confirms the agent holds
`COMMITTEE_AGENT_ROLE` before step 7 signs anything.

## Tilt formation

The `form-vote.sh` helper encodes the following heuristic. Operators MAY
replace this with a proprietary allocation method; the published surface only
specifies the output contract (valid `committee-vote.json`).

| Regime | Default stance | Default target_weight_bps | Default confidence |
|--------|---------------|--------------------------|-------------------|
| `risk_on` | `overweight` | current_bps + 1000 (capped 10000) | 70 |
| `neutral` | `neutral` | current_bps (unchanged) | 50 |
| `risk_off` | `underweight` | current_bps − 1000 (floor 0) | 70 |

The helper produces one vote JSON per vault, validated against
`schemas/committee-vote.json`.

## vote JSON shape

See `schemas/committee-vote.json` for the authoritative schema (version `1.0`).

Required fields: `schema_version`, `agent_id`, `vault`, `stance`,
`target_weight_bps`, `confidence`, `rationale_uri`, `prompt_hash`,
`inputs_digest`, `timestamp`.

## rmpc committee commands

### committee vote-submit

```bash
rmpc committee --config <CONFIG> vote-submit \
  --vault <VAULT_ADDR> \
  --stance <overweight|neutral|underweight> \
  --weight-bps <0-10000> \
  --confidence <0-100> \
  --rationale-uri <URI> \
  --vote-json-hash <0x...64hex> \
  --prompt-hash <0x...64hex> \
  --inputs-digest <0x...64hex> \
  --timestamp <UNIX_SECS> \
  --order-id <0x...64hex> \
  --pretty
```

Exit codes: 0 success, 2 refusal (`ErrNotAllowlisted`, `ErrTxReverted`, fee
cap, broadcast), 3 startup failure (`ErrIcContractNotConfigured` when
`ic_policy_address` is missing, keystore, RPC).

`ErrNotAllowlisted` is returned when the configured signer does not hold
`COMMITTEE_AGENT_ROLE` on the IC policy contract. Run `check-agent` (below)
first so that refusal happens before a transaction is signed.

### committee check-agent

```bash
rmpc committee --config <CONFIG> check-agent [--agent <ADDR>] [--pretty]
```

Read-only. Reads `COMMITTEE_AGENT_ROLE()` and `hasRole(role, agent)` on
`ic_policy_address` at one block, after checking the RPC serves the configured
`chain_id`. `--agent` defaults to the keystore's cleartext `address`. Exit 0
with `"has_role": true` when the role is held; exit 2 with `"has_role": false`
and `"error": "ErrNotAllowlisted"` when it is not; exit 3 with an `error` name
(`ErrRpcTransport`, `ErrChainIdMismatch`, `ErrIcContractNotConfigured`, ...)
when the role could not be read. `check-preflight.sh` guard 3 is this command.

## Fetch helper (regime)

```bash
plugins/robotmoney-analyst/scripts/fetch-regime-snapshot.sh [--offline <path>] [--no-cache]
```

The swarm skill delegates to the analyst's fetch helper for the regime
read. See `plugins/robotmoney-analyst/skills/robotmoney-analyst/SKILL.md` for
field descriptions and caching behaviour.

## Vote formation helper

```bash
plugins/robotmoney-swarm/scripts/form-vote.sh \
  --regime <risk_off|neutral|risk_on> \
  --vault <0xADDR> \
  --current-weight-bps <0-10000> \
  --agent-id <STRING> \
  --rationale-uri <URI> \
  --prompt-hash <0x...64hex> \
  --inputs-digest <0x...64hex>
```

Outputs a single committee-vote JSON to stdout. Exits 0 on success, non-zero
on invalid arguments.

## Fail-closed behaviour

| Condition | Error code | On-chain write? |
|-----------|-----------|----------------|
| `ic_policy_address` absent from config | `MissingICConfig` (exit 2) | No |
| `rationale_uri` unreachable (HTTP error / timeout) | `RationaleURIUnreachable` (exit 3) | No |
| Agent lacks `COMMITTEE_AGENT_ROLE` on the IC policy | `AgentNotRegistered` (exit 4) | No |
| Role cannot be read (no rmpc, RPC down, wrong chain) | `AgentRoleUnreadable` (exit 5) | No |
| Regime snapshot fetch fails | surfaced verbatim from fetch helper | No |
| Vote JSON fails ajv schema validation | validation errors printed to stderr | No |

All abort paths exit non-zero and print a named error code to stderr.

## Out of scope

- Proprietary allocation methods (the published surface specifies output shape only)
- IC policy contract or gateway changes
- Explorer or dapp surfaces
- Committee agent registration (a one-time Safe and timelock action: rmpc does not register committee agents)
- Router-weight changes (`WEIGHT_SETTER_ROLE` submits the consensus receipt through a Safe-scheduled timelock operation; rmpc has no governance write command)

`committee vote-submit` submits a signed tilt. It grants no authority over router weights.
