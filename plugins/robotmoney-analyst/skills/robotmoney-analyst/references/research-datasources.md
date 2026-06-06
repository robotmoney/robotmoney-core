# Research Datasources

This document describes the external datasources a robotmoney-analyst agent must
consult before creating or evaluating a governance proposal.

---

## 1. Regime Signal — https://www.robotmoney.net/regime

### Purpose

The regime page is the canonical source for the current Robot Money macro and
on-chain risk regime classification. Agents must fetch this source before
creating a `propose` transaction so that the proposal rationale is grounded in
the current regime signal rather than stale assumptions.

### Stability

**stable** — The regime page URL and the JSON snapshot it exposes at
`https://www.robotmoney.net/data/regime-snapshot.json` are production
endpoints. The top-level field names (`regime`, `composite`, `asof`,
`macro_regime`, `onchain_regime`) are stable and validated by the
`fetch-regime-snapshot.sh` helper. New optional fields may be added without
notice; missing optional fields must not be treated as errors.

### Update frequency

Daily at UTC midnight. The `asof` field records the exact UTC timestamp of the
most-recent computation.

### Field-level schema

| Field | Type | Description |
|---|---|---|
| `asof` | ISO-8601 string | UTC timestamp when the snapshot was computed |
| `regime` | `"risk_off"` \| `"neutral"` \| `"risk_on"` | Current regime bucket — the primary allocation signal |
| `composite` | number (0–100) | Weighted composite risk score |
| `composite_percentile` | number (0–100) | Historical percentile rank of the composite score |
| `macro_regime` | string | Macro sub-regime label (e.g. `"contraction"`, `"expansion"`) |
| `onchain_regime` | string | On-chain sub-regime label (e.g. `"accumulation"`, `"distribution"`) |
| `macro_index` | number (0–100) | Macro sub-component score |
| `onchain_index` | number (0–100) | On-chain sub-component score |
| `bucket_thresholds` | object | Score thresholds that define each regime bucket |
| `history` | array | Daily composite scores (optional, not surfaced by default) |
| `indicator_weights` | object | Per-indicator weight map (optional) |
| `panel` | object | Full panel of sub-regime scores (optional) |

See [snapshot-fields.md](snapshot-fields.md) for the full validation rules
enforced by the fetch helper.

### Governance-decision interpretation guide

| `regime` value | Interpretation | Typical proposal direction |
|---|---|---|
| `"risk_on"` | Macro and on-chain conditions are favourable; composite score is high | Increase weight in growth / higher-risk vaults |
| `"neutral"` | Mixed signals; neither strong risk-on nor risk-off | Maintain existing weights or make marginal adjustments |
| `"risk_off"` | Adverse macro or on-chain conditions; composite score is low | Rotate toward capital-preservation or stable-asset vaults |

When the composite score is near a bucket threshold (within 5 points of
`bucket_thresholds.neutral.min` or `bucket_thresholds.neutral.max`), note
the borderline position in the proposal rationale and recommend a conservative
weight change.

### When to consult

- **Before every `propose` transaction.** The regime bucket and composite score
  must appear verbatim in the proposal rationale.
- When the user asks about current market conditions or whether a weight
  rebalance is appropriate.
- When evaluating a governance proposal submitted by another party — check
  whether the cited regime matches the current snapshot.

---

## 2. Research Context — https://analytics.robotmoney.net/projects

### Purpose

The analytics projects page documents active and completed research threads,
methodology notes, and signal analyses that inform governance decisions. Agents
must check this source before creating a `propose` transaction to identify
whether any open research thread directly addresses the vaults or signals
involved in the proposed weight change.

### Stability

**stable** — The analytics projects URL is a production endpoint. The page
structure (project cards with title, status, description, and methodology
notes) is stable. Individual project entries are added and updated as research
progresses; agents must re-fetch on each reasoning session rather than relying
on cached results.

### Update frequency

As needed when research is published or updated. There is no fixed cadence.
Agents should treat any cached copy older than 24 hours as potentially stale.

### Field-level schema (page-level structure)

Each research project entry on the page contains the following logical fields:

| Field | Description |
|---|---|
| `title` | Short label for the research thread |
| `status` | One of: `active`, `completed`, `paused` |
| `description` | Plain-language summary of the research question |
| `methodology_notes` | Key assumptions, data sources, and model choices |
| `signal_analyses` | Links to or inline summaries of signal studies produced by this thread |
| `relevant_vaults` | Vaults or asset classes covered by this research (if specified) |

### Governance-decision interpretation guide

- If a research thread with `status: active` covers a vault or signal
  referenced in a proposal, cite the thread title and its current findings in
  the proposal rationale.
- If a completed research thread contradicts the proposed weight direction,
  acknowledge the conflict and explain why the regime signal takes precedence
  (or why it does not).
- If no research thread is directly relevant, state "No active research threads
  identified for the targeted vaults" in the proposal rationale.

### When to consult

- **Before every `propose` transaction.** Check for active research threads
  relevant to the vaults or factors covered by the proposal.
- When the user asks about the analytical basis for a past or proposed weight
  change.
- When evaluating a governance proposal submitted by another party — verify
  that cited methodology notes are consistent with the analytics page.
