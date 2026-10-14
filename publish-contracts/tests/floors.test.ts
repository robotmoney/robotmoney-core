// Floors: the plaintext refusal on a non-loopback RPC is a CLI behavior,
// and core's stage signer string passes where it should. (devops 65)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS_TOKEN_ENV, ACTIONS_URL_ENV, type ActionsProof } from "../src/actions-proof.ts";
import { ownerSignerShortfall } from "../src/cli.ts";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { assertFloors, assertOwnerSignerSpec, passphraseFileReason, plaintextKeyReason, plaintextSignerReason } from "../src/floors.ts";
import { publishLogger } from "../src/log.ts";
import { confirmStage, type RunContext } from "../src/runner.ts";
import { callerInputs, parseSheet } from "../src/sheet.ts";
import { sheetText } from "./fixtures.ts";
import { PROVE_SIGNERS, world } from "./harness.ts";

const GOOD = { TIMELOCK_MIN_DELAY: "172800", GOVERN_NEW_DELAY: "172800" };
const sheetFor = (chain: number, extra: Record<string, string | null> = {}) => parseSheet(sheetText({ CHAIN_ID: String(chain), EXPECTED_CHAIN_ID: String(chain), ...extra }));
const input = (chain: number, o: Record<string, unknown> = {}) =>
  ({ rpcChainId: chain, rpc: "https://mainnet.base.org", sheet: sheetFor(chain, chain === 8453 ? GOOD : {}), caller: callerInputs({}), signerSpec: "keystore:/dev/shm/k/DEPLOYER", env: {}, environment: "mainnet", githubActions: false, ...o }) as Parameters<typeof assertFloors>[0];
const refusal = (f: () => void): string | undefined => { try { f(); } catch (e) { return (e as PublishError).kind + ": " + (e as Error).message; } return undefined; };
const quiet = async (f: () => Promise<number>) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
/** `--owner-signer keystore:/k/OWNER_0 ...`: n software owners, the digit at the end indexes PROVE_SIGNERS in the tests that build them. */
const ownerArgs = (n: number) => Array.from({ length: n }, (_, i) => ["--owner-signer", `keystore:/k/OWNER_${i}`]).flat();
const forgeCalls = (w: ReturnType<typeof world>) => w.state().calls.filter((c: { tool: string }) => c.tool === "forge").length;
const lastFailure = (w: ReturnType<typeof world>) => String(w.logs().filter((l) => l.event === "run.failed").pop()?.message ?? "");

describe("plaintext refusal on a non-loopback RPC (any chain)", () => {
  const forms = ["--private-key 0x01", "plaintext:KEY", "0x" + "11".repeat(32)];
  test("every plaintext form is refused on a non-loopback RPC, on 8453 and on Twin", () => {
    for (const chain of [8453, 918453]) for (const signerSpec of forms) {
      const r = refusal(() => assertFloors(input(chain, { rpc: "https://rpc.example", signerSpec })));
      expect(r).toContain("FLOOR");
      expect(r).toContain("non-loopback RPC");
    }
    expect(refusal(() => assertFloors(input(918453, { rpc: "https://rpc.example", env: { PRIVATE_KEY: "x" } })))).toContain("PRIVATE_KEY");
  });
  test("a loopback RPC allows them off 8453", () => {
    for (const rpc of ["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545"]) expect(refusal(() => assertFloors(input(918453, { rpc, signerSpec: "plaintext:KEY" })))).toBeUndefined();
  });
  test("8453 refuses plaintext even on a loopback RPC", () => {
    expect(refusal(() => assertFloors(input(8453, { rpc: "http://127.0.0.1:8545", signerSpec: "plaintext:KEY" })))).toContain("plaintext");
  });
  test("a hostname that merely contains localhost is not loopback", () => {
    expect(refusal(() => assertFloors(input(918453, { rpc: "http://localhost.evil.example:8545", signerSpec: "plaintext:KEY" })))).toContain("non-loopback");
  });
  test("core's stage signer keystore:<path>:<passfile> passes on Twin (non-loopback) and is refused on 8453", () => {
    const spec = "keystore:/dev/shm/k/DEPLOYER:/dev/shm/k/pw";
    expect(plaintextKeyReason(spec)).toBeUndefined();
    expect(passphraseFileReason(spec)).toContain("passphrase");
    expect(plaintextSignerReason(spec)).toContain("passphrase");
    expect(refusal(() => assertFloors(input(918453, { rpc: "https://twin.example", signerSpec: spec })))).toBeUndefined();
    expect(refusal(() => assertFloors(input(8453, { signerSpec: spec })))).toContain("plaintext signing is refused on chain 8453");
  });
});

describe("plaintext refusal through the CLI (main)", () => {
  test("a plaintext signer on a non-loopback RPC exits with the FLOOR code and a named error, before any signer or forge call", async () => {
    const w = world({ chainId: 918453 });
    let signerMade = false;
    const code = await quiet(() => w.run([], { signer: "plaintext:KEY", makeSigner: () => { signerMade = true; throw new Error("no signer"); } }));
    expect(code).toBe(EXIT_CODES.FLOOR);
    expect(signerMade).toBe(false);
    expect(w.state().calls.filter((c: { tool: string }) => c.tool === "forge").length).toBe(0);
    expect(w.logs().some((l) => String(l.message).includes("non-loopback RPC"))).toBe(true);
  });
  test("--private-key as the signer is refused (non-zero) and PRIVATE_KEY in the environment is refused by the floor", async () => {
    expect(await quiet(() => world({ chainId: 918453 }).run([], { signer: "--private-key 0x01" }))).not.toBe(0);
    expect(await quiet(() => world({ chainId: 918453 }).run([], { env: { PRIVATE_KEY: "x" } }))).toBe(EXIT_CODES.FLOOR);
  });
  test("an encrypted keystore with a passphrase file on a non-loopback Twin RPC is not refused by the floors", async () => {
    const w = world({ chainId: 918453 });
    const code = await quiet(() => w.run(["--stage", "plan"], { signer: "keystore:/dev/shm/k/DEPLOYER:/dev/shm/k/pw" }));
    expect(code).toBe(0);
  });
});

// Owner decision 2026-10-14 (qa-plan B1, DT-1, QD-1, T6, F1, issue 1669): hardware signing is optional, never required. The hardware-only
// owner floor of core 1668 is reverted: on 8453 a keystore with a typed passphrase and a device bound to its owner both pass; plaintext, a raw
// key and a passphrase file stay refused by the signer floor, and env:signer is refused as an owner (OWNER_SIGNER_REFUSED, exit 29).
describe("Safe owner signers on 8453: keystores and bound devices pass, hardware is optional (B1)", () => {
  const owner = (spec: string, chain = 8453, rpc = "https://mainnet.base.org") => refusal(() => assertOwnerSignerSpec(spec, { rpcChainId: chain, rpc, env: {} }));
  const OWNER = `0x${"ab".repeat(20)}`;
  test("keystore:PATH (passphrase typed at the hidden prompt) passes on 8453", () => {
    expect(owner("keystore:/k/OWNER")).toBeUndefined();
  });
  test("ledger:PATH@0xOWNER and trezor:PATH@0xOWNER pass on 8453", () => {
    expect(owner(`ledger:m/44'/60'/0'/0/1@${OWNER}`)).toBeUndefined();
    expect(owner(`trezor:m/44'/60'/0'/0/0@${OWNER}`)).toBeUndefined();
  });
  test("env:signer and env:funder are refused on 8453 with OWNER_SIGNER_REFUSED (exit 29), and the message names the family, never the spec", () => {
    for (const spec of ["env:signer", "env:funder"]) {
      expect(() => assertOwnerSignerSpec(spec, { rpcChainId: 8453, rpc: "https://mainnet.base.org", env: {} })).toThrow(expect.objectContaining({ kind: "OWNER_SIGNER_REFUSED" }));
      expect(owner(spec)).not.toContain(spec);
      expect(owner(spec)).toContain("never read from the environment");
    }
    expect(EXIT_CODES.OWNER_SIGNER_REFUSED).toBe(29);
  });
  test("a keystore with a passphrase file is refused on 8453 by the signer floor (FLOOR), not by an owner rule", () => {
    const r = owner("keystore:/k/OWNER:/k/pw");
    expect(r).toContain("FLOOR");
    expect(r).toContain("passphrase");
  });
  test("plaintext and raw-key owner specs are refused on both chains (FLOOR)", () => {
    for (const spec of ["plaintext:KEY", "0x" + "11".repeat(32)]) {
      expect(owner(spec, 918453, "https://twin.example")).toContain("FLOOR");
      expect(owner(spec)).toContain("FLOOR");
    }
  });
  test("software owners, the engine hand-off, a passphrase file and both hardware grammars stay allowed on the Twin chain", () => {
    for (const spec of ["keystore:/k/OWNER", "keystore:/k/OWNER:/k/pw", "env:signer", "ledger", `ledger:m/44'/60'/0'/0/1@${OWNER}`]) expect(owner(spec, 918453, "https://twin.example")).toBeUndefined();
  });
  test("through main(): env:signer as an owner on 8453 exits OWNER_SIGNER_REFUSED before a signer is built or forge runs", async () => {
    const w = world({ chainId: 8453 });
    let signerMade = false;
    const code = await quiet(() => w.run(["govern", "--environment", "base-mainnet", "--owner-signer", "keystore:/k/A", "--owner-signer", "env:signer"], { makeSigner: () => { signerMade = true; throw new Error("no signer"); } }));
    expect(code).toBe(EXIT_CODES.OWNER_SIGNER_REFUSED);
    expect(signerMade).toBe(false);
    expect(forgeCalls(w)).toBe(0);
  });
  test("through main(): keystore owners on 8453 pass the owner floors (the run reaches run.checks_ok; the 1668 floor would have exited 29 first)", async () => {
    const w = world({ chainId: 8453 });
    const code = await quiet(() => w.run(["govern", "--environment", "base-mainnet", ...ownerArgs(3)], { ownerSigner: async (s: string) => PROVE_SIGNERS[Number(s.slice(-1))]! }));
    expect(code).not.toBe(EXIT_CODES.OWNER_SIGNER_REFUSED);
    expect(code).not.toBe(EXIT_CODES.FLOOR);
    expect(w.logs().some((l) => l.event === "run.checks_ok")).toBe(true);
  });
});

describe("8453 refuses a short --owner-signer list before stage 1 (qa-plan B1)", () => {
  const sheet = { safeOwners: [`0x${"a1".repeat(20)}`, `0x${"a2".repeat(20)}`, `0x${"a3".repeat(20)}`] as `0x${string}`[] };
  const two = ["keystore:/k/A", "keystore:/k/B"];
  const three = [...two, `ledger:m/44'/60'/0'/0/0@${sheet.safeOwners[2]}`];
  const kind = (e: PublishError | undefined) => e?.kind;
  test("ownerSignerShortfall: publish, the default stage set, deploy, all and a list naming prove-control need every sheet owner", () => {
    expect(kind(ownerSignerShortfall({ chainId: 8453, verb: "publish", dryRun: false, specs: two, sheet }))).toBe("CONTROL_NOT_PROVEN");
    expect(kind(ownerSignerShortfall({ chainId: 8453, dryRun: false, specs: [], sheet }))).toBe("CONTROL_NOT_PROVEN");
    for (const stage of ["deploy", "all", "safe,prove-control,timelock"]) expect(kind(ownerSignerShortfall({ chainId: 8453, stage, dryRun: false, specs: two, sheet })), stage).toBe("CONTROL_NOT_PROVEN");
    expect(ownerSignerShortfall({ chainId: 8453, verb: "publish", dryRun: false, specs: three, sheet })).toBeUndefined();
    const e = ownerSignerShortfall({ chainId: 8453, verb: "publish", dryRun: false, specs: two, sheet })!;
    expect(e.message).toContain("before stage 1");
    expect(e.details).toMatchObject({ have: 2, need: 3, stage: "prove-control" });
    expect(e.exitCode).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
  });
  test("ownerSignerShortfall: exempt are the Twin chain, a dry run, the plan, verify, govern, pause-all, record-receipt, redeploy-vault and a stage list without prove-control", () => {
    expect(ownerSignerShortfall({ chainId: 918453, verb: "publish", dryRun: false, specs: [], sheet })).toBeUndefined();
    expect(ownerSignerShortfall({ chainId: 8453, verb: "publish", dryRun: true, specs: [], sheet })).toBeUndefined();
    expect(ownerSignerShortfall({ chainId: 8453, stage: "plan", dryRun: false, specs: [], sheet })).toBeUndefined();
    for (const verb of ["verify", "govern", "pause-all", "record-receipt", "redeploy-vault"] as const) expect(ownerSignerShortfall({ chainId: 8453, verb, dryRun: false, specs: [], sheet }), verb).toBeUndefined();
    expect(ownerSignerShortfall({ chainId: 8453, stage: "libs,vault", dryRun: false, specs: [], sheet })).toBeUndefined();
  });
  test("main(): two owner specs for a three-owner sheet exit CONTROL_NOT_PROVEN before stage 1: no signer, no forge call, no Safe, no checks_ok", async () => {
    const w = world({ chainId: 8453 });
    let signerMade = false;
    const code = await quiet(() => w.run(["publish", "--environment", "base-mainnet", ...ownerArgs(2)], { makeSigner: () => { signerMade = true; throw new Error("no signer"); } }));
    expect(code).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(signerMade).toBe(false);
    expect(forgeCalls(w)).toBe(0);
    expect(w.safeCalls).toEqual([]);
    expect(lastFailure(w)).toContain("before stage 1");
    expect(w.logs().some((l) => l.event === "run.checks_ok")).toBe(false);
  });
  test("main(): no owner spec at all on 8453 is the same refusal (the Twin default never applies there)", async () => {
    const w = world({ chainId: 8453 });
    const code = await quiet(() => w.run(["publish", "--environment", "base-mainnet"], { makeSigner: () => { throw new Error("no signer"); } }));
    expect(code).toBe(EXIT_CODES.CONTROL_NOT_PROVEN);
    expect(forgeCalls(w)).toBe(0);
    expect(lastFailure(w)).toContain("0 --owner-signer specs for a Safe of 3 owners");
  });
  test("main(): three owner specs pass the pre-stage-1 check (the run reaches run.checks_ok and no refusal names stage 1)", async () => {
    const w = world({ chainId: 8453 });
    await quiet(() => w.run(["publish", "--environment", "base-mainnet", ...ownerArgs(3)], { ownerSigner: async (s: string) => PROVE_SIGNERS[Number(s.slice(-1))]! }));
    expect(w.logs().some((l) => l.event === "run.checks_ok")).toBe(true);
    expect(lastFailure(w)).not.toContain("before stage 1");
  });
});

// qa-plan B2 (DT-3): CONFIRM=environment GITHUB_ACTIONS=true on a laptop used to skip the typed prompts on 8453. The flag is a string anyone
// exports; the proof is the job's GitHub OIDC token, fetched and verified by the CLI (actions-proof.ts) for --environment. The floor sees the
// proof, never the flag alone; off 8453 nothing changes.
describe("CONFIRM=environment on 8453 needs an Actions-only proof (qa-plan B2, DT-3)", () => {
  const c = callerInputs({ CONFIRM: "environment" });
  const ENV = "base-mainnet";
  const PROOF: ActionsProof = { repository: "robotmoney/release-driver", repositoryOwner: "robotmoney", environment: ENV, sub: `repo:robotmoney/release-driver:environment:${ENV}`, workflow: "publish", runId: "42" };
  /** What the Actions runner sets for a job with id-token: write; a laptop has GITHUB_ACTIONS at most. */
  const inActions = { GITHUB_ACTIONS: "true", [ACTIONS_TOKEN_ENV]: "runner-request-token", [ACTIONS_URL_ENV]: "https://pipelines.actions.githubusercontent.com/x/idtoken?api-version=2.0" };
  const floors = (o: Record<string, unknown>) => refusal(() => assertFloors(input(8453, { caller: c, environment: ENV, ...o })));

  test("CONFIRM=environment GITHUB_ACTIONS=true outside Actions (no id-token request token) is refused on 8453, by name", () => {
    const r = floors({ githubActions: true, env: { GITHUB_ACTIONS: "true" } });
    expect(r).toContain("FLOOR");
    expect(r).toContain(ACTIONS_TOKEN_ENV);
    expect(r).toContain("GITHUB_ACTIONS=true alone is not the proof");
  });
  test("without GITHUB_ACTIONS it is refused as before", () => {
    expect(floors({ githubActions: false })).toContain("only inside GitHub Actions");
  });
  test("the runner's request token alone is not the proof: with no verified OIDC token it is refused", () => {
    const r = floors({ githubActions: true, env: inActions });
    expect(r).toContain("FLOOR");
    expect(r).toContain("without a verified GitHub OIDC token");
  });
  test("--environment local or missing is refused even with a proof", () => {
    expect(floors({ githubActions: true, env: inActions, environment: "local", actionsProof: PROOF })).toContain("--environment");
    expect(floors({ githubActions: true, env: inActions, environment: undefined, actionsProof: PROOF })).toContain("--environment");
  });
  test("a verified token for another Environment is refused and the message names both", () => {
    const r = floors({ githubActions: true, env: inActions, actionsProof: { ...PROOF, environment: "base-rehearsal" } });
    expect(r).toContain("FLOOR");
    expect(r).toContain("'base-rehearsal'");
    expect(r).toContain(ENV);
  });
  test("a verified token for --environment passes the floor", () => {
    expect(floors({ githubActions: true, env: inActions, actionsProof: PROOF })).toBeUndefined();
  });
  test("the flag, the token and the proof lift nothing else on 8453: YES=1 stays refused next to a valid proof", () => {
    expect(floors({ caller: callerInputs({ CONFIRM: "environment", YES: "1" }), githubActions: true, env: inActions, actionsProof: PROOF })).toContain("YES=1 is refused");
  });
  test("off 8453 nothing changes: CONFIRM=environment is not a floor on the Twin chain", () => {
    expect(refusal(() => assertFloors(input(918453, { caller: c, environment: ENV, githubActions: true, env: { GITHUB_ACTIONS: "true" } })))).toBeUndefined();
    expect(refusal(() => assertFloors(input(918453, { caller: c, environment: ENV, githubActions: false })))).toBeUndefined();
  });

  test("through main(): CONFIRM=environment GITHUB_ACTIONS=true on a laptop exits FLOOR before any proof request, signer or forge call", async () => {
    const w = world({ chainId: 8453 });
    let signerMade = false;
    let proofAsked = false;
    const code = await quiet(() => w.run(["publish", "--environment", ENV, ...ownerArgs(3)], {
      env: { CONFIRM: "environment", GITHUB_ACTIONS: "true" },
      makeSigner: () => { signerMade = true; throw new Error("no signer"); },
      actionsProof: async () => { proofAsked = true; return PROOF; },
    }));
    expect(code).toBe(EXIT_CODES.FLOOR);
    expect(proofAsked).toBe(false);
    expect(signerMade).toBe(false);
    expect(forgeCalls(w)).toBe(0);
    expect(lastFailure(w)).toContain(ACTIONS_TOKEN_ENV);
    expect(w.logs().some((l) => l.event === "run.checks_ok")).toBe(false);
  });
  test("through main(): inside Actions the proof is requested once, for --environment, and a token that verifies passes the floors (run.checks_ok)", async () => {
    const w = world({ chainId: 8453 });
    const asked: { environment: string; hasToken: boolean }[] = [];
    const code = await quiet(() => w.run(["publish", "--environment", ENV, ...ownerArgs(3)], {
      env: { ...inActions, CONFIRM: "environment" },
      ownerSigner: async (s: string) => PROVE_SIGNERS[Number(s.slice(-1))]!,
      actionsProof: async (env, o) => { asked.push({ environment: o.environment, hasToken: env[ACTIONS_TOKEN_ENV] === inActions[ACTIONS_TOKEN_ENV] }); return PROOF; },
    }));
    expect(code).not.toBe(EXIT_CODES.FLOOR);
    expect(asked).toEqual([{ environment: ENV, hasToken: true }]);
    expect(w.logs().some((l) => l.event === "run.checks_ok")).toBe(true);
    const proofLine = w.logs().find((l) => l.event === "run.actions_proof") as Record<string, unknown> | undefined;
    expect(proofLine).toBeDefined();
    expect(proofLine).toMatchObject({ repository: PROOF.repository, environment: ENV, run_id: "42" });
    expect(JSON.stringify(proofLine)).not.toContain(inActions[ACTIONS_TOKEN_ENV]);
  });
  test("through main(): a token that does not verify is a FLOOR exit, never a skip, before any signer or forge call", async () => {
    const w = world({ chainId: 8453 });
    let signerMade = false;
    const code = await quiet(() => w.run(["publish", "--environment", ENV, ...ownerArgs(3)], {
      env: { ...inActions, CONFIRM: "environment" },
      makeSigner: () => { signerMade = true; throw new Error("no signer"); },
      actionsProof: async () => { throw new PublishError("FLOOR", "CONFIRM=environment: the OIDC token signature does not verify against GitHub's key"); },
    }));
    expect(code).toBe(EXIT_CODES.FLOOR);
    expect(signerMade).toBe(false);
    expect(forgeCalls(w)).toBe(0);
    expect(lastFailure(w)).toContain("does not verify");
  });
  test("through main(): a verified token for another Environment is refused by the floor (the proof seam is not the gate, the floor is)", async () => {
    const w = world({ chainId: 8453 });
    const code = await quiet(() => w.run(["publish", "--environment", ENV, ...ownerArgs(3)], {
      env: { ...inActions, CONFIRM: "environment" },
      makeSigner: () => { throw new Error("no signer"); },
      actionsProof: async () => ({ ...PROOF, environment: "base-rehearsal" }),
    }));
    expect(code).toBe(EXIT_CODES.FLOOR);
    expect(forgeCalls(w)).toBe(0);
    expect(lastFailure(w)).toContain("'base-rehearsal'");
  });
  test("through main(): on the Twin chain CONFIRM=environment never asks for a proof", async () => {
    const w = world({ chainId: 918453 });
    let proofAsked = false;
    await quiet(() => w.run(["--stage", "plan", "--environment", ENV], { env: { ...inActions, CONFIRM: "environment" }, actionsProof: async () => { proofAsked = true; return PROOF; } }));
    expect(proofAsked).toBe(false);
  });

  // The broadcast-time re-check: confirmStage runs before every stage that sends. A context built without the proof (or for another
  // Environment) never confirms a stage on 8453, whatever the Actions flag says; off 8453 the flag stays the whole rule.
  describe("confirmStage re-checks the proof at every broadcast on 8453", () => {
    const ctxFor = (o: Partial<RunContext>, lines: string[] = []): RunContext =>
      ({ chainId: 8453, environment: ENV, caller: c, githubActions: true, baseEnv: inActions, log: publishLogger((l) => lines.push(l)), ...o }) as unknown as RunContext;
    const refused = async (ctx: RunContext): Promise<PublishError> => { try { await confirmStage(ctx, "libs", "1 tx"); } catch (e) { return e as PublishError; } throw new Error("confirmStage did not refuse"); };
    test("no proof on 8453: FLOOR naming the stage, and nothing confirmed", async () => {
      const lines: string[] = [];
      const e = await refused(ctxFor({}, lines));
      expect(e.kind).toBe("FLOOR");
      expect(e.message).toContain("without a verified GitHub OIDC token");
      expect(e.message).toContain("stage libs");
      expect(lines.some((l) => l.includes("confirm.environment"))).toBe(false);
    });
    test("GITHUB_ACTIONS=true on a laptop (no request token) on 8453: FLOOR by name", async () => {
      const e = await refused(ctxFor({ baseEnv: { GITHUB_ACTIONS: "true" }, actionsProof: PROOF }));
      expect(e.kind).toBe("FLOOR");
      expect(e.message).toContain(ACTIONS_TOKEN_ENV);
    });
    test("a proof for another Environment on 8453: FLOOR naming both", async () => {
      const e = await refused(ctxFor({ actionsProof: { ...PROOF, environment: "base-rehearsal" } }));
      expect(e.kind).toBe("FLOOR");
      expect(e.message).toContain("'base-rehearsal'");
      expect(e.message).toContain(ENV);
    });
    test("without the Actions flag it is REFUSED as before, on every chain", async () => {
      expect((await refused(ctxFor({ githubActions: false, actionsProof: PROOF }))).kind).toBe("REFUSED");
      expect((await refused(ctxFor({ chainId: 918453, githubActions: false }))).kind).toBe("REFUSED");
    });
    test("a proof for --environment confirms the stage and logs the claims, never a token", async () => {
      const lines: string[] = [];
      await confirmStage(ctxFor({ actionsProof: PROOF }, lines), "libs", "1 tx");
      const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === "confirm.environment");
      expect(line).toMatchObject({ stage: "libs", environment: ENV, proof: { repository: PROOF.repository, environment: ENV, run_id: "42" } });
      expect(JSON.stringify(line)).not.toContain(inActions[ACTIONS_TOKEN_ENV]);
    });
    test("off 8453 the Actions flag confirms without a proof (nothing changes on the Twin chain)", async () => {
      const lines: string[] = [];
      await confirmStage(ctxFor({ chainId: 918453, baseEnv: { GITHUB_ACTIONS: "true" } }, lines), "libs", "1 tx");
      expect(lines.some((l) => l.includes("confirm.environment"))).toBe(true);
    });
  });
});

describe("docs: hardware is optional on 8453 and exit 29 is the owner-signer refusal (F1)", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
  const README = read("publish-contracts", "README.md");
  const DOCS: [string, string][] = [
    ["README", README], ["release runbook", read("docs", "operations", "contract-release-runbooks.md")],
    ["security model", read("docs", "technical", "security-model.md")], ["governance isomorphism", read("docs", "technical", "governance-isomorphism.md")],
  ];
  test("the README exit table names exit 29 as it is coded", () => {
    expect(EXIT_CODES.OWNER_SIGNER_REFUSED).toBe(29);
    expect(README).toContain("owner signer refused 29");
  });
  for (const [what, text] of DOCS) {
    test(`the ${what} says hardware is optional and no longer names the hardware-only floor`, () => {
      expect(text).not.toContain("OWNER_SIGNER_NOT_HARDWARE");
      expect(text).not.toMatch(/must be `ledger` or `trezor`/);
      expect(text).toMatch(/hardware[^.|]*optional|optional[^.|]*hardware/i);
    });
  }
});
