// Label constants shared by the one verifier, the product acceptance stage and the mainnet canary.
// The verifier owns them. other repos may import this file
// so a rename here is a type error there. Pure constants: no imports, no chain, no secret.

/** Per-vault read-only facts the verifier and the canary both check. */
export const VERIFIER_LABELS = {
  totalAssets: "total-assets",
  paused: "paused",
  roles: "roles",
  timelockDelay: "timelock-min-delay",
  registryLink: "registry-link",
} as const;

/** Product acceptance steps, in order. */
export const ACCEPTANCE_LABELS = {
  deposit: "deposit",
  agentPayment: "agent-payment",
  redeem: "redeem-node-estimate",
  dappBalance: "dapp-balance-read",
} as const;

export type VerifierLabel = (typeof VERIFIER_LABELS)[keyof typeof VERIFIER_LABELS];
export type AcceptanceLabel = (typeof ACCEPTANCE_LABELS)[keyof typeof ACCEPTANCE_LABELS];

export const ALL_VERIFIER_LABELS: readonly string[] = Object.values(VERIFIER_LABELS);
export const ALL_ACCEPTANCE_LABELS: readonly string[] = Object.values(ACCEPTANCE_LABELS);
