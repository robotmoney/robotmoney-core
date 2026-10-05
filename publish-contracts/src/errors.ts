// Typed errors for the publish contracts CLI. Every failure class has its own exit code, so CI and the operator branch on the code.
export type PublishErrorKind =
  | "USAGE" | "SHEET" | "FLOOR" | "CHAIN" | "SIGNER" | "COUNTS_MISSING" | "SIMULATION" | "BROADCAST" | "COUNT_MISMATCH" | "NONCE"
  | "MANIFEST" | "VERIFY" | "GOVERN" | "GOVERN_PENDING" | "RESUME" | "REFUSED" | "TOOL" | "SAFE" | "INPUT_MISSING";

export const EXIT_CODES: Record<PublishErrorKind, number> = {
  USAGE: 2, SHEET: 3, FLOOR: 4, CHAIN: 5, SIGNER: 6, COUNTS_MISSING: 7, SIMULATION: 8, BROADCAST: 9, COUNT_MISMATCH: 10, NONCE: 11,
  MANIFEST: 12, VERIFY: 13, GOVERN: 14, GOVERN_PENDING: 15, RESUME: 16, REFUSED: 17, TOOL: 18, SAFE: 19, INPUT_MISSING: 20,
};

export class PublishError extends Error {
  readonly kind: PublishErrorKind;
  readonly details: Record<string, unknown>;
  constructor(kind: PublishErrorKind, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PublishError";
    this.kind = kind;
    this.details = details;
  }
  get exitCode(): number { return EXIT_CODES[this.kind]; }
}

export const isPublishError = (e: unknown, kind?: PublishErrorKind): e is PublishError => e instanceof PublishError && (kind === undefined || e.kind === kind);

export function exitCodeOf(e: unknown): number {
  if (e instanceof PublishError) return e.exitCode;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z_]+$/.test(code) && (e as Error).name === "SafeToolError") return EXIT_CODES.SAFE;
  return 1;
}
