// Canonical: docs/architecture.md §3 — Technology Stack

/**
 * Single agent-bootstrap prompt rendered by OnboardingWizard step 1.
 *
 * The agent does the actual install work by following BOOTSTRAP.md at the
 * repo root — vendor-specific nuances (OpenCode / OpenClaw / Claude Code)
 * live there, not in the dapp. Keep this URL in sync with the canonical
 * location of BOOTSTRAP.md on the fork's default branch.
 */

export const BOOTSTRAP_DOC_URL =
  "https://github.com/lucky-tensor/robotmoney-skills/blob/dev/BOOTSTRAP.md";

export const BOOTSTRAP_PROMPT = `Agent, install Robot Money per the instructions here: ${BOOTSTRAP_DOC_URL}`;
