// The Actions-only proof behind CONFIRM=environment on 8453 (qa-plan B2, review finding DT-3).
// A laptop can export GITHUB_ACTIONS=true; it cannot mint a GitHub OIDC token. Inside a job that runs behind a GitHub Environment with required
// reviewers, the runner sets ACTIONS_ID_TOKEN_REQUEST_TOKEN and ACTIONS_ID_TOKEN_REQUEST_URL (permission `id-token: write`), and the token GitHub
// signs for that job carries the Environment it ran behind: GitHub issues it only once the reviewers approved. The proof is that token, fetched
// here for this tool's audience, verified against GitHub's JWKS (RS256) and checked claim by claim: issuer, audience, time window, repository
// owner, `environment` equal to --environment and the `sub` GitHub writes for an environment-gated job. Nothing else counts: no flag, no file,
// no environment variable lifts the floor (floors.ts rule). The token itself is never logged or written; the proof is a few named claims.
import { PublishError } from "./errors.ts";

export const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const ACTIONS_JWKS_URL = `${ACTIONS_ISSUER}/.well-known/jwks`;
/** The audience this tool asks GitHub for and accepts. A token minted for another tool (another `aud`) is not this tool's proof. */
export const ACTIONS_AUDIENCE = "robotmoney-publish-contracts";
/** The owner of the repository the deploy workflow runs in (the robotmoney org). A token from another owner's repository is not this deployment's proof. */
export const ACTIONS_REPOSITORY_OWNER = "robotmoney";
/** The two names the Actions runner sets for a job with `id-token: write`. Outside GitHub Actions neither exists. */
export const ACTIONS_TOKEN_ENV = "ACTIONS_ID_TOKEN_REQUEST_TOKEN";
export const ACTIONS_URL_ENV = "ACTIONS_ID_TOKEN_REQUEST_URL";
/** Seconds of clock skew tolerated on `nbf` only; `exp` is strict. */
const NBF_LEEWAY_S = 60;

/** What a verified token proves: the job, its repository and the Environment it ran behind. Logged with confirm.environment; never the token. */
export interface ActionsProof {
  repository: string;
  repositoryOwner: string;
  environment: string;
  sub: string;
  workflow?: string;
  ref?: string;
  sha?: string;
  runId?: string;
  runAttempt?: string;
  eventName?: string;
  actor?: string;
}

/** The sync floor input: the Actions flag, the caller environment, --environment and the proof the CLI obtained (undefined when it did not). */
export interface ActionsProofInput {
  githubActions: boolean;
  env: Record<string, string | undefined>;
  environment?: string;
  proof?: ActionsProof;
}

/**
 * Why CONFIRM=environment is not proven on 8453, or undefined when `proof` is a verified token for `environment`. The order gives the operator the
 * first thing that is missing: the Actions flag, the runner's id-token request token, the Environment name, the verified token, its Environment.
 */
export function actionsProofReason(i: ActionsProofInput): string | undefined {
  if (!i.githubActions) return "CONFIRM=environment is valid only inside GitHub Actions, behind an Environment with required reviewers";
  if (!i.env[ACTIONS_TOKEN_ENV]) return `CONFIRM=environment outside GitHub Actions: ${ACTIONS_TOKEN_ENV} is not set (a job behind the Environment, with id-token: write, sets it; GITHUB_ACTIONS=true alone is not the proof)`;
  if (!i.environment || i.environment === "local") return "CONFIRM=environment needs --environment set to the GitHub Environment name";
  if (!i.proof) return "CONFIRM=environment without a verified GitHub OIDC token: nothing proves the job runs behind the Environment with required reviewers";
  if (i.proof.environment !== i.environment) return `the GitHub OIDC token names Environment '${i.proof.environment}', not --environment ${i.environment}`;
  return undefined;
}

export interface ActionsProofDeps {
  /** Injected for tests: the HTTP client behind the id-token request and the JWKS read. Default: the global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
}

const floor = (message: string, details: Record<string, unknown> = {}) => new PublishError("FLOOR", `CONFIRM=environment: ${message}`, details);

interface JwtHeader { alg?: unknown; kid?: unknown; typ?: unknown }
interface JwtClaims {
  iss?: unknown; aud?: unknown; sub?: unknown; exp?: unknown; nbf?: unknown; iat?: unknown;
  repository?: unknown; repository_owner?: unknown; environment?: unknown; workflow?: unknown; ref?: unknown; sha?: unknown;
  run_id?: unknown; run_attempt?: unknown; event_name?: unknown; actor?: unknown;
}
interface Jwk { kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string }

/** A copy in a fresh ArrayBuffer: WebCrypto takes a BufferSource, not a pooled Buffer slice or a shared buffer. */
const fresh = (b: Uint8Array): Uint8Array<ArrayBuffer> => { const out = new Uint8Array(new ArrayBuffer(b.byteLength)); out.set(b); return out; };
const b64url = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw floor("the OIDC token is not base64url");
  return fresh(Buffer.from(s, "base64url"));
};
const jsonPart = <T>(s: string, what: string): T => {
  try { return JSON.parse(Buffer.from(b64url(s)).toString("utf8")) as T; } catch (e) { if (e instanceof PublishError) throw e; throw floor(`the OIDC token ${what} is not JSON`); }
};

/** Split a compact JWS into its verified inputs. Three dot-separated base64url parts, no more, no fewer. */
export function decodeJwt(jwt: string): { header: JwtHeader; claims: JwtClaims; signedBytes: Uint8Array<ArrayBuffer>; signature: Uint8Array<ArrayBuffer> } {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw floor("the OIDC token is not a compact JWT (three parts)");
  const [h, p, s] = parts as [string, string, string];
  return { header: jsonPart<JwtHeader>(h, "header"), claims: jsonPart<JwtClaims>(p, "payload"), signedBytes: fresh(new TextEncoder().encode(`${h}.${p}`)), signature: b64url(s) };
}

async function getJson(f: typeof fetch, url: string, init: RequestInit, what: string): Promise<unknown> {
  let r: Response;
  try { r = await f(url, init); } catch (e) { throw floor(`${what} could not be fetched: ${(e as Error).message}`); }
  if (!r.ok) throw floor(`${what} request failed with HTTP ${r.status}`, { status: r.status });
  try { return await r.json(); } catch { throw floor(`${what} response is not JSON`); }
}

/** Ask the runner for this tool's OIDC token: `GET $ACTIONS_ID_TOKEN_REQUEST_URL&audience=<aud>` with the request token as bearer. */
async function requestIdToken(f: typeof fetch, url: string, requestToken: string): Promise<string> {
  const sep = url.includes("?") ? "&" : "?";
  const j = (await getJson(f, `${url}${sep}audience=${encodeURIComponent(ACTIONS_AUDIENCE)}`, { method: "GET", headers: { authorization: `bearer ${requestToken}`, accept: "application/json; api-version=2.0" } }, "the GitHub OIDC token")) as { value?: unknown };
  if (typeof j?.value !== "string" || j.value.length === 0) throw floor("the GitHub OIDC token response carries no token");
  return j.value;
}

async function fetchJwks(f: typeof fetch): Promise<Jwk[]> {
  const j = (await getJson(f, ACTIONS_JWKS_URL, { method: "GET", headers: { accept: "application/json" } }, "the GitHub JWKS")) as { keys?: unknown };
  if (!Array.isArray(j?.keys)) throw floor("the GitHub JWKS carries no keys");
  return j.keys as Jwk[];
}

/** RS256 over the signed bytes with the JWKS key the header names. A key of another type or an unknown kid is a refusal, never a skip. */
async function verifySignature(header: JwtHeader, keys: Jwk[], signedBytes: Uint8Array<ArrayBuffer>, signature: Uint8Array<ArrayBuffer>): Promise<void> {
  if (header.alg !== "RS256") throw floor(`the OIDC token algorithm is '${String(header.alg)}', not RS256`);
  if (typeof header.kid !== "string" || header.kid.length === 0) throw floor("the OIDC token names no signing key (kid)");
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw floor("the OIDC token names a signing key GitHub's JWKS does not hold", { kid: header.kid });
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") throw floor("the JWKS key named by the OIDC token is not an RSA key", { kid: header.kid });
  if (jwk.use !== undefined && jwk.use !== "sig") throw floor("the JWKS key named by the OIDC token is not a signing key", { kid: header.kid });
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch (e) { throw floor(`the JWKS key named by the OIDC token could not be imported: ${(e as Error).message}`, { kid: header.kid }); }
  const ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signedBytes);
  if (!ok) throw floor("the OIDC token signature does not verify against GitHub's key", { kid: header.kid });
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const seconds = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^[0-9]+$/.test(v) ? Number(v) : undefined);

/** The claims of a signature-verified token, checked against what this run is: issuer, audience, time, owner, Environment and the environment-gated `sub`. */
export function checkClaims(c: JwtClaims, o: { environment: string; now: Date }): ActionsProof {
  if (c.iss !== ACTIONS_ISSUER) throw floor(`the OIDC token issuer is '${String(c.iss)}', not ${ACTIONS_ISSUER}`);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(ACTIONS_AUDIENCE)) throw floor(`the OIDC token audience is not ${ACTIONS_AUDIENCE}`);
  const now = Math.floor(o.now.getTime() / 1000);
  const exp = seconds(c.exp);
  if (exp === undefined) throw floor("the OIDC token carries no expiry");
  if (exp <= now) throw floor("the OIDC token has expired", { exp, now });
  const nbf = seconds(c.nbf);
  if (nbf !== undefined && nbf > now + NBF_LEEWAY_S) throw floor("the OIDC token is not valid yet", { nbf, now });
  const repository = str(c.repository);
  const repositoryOwner = str(c.repository_owner);
  if (!repository || !repositoryOwner) throw floor("the OIDC token names no repository");
  if (repositoryOwner !== ACTIONS_REPOSITORY_OWNER || !repository.startsWith(`${ACTIONS_REPOSITORY_OWNER}/`)) throw floor(`the OIDC token comes from repository '${repository}', not one owned by ${ACTIONS_REPOSITORY_OWNER}`, { repository });
  const environment = str(c.environment);
  if (!environment) throw floor("the OIDC token carries no Environment: the job does not run behind a GitHub Environment");
  if (environment !== o.environment) throw floor(`the OIDC token names Environment '${environment}', not --environment ${o.environment}`, { environment });
  const sub = str(c.sub);
  const wanted = `repo:${repository}:environment:${environment}`;
  if (sub !== wanted) throw floor(`the OIDC token subject is not the environment-gated job's (${wanted})`, { sub });
  return {
    repository, repositoryOwner, environment, sub,
    workflow: str(c.workflow), ref: str(c.ref), sha: str(c.sha), runId: str(c.run_id), runAttempt: str(c.run_attempt), eventName: str(c.event_name), actor: str(c.actor),
  };
}

/**
 * Obtain and verify the Actions-only proof for `environment`. Throws FLOOR (exit 4) with the first thing wrong; never returns undefined, so a
 * caller that holds an ActionsProof holds a verified one. Called by the CLI before any floor or signer when CONFIRM=environment on 8453.
 */
export async function proveActions(env: Record<string, string | undefined>, o: { environment: string }, deps: ActionsProofDeps = {}): Promise<ActionsProof> {
  const requestToken = env[ACTIONS_TOKEN_ENV];
  const url = env[ACTIONS_URL_ENV];
  if (!requestToken || !url) throw floor(`${ACTIONS_TOKEN_ENV} and ${ACTIONS_URL_ENV} are set by the runner of a job with id-token: write; outside GitHub Actions there is none`);
  if (!/^https:\/\//.test(url)) throw floor(`${ACTIONS_URL_ENV} is not an https URL`);
  const f = deps.fetch ?? fetch;
  const jwt = await requestIdToken(f, url, requestToken);
  const { header, claims, signedBytes, signature } = decodeJwt(jwt);
  await verifySignature(header, await fetchJwks(f), signedBytes, signature);
  return checkClaims(claims, { environment: o.environment, now: (deps.now ?? (() => new Date()))() });
}

/** The log fields of a proof: the claims, never the token. */
export const proofLogFields = (p: ActionsProof): Record<string, string | undefined> =>
  ({ repository: p.repository, environment: p.environment, workflow: p.workflow, ref: p.ref, sha: p.sha, run_id: p.runId, run_attempt: p.runAttempt, event_name: p.eventName, actor: p.actor });
