---
name: robotmoney-swarm
description: >
  Robot Money Swarm agent skill extending robotmoney-analyst. Reads the current regime
  feed and vault holdings, forms a per-vault tilt (overweight/neutral/underweight)
  with target_weight_bps and confidence, posts a narrative rationale memo to a
  configured public URI, then submits a signed committee vote via
  `rmpc committee vote-submit`. Fails closed before any on-chain write when
  ic_contract_address is absent from config, the agent is not registered, or
  the rationale_uri is unreachable. Use this skill when an Investment Committee
  agent needs to submit a vote for a specific vault based on the current regime
  signal. The skill MUST NOT be invoked without a valid rmpc config that includes
  ic_contract_address.
---

# robotmoney-swarm

> **Write-capable.** This skill calls `rmpc committee vote-submit` and produces
> an on-chain transaction. It fails closed — it will not call `rmpc` if any
> preflight guard fails.

> **A note on names.** The product surface is the **Swarm** (this skill, this
> plugin). "Investment Committee" is the on-chain governance body the swarm's
> votes land in, so it survives unchanged in the `rmpc` subcommand names
> (`rmpc committee vote-submit`), the policy contract
> (`InvestmentCommitteePolicy`), and the vote schema
> (`schemas/committee-vote.json`). Type those exactly as written.

Canonical docs: `docs/architecture.md §5.5`, `docs/prd.md §Committee`,
vote schema: `schemas/committee-vote.json`.

## Invocation triggers

Invoke this skill when:

- An Investment Committee agent needs to submit a per-vault tilt vote.
- The operator asks to "vote on vault X", "submit a committee tilt", or "form
  and submit a committee vote".

Do **not** invoke this skill when:

- The operator only wants to read the regime (use `robotmoney-analyst` instead).
- The operator wants to submit a RouterGovernance proposal (`propose` or `vote`
  commands on the analyst skill cover that flow).
- `ic_contract_address` is absent from the rmpc config — surface the
  `MissingICConfig` error instead.

## Preflight guards (all must pass before any on-chain write)

1. **IC config present.** `ic_contract_address` must be set in the rmpc config.
   If absent → abort with `MissingICConfig`.
2. **Agent registered.** The configured signing address must be a registered
   committee agent in the IC contract. If `rmpc committee vote-submit` returns
   `AgentNotRegistered` → surface the error and do not retry.
3. **Rationale URI reachable.** The `rationale_uri` where the memo will be posted
   must return HTTP 200 before the vote is submitted. If unreachable → abort
   with `RationaleURIUnreachable`.

## Workflow

```
1. Fetch regime snapshot (delegates to fetch-regime-snapshot.sh)
2. Read vault holdings (rmpc get-router --config <CONFIG> --pretty)
3. Form per-vault tilts → produce vote JSON (form-vote.sh)
4. ajv-validate vote JSON against schemas/committee-vote.json
5. Post rationale memo to rationale_uri  ← abort here if unreachable
6. rmpc committee --config <CONFIG> vote-submit \
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

Step 5 (memo post) is a lightweight HTTP HEAD/GET to verify the URI is
reachable. The memo itself is posted by the operator's rationale host before
this skill runs; the skill only verifies reachability, it does not upload.

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

Exit codes: 0 success, 2 refusal (fee-cap, broadcast), 3 startup failure
(`AgentNotRegistered`, missing `ic_contract_address`).

`AgentNotRegistered` is returned when the configured signer has not been
allowlisted and registered in the IC policy contract.

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
| `ic_contract_address` absent from config | `MissingICConfig` | No |
| Agent not registered in IC contract | `AgentNotRegistered` | No |
| `rationale_uri` unreachable (HTTP error / timeout) | `RationaleURIUnreachable` | No |
| Regime snapshot fetch fails | surfaced verbatim from fetch helper | No |
| Vote JSON fails ajv schema validation | validation errors printed to stderr | No |

All abort paths exit non-zero and print a named error code to stderr.

## Out of scope

- Proprietary allocation methods (the published surface specifies output shape only)
- IC policy contract or gateway changes
- Explorer or dapp surfaces
- `rmpc committee register` (one-time setup, not part of the vote flow)
- RouterGovernance proposals (covered by robotmoney-analyst `propose`/`vote`)
