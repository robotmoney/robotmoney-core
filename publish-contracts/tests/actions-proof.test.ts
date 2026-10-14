// The Actions-only proof behind CONFIRM=environment on 8453 (qa-plan B2, DT-3): the job's GitHub OIDC token, fetched for this tool's audience,
// verified against GitHub's JWKS and checked claim by claim. A real RSA key pair signs the tokens here, so the signature path is the real one;
// the HTTP client is a fake that records what was asked. Every refusal is FLOOR and names the first thing wrong; the token is never in a message.
import { describe, expect, test } from "bun:test";
import {
  ACTIONS_AUDIENCE, ACTIONS_ISSUER, ACTIONS_JWKS_URL, ACTIONS_REPOSITORY_OWNER, ACTIONS_TOKEN_ENV, ACTIONS_URL_ENV,
  actionsProofReason, checkClaims, decodeJwt, proofLogFields, proveActions, type ActionsProof,
} from "../src/actions-proof.ts";
import { EXIT_CODES, PublishError } from "../src/errors.ts";

const ENV = "base-mainnet";
const REPO = `${ACTIONS_REPOSITORY_OWNER}/release-driver`;
const NOW = new Date("2026-10-14T12:00:00Z");
const nowS = Math.floor(NOW.getTime() / 1000);
const REQUEST_URL = "https://pipelines.actions.githubusercontent.com/abc/idtoken/def?api-version=2.0";
const REQUEST_TOKEN = "runner-request-token-not-a-jwt";
const inActions = { GITHUB_ACTIONS: "true", [ACTIONS_TOKEN_ENV]: REQUEST_TOKEN, [ACTIONS_URL_ENV]: REQUEST_URL };

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const keyPair = await crypto.subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
const otherPair = await crypto.subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
const publicJwk = async (k: CryptoKeyPair, kid: string) => { const j = (await crypto.subtle.exportKey("jwk", k.publicKey)) as JsonWebKey & { kid?: string; use?: string }; return { kty: j.kty, n: j.n, e: j.e, alg: "RS256", use: "sig", kid }; };
const JWKS = { keys: [await publicJwk(keyPair, "gh-key-1"), await publicJwk(otherPair, "gh-key-2")] };

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
/** The claims GitHub writes for a job behind an Environment, as of the Actions OIDC docs. */
const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: ACTIONS_ISSUER, aud: ACTIONS_AUDIENCE, sub: `repo:${REPO}:environment:${ENV}`, exp: nowS + 300, nbf: nowS - 60, iat: nowS - 60,
  repository: REPO, repository_owner: ACTIONS_REPOSITORY_OWNER, environment: ENV, workflow: "publish contracts", ref: "refs/heads/main", sha: "a".repeat(40),
  run_id: "123456", run_attempt: "1", event_name: "workflow_dispatch", actor: "operator", ...over,
});
async function mint(claims: Record<string, unknown>, o: { kid?: string; alg?: string; key?: CryptoKey } = {}): Promise<string> {
  const h = b64u(JSON.stringify({ alg: o.alg ?? "RS256", kid: o.kid ?? "gh-key-1", typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign(RSA.name, o.key ?? keyPair.privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u(sig)}`;
}

interface Call { url: string; init?: RequestInit }
/** A fake HTTP client: the id-token endpoint answers `{ value }`, the JWKS endpoint answers the key set; anything else is a programming error. */
function fakeFetch(o: { token?: string | (() => Promise<string>); jwks?: unknown; tokenStatus?: number; jwksStatus?: number; tokenBody?: string; throwOn?: "token" | "jwks" } = {}) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith(ACTIONS_JWKS_URL)) {
      if (o.throwOn === "jwks") throw new Error("ECONNRESET");
      return new Response(JSON.stringify(o.jwks ?? JWKS), { status: o.jwksStatus ?? 200 });
    }
    if (o.throwOn === "token") throw new Error("ENOTFOUND");
    const token = typeof o.token === "function" ? await o.token() : o.token;
    return new Response(o.tokenBody ?? JSON.stringify({ value: token }), { status: o.tokenStatus ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}
const prove = (ff: ReturnType<typeof fakeFetch>, env: Record<string, string | undefined> = inActions, environment = ENV) => proveActions(env, { environment }, { fetch: ff.f, now: () => NOW });
async function refusal(p: Promise<unknown>): Promise<PublishError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(PublishError); return e as PublishError; }
  throw new Error("expected a refusal");
}

describe("proveActions: a GitHub OIDC token signed by GitHub's key for this Environment is the proof", () => {
  test("asks the runner for this tool's audience with the request token as bearer, reads GitHub's JWKS, and returns the claims", async () => {
    const ff = fakeFetch({ token: await mint(goodClaims()) });
    const proof = await prove(ff);
    expect(proof).toEqual({
      repository: REPO, repositoryOwner: ACTIONS_REPOSITORY_OWNER, environment: ENV, sub: `repo:${REPO}:environment:${ENV}`,
      workflow: "publish contracts", ref: "refs/heads/main", sha: "a".repeat(40), runId: "123456", runAttempt: "1", eventName: "workflow_dispatch", actor: "operator",
    } satisfies ActionsProof);
    expect(ff.calls.map((c) => c.url)).toEqual([`${REQUEST_URL}&audience=${encodeURIComponent(ACTIONS_AUDIENCE)}`, ACTIONS_JWKS_URL]);
    const headers = ff.calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`bearer ${REQUEST_TOKEN}`);
    expect(headers.accept).toContain("api-version=2.0");
  });
  test("a request URL without a query string gets `?audience=`", async () => {
    const ff = fakeFetch({ token: await mint(goodClaims()) });
    await prove(ff, { ...inActions, [ACTIONS_URL_ENV]: "https://pipelines.actions.githubusercontent.com/idtoken" });
    expect(ff.calls[0]!.url).toBe(`https://pipelines.actions.githubusercontent.com/idtoken?audience=${encodeURIComponent(ACTIONS_AUDIENCE)}`);
  });
  test("an audience list that holds this tool's audience passes; numeric run_id is read as a string", async () => {
    const ff = fakeFetch({ token: await mint(goodClaims({ aud: ["other", ACTIONS_AUDIENCE], run_id: 7 })) });
    expect((await prove(ff)).runId).toBe("7");
  });
  test("the second JWKS key signs too: the kid picks the key", async () => {
    const ff = fakeFetch({ token: await mint(goodClaims(), { kid: "gh-key-2", key: otherPair.privateKey }) });
    expect((await prove(ff)).environment).toBe(ENV);
  });
});

describe("proveActions refusals: every one is FLOOR (exit 4) and names the first thing wrong", () => {
  const floorOf = async (p: Promise<unknown>) => { const e = await refusal(p); expect(e.kind).toBe("FLOOR"); expect(e.exitCode).toBe(EXIT_CODES.FLOOR); expect(e.message).toStartWith("CONFIRM=environment:"); return e.message; };
  test("outside Actions: no request token or URL", async () => {
    expect(await floorOf(prove(fakeFetch(), { GITHUB_ACTIONS: "true" }))).toContain(ACTIONS_TOKEN_ENV);
    expect(await floorOf(prove(fakeFetch(), { [ACTIONS_TOKEN_ENV]: REQUEST_TOKEN }))).toContain(ACTIONS_URL_ENV);
    expect(await floorOf(prove(fakeFetch(), { ...inActions, [ACTIONS_URL_ENV]: "http://127.0.0.1/idtoken" }))).toContain("https");
  });
  test("the token endpoint fails, answers non-200, answers no JSON or carries no token", async () => {
    expect(await floorOf(prove(fakeFetch({ throwOn: "token" })))).toContain("could not be fetched");
    expect(await floorOf(prove(fakeFetch({ tokenStatus: 401, token: "x" })))).toContain("HTTP 401");
    expect(await floorOf(prove(fakeFetch({ tokenBody: "<html>" })))).toContain("not JSON");
    expect(await floorOf(prove(fakeFetch({ tokenBody: JSON.stringify({ count: 1 }) })))).toContain("no token");
  });
  test("the JWKS endpoint fails or carries no keys", async () => {
    const token = await mint(goodClaims());
    expect(await floorOf(prove(fakeFetch({ token, throwOn: "jwks" })))).toContain("JWKS could not be fetched");
    expect(await floorOf(prove(fakeFetch({ token, jwksStatus: 503 })))).toContain("HTTP 503");
    expect(await floorOf(prove(fakeFetch({ token, jwks: { nope: [] } })))).toContain("no keys");
  });
  test("not a JWT, not base64url, not JSON", async () => {
    expect(await floorOf(prove(fakeFetch({ token: "a.b" })))).toContain("three parts");
    expect(await floorOf(prove(fakeFetch({ token: "a..c" })))).toContain("three parts");
    expect(await floorOf(prove(fakeFetch({ token: "a+b.c.d" })))).toContain("base64url");
    expect(await floorOf(prove(fakeFetch({ token: `${b64u("nope")}.${b64u("{}")}.${b64u("x")}` })))).toContain("header is not JSON");
  });
  test("alg none, alg HS256, no kid, unknown kid, a non-RSA key", async () => {
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims(), { alg: "none" }) })))).toContain("not RS256");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims(), { alg: "HS256" }) })))).toContain("not RS256");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims(), { kid: "" }) })))).toContain("kid");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims(), { kid: "gh-key-9" }) })))).toContain("does not hold");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims()), jwks: { keys: [{ kid: "gh-key-1", kty: "EC", crv: "P-256", x: "a", y: "b" }] } })))).toContain("not an RSA key");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims()), jwks: { keys: [{ ...JWKS.keys[0]!, use: "enc" }] } })))).toContain("not a signing key");
  });
  test("a token signed by another key, or a tampered payload, does not verify", async () => {
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims(), { kid: "gh-key-1", key: otherPair.privateKey }) })))).toContain("does not verify");
    const good = await mint(goodClaims());
    const [h, , s] = good.split(".") as [string, string, string];
    const tampered = `${h}.${b64u(JSON.stringify(goodClaims({ environment: ENV, actor: "someone-else" })))}.${s}`;
    expect(await floorOf(prove(fakeFetch({ token: tampered })))).toContain("does not verify");
  });
  test("issuer, audience, expiry, not-before", async () => {
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ iss: "https://evil.example" })) })))).toContain("issuer");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ aud: "another-tool" })) })))).toContain("audience");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ aud: ["another-tool"] })) })))).toContain("audience");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ exp: undefined })) })))).toContain("no expiry");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ exp: nowS })) })))).toContain("expired");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ nbf: nowS + 61 })) })))).toContain("not valid yet");
    // one minute of skew on nbf is allowed, expiry is strict
    expect((await prove(fakeFetch({ token: await mint(goodClaims({ nbf: nowS + 60, exp: nowS + 1 })) }))).environment).toBe(ENV);
  });
  test("repository owner, no Environment, another Environment, a subject that is not the environment-gated job's", async () => {
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ repository: "evil/release-driver", repository_owner: "evil", sub: `repo:evil/release-driver:environment:${ENV}` })) })))).toContain(`not one owned by ${ACTIONS_REPOSITORY_OWNER}`);
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ repository: "evil/release-driver" })) })))).toContain("not one owned by");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ repository: undefined })) })))).toContain("no repository");
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ environment: undefined, sub: `repo:${REPO}:ref:refs/heads/main` })) })))).toContain("no Environment");
    const other = await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ environment: "base-rehearsal", sub: `repo:${REPO}:environment:base-rehearsal` })) })));
    expect(other).toContain("'base-rehearsal'");
    expect(other).toContain(ENV);
    expect(await floorOf(prove(fakeFetch({ token: await mint(goodClaims({ sub: `repo:${REPO}:ref:refs/heads/main` })) })))).toContain("environment-gated");
  });
  test("no refusal message carries the request token or the OIDC token", async () => {
    const token = await mint(goodClaims({ aud: "another-tool" }));
    const e = await refusal(prove(fakeFetch({ token })));
    const text = e.message + JSON.stringify(e.details);
    expect(text).not.toContain(REQUEST_TOKEN);
    expect(text).not.toContain(token.split(".")[2]!);
  });
});

describe("the sync floor input and the pure helpers", () => {
  const PROOF: ActionsProof = { repository: REPO, repositoryOwner: ACTIONS_REPOSITORY_OWNER, environment: ENV, sub: `repo:${REPO}:environment:${ENV}` };
  test("actionsProofReason: the first missing thing, in order; undefined once the proof names --environment", () => {
    expect(actionsProofReason({ githubActions: false, env: {}, environment: ENV, proof: PROOF })).toContain("only inside GitHub Actions");
    expect(actionsProofReason({ githubActions: true, env: { GITHUB_ACTIONS: "true" }, environment: ENV, proof: PROOF })).toContain(ACTIONS_TOKEN_ENV);
    expect(actionsProofReason({ githubActions: true, env: inActions, environment: "local", proof: PROOF })).toContain("--environment");
    expect(actionsProofReason({ githubActions: true, env: inActions, environment: undefined, proof: PROOF })).toContain("--environment");
    expect(actionsProofReason({ githubActions: true, env: inActions, environment: ENV })).toContain("without a verified GitHub OIDC token");
    expect(actionsProofReason({ githubActions: true, env: inActions, environment: ENV, proof: { ...PROOF, environment: "other" } })).toContain("'other'");
    expect(actionsProofReason({ githubActions: true, env: inActions, environment: ENV, proof: PROOF })).toBeUndefined();
  });
  test("decodeJwt splits the compact form and keeps the signed bytes as sent", async () => {
    const jwt = await mint(goodClaims());
    const d = decodeJwt(jwt);
    expect(d.header).toMatchObject({ alg: "RS256", kid: "gh-key-1" });
    expect(d.claims).toMatchObject({ environment: ENV, repository: REPO });
    expect(new TextDecoder().decode(d.signedBytes)).toBe(jwt.split(".").slice(0, 2).join("."));
    expect(d.signature.byteLength).toBe(256);
  });
  test("checkClaims is the claim rule alone (no network): good claims give the proof, each bad claim is FLOOR", () => {
    expect(checkClaims(goodClaims(), { environment: ENV, now: NOW }).sub).toBe(`repo:${REPO}:environment:${ENV}`);
    for (const bad of [{ iss: "x" }, { aud: "x" }, { exp: 1 }, { environment: "x" }, { repository_owner: "x" }, { sub: "x" }]) {
      expect(() => checkClaims(goodClaims(bad), { environment: ENV, now: NOW })).toThrow(expect.objectContaining({ kind: "FLOOR" }));
    }
  });
  test("proofLogFields carries the claims under log names and nothing secret-shaped", () => {
    expect(proofLogFields({ ...PROOF, runId: "9", runAttempt: "2", eventName: "workflow_dispatch", actor: "op", workflow: "w", ref: "r", sha: "s" })).toEqual({
      repository: REPO, environment: ENV, workflow: "w", ref: "r", sha: "s", run_id: "9", run_attempt: "2", event_name: "workflow_dispatch", actor: "op",
    });
  });
});
