// The Twin upgrade rehearsal step script (publish-contracts/src/ci/twin-upgrade-rehearsal.ts, QA plan v1 P4, issue 1811) run with a stub CLI, cast and evidence
// checker over a fake twin-publish run dir. The stubs keep the chain state in files (STUB_STATE): `slot` is the ERC-1967 implementation of the upgraded proxy,
// `frozen` exists once the freeze round ran. The stub CLI logs one `cli <verb> [row] [admin args]` line per call; the stub cast logs `cast <args>`.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./fixtures.ts";
import { REPO_ROOT } from "./repo-root.ts";
import { loadStageTable, manifestFile, tableProxies } from "../src/stage-table.ts";
import { AUTHORITY_STAGE } from "../src/core-wiring.ts";

const SCRIPT = join(REPO_ROOT, "publish-contracts/src/ci/twin-upgrade-rehearsal.ts");
const a40 = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const TL = a40(0x7100);
const NEW_IMPL = a40(0x9e01);
const PASS = "stub-passphrase-not-a-real-one-42";
const TABLE = loadStageTable(REPO_ROOT);
const PROXIES = tableProxies(TABLE);
const proxyOf = (name: string) => a40(0x100 + PROXIES.findIndex((p) => p.name === name));
const implOf = (name: string) => a40(0x200 + PROXIES.findIndex((p) => p.name === name));
const REGISTRY = proxyOf("registry");
const ORIG = implOf("registry");
const REFUSAL = "govern row upgrade-proxy: registry is frozen: upgradeToAndCall would revert UpgradesAreFrozen after the delay. A frozen proxy never upgrades again (ADR-0014 §5). Nothing was sent";

/** A twin-publish run dir: merged sheet, passphrase, the DEPLOYER keystore, every proxy stage's manifest (from the real stage table), the authority manifest, a run manifest. */
function runDir(sheet = "UPGRADE_MODE=upgradeable\nDEPLOYMENT_KIND=production\n"): string {
  const rh = tmp("tur-run-");
  writeFileSync(join(rh, "sheet.env"), sheet);
  writeFileSync(join(rh, "passphrase"), PASS, { mode: 0o600 });
  mkdirSync(join(rh, "keys"));
  writeFileSync(join(rh, "keys", "DEPLOYER"), "{}");
  mkdirSync(join(rh, "manifests"));
  mkdirSync(join(rh, "evidence"));
  writeFileSync(join(rh, "evidence", "publish-run.json"), JSON.stringify({ govern: {} }, null, 2) + "\n");
  const files: Record<string, Record<string, string>> = {};
  const fileOf = (stage: string) => manifestFile(TABLE.stages.find((s) => s.name === stage)!.manifest);
  for (const p of PROXIES) Object.assign((files[fileOf(p.stage)] ??= {}), { [p.field]: proxyOf(p.name), [p.implementationField]: implOf(p.name) });
  Object.assign((files[fileOf(AUTHORITY_STAGE)] ??= {}), { timelock: TL });
  for (const [f, j] of Object.entries(files)) writeFileSync(join(rh, "manifests", f), JSON.stringify(j));
  return rh;
}

/** The build dir: VaultRegistry links nothing; RobotMoneyVault links a library (the rehearsal refuses to deploy it from the unlinked artifact). */
function buildDir(): string {
  const d = tmp("tur-out-");
  const art = (name: string, linkReferences: object) => { mkdirSync(join(d, `${name}.sol`)); writeFileSync(join(d, `${name}.sol`, `${name}.json`), JSON.stringify({ bytecode: { object: "0x6080604052", linkReferences } })); };
  art("VaultRegistry", {});
  art("RobotMoneyVault", { "contracts/lib/VaultAdapterOps.sol": { VaultAdapterOps: [{ start: 10, length: 20 }] } });
  return d;
}

function stubs(): Record<string, string> {
  const dir = tmp("tur-stub-");
  const f = (n: string, body: string, mode = 0o644) => { const p = join(dir, n); writeFileSync(p, body); chmodSync(p, mode); return p; };
  return {
    TWIN_CLI: f("cli.js", `
      const fs = require("node:fs"), path = require("node:path");
      const a = process.argv.slice(2), verb = a[0], v = (k) => a[a.indexOf(k) + 1];
      const S = process.env.STUB_STATE, log = process.env.STUB_LOG;
      const adminArgs = a.filter((x, i) => a[i - 1] === "--admin-arg");
      const row = a.includes("--row") ? v("--row") : a.includes("--call-label") ? "call-" + v("--call-label") : "";
      fs.appendFileSync(log, ["cli", verb, row, ...adminArgs].filter(Boolean).join(" ") + "\\n");
      fs.appendFileSync(log, "args " + a.join(" ") + "\\n");
      const n = fs.readFileSync(log, "utf8").split("\\n").filter((l) => l.startsWith("cli " + verb)).length;
      if (process.env.STUB_FAIL === verb || process.env.STUB_FAIL === verb + ":" + n) { console.error("stub: " + verb + " failed"); process.exit(3); }
      const frozen = fs.existsSync(path.join(S, "frozen"));
      const line = (r, phase) => console.log(JSON.stringify({ row: r, phase, txHash: "0x" + "ab".repeat(32), status: 1, readyAt: 0 }));
      const failed = (code, message) => { console.error(JSON.stringify({ level: "error", event: "run.failed", exit_code: code, message })); process.exit(code); };
      if (verb === "verify") { console.log("ok   - proxy[registry]: upgradesFrozen matches the mode and the executed freezes"); process.exit(0); }
      if (verb !== "govern") process.exit(0);
      if (row === "upgrade-proxy") {
        const post = process.env.STUB_POST_FREEZE ?? "refused";
        if (frozen && post === "refused") failed(14, ${JSON.stringify(REFUSAL)});
        if (frozen && post === "other-refusal") failed(14, "govern row upgrade-proxy: the target has no code: deploy the new implementation first. Nothing was sent");
        if (frozen && post === "usage") failed(2, "--row upgrade-proxy: registry is frozen (but this is a usage error)");
        line("upgrade-proxy", "scheduled"); line("upgrade-proxy", "executed");
        if (process.env.STUB_UPGRADE_SLOT !== "stay") fs.writeFileSync(path.join(S, "slot"), adminArgs.find((x) => x.startsWith("implementation=")).split("=")[1]);
        process.exit(0);
      }
      if (row === "freeze-proxy") {
        line("freeze-proxy", "scheduled"); line("freeze-proxy", "executed");
        if (process.env.STUB_FREEZE !== "noop") fs.writeFileSync(path.join(S, "frozen"), "1");
        process.exit(0);
      }
      if (row.startsWith("call-")) {
        const mode = process.env.STUB_CALL ?? "refused";
        if (mode === "unscheduled") failed(2, "call refused before anything was scheduled");
        line(row, "scheduled");
        if (mode === "executes") { line(row, "executed"); if (process.env.STUB_CALL_MOVES === "1") fs.writeFileSync(path.join(S, "slot"), v("--call-target")); process.exit(0); }
        failed(1, "the Safe rejected the call with GS013: Safe transaction failed when gasPrice and safeTxGas were 0");
      }
      process.exit(0);`),
    CAST: f("cast", `#!/usr/bin/env bash
echo "cast $*" >> "$STUB_LOG"
S="$STUB_STATE"
case "$1" in
  storage) printf '0x000000000000000000000000%s\\n' "$(sed 's/^0x//' "$S/slot")" ;;
  call)
    case "$3" in
      "upgradesFrozen()(bool)") if [ -f "$S/frozen" ] && [ "$2" != "\${STUB_UNFROZEN:-none}" ]; then echo true; else echo false; fi ;;
      "listVaults()(address[])") if [ "\${STUB_STATE_CHANGES:-}" = "1" ] && [ "$(cat "$S/slot")" != "$STUB_ORIG" ]; then echo "[0x0000000000000000000000000000000000000002]"; else echo "[0x0000000000000000000000000000000000000001]"; fi ;;
      "getMinDelay()(uint256)") echo "\${STUB_DELAY:-60}" ;;
      *) echo "stub cast: unexpected call $3" >&2; exit 9 ;;
    esac ;;
  send) echo "{\\"status\\":\\"\${STUB_SEND_STATUS:-0x1}\\",\\"contractAddress\\":\\"\${STUB_NEW_IMPL}\\",\\"transactionHash\\":\\"0x$(printf 'cd%.0s' $(seq 32))\\"}" ;;
  calldata) echo "0x4f1ef286000000000000000000000000\${3#0x}0000000000000000000000000000000000000000000000000000000000000040" ;;
  *) echo "stub cast: unexpected $1" >&2; exit 9 ;;
esac
`, 0o755),
    TWIN_EVIDENCE_CHECK: f("evidence.js", `
      require("node:fs").appendFileSync(process.env.STUB_LOG, "evidence " + process.argv.slice(2).join(" ") + "\\n");
      if (process.env.STUB_FAIL === "evidence") { console.error("evidence: stub problem"); process.exit(1); }
      console.log("evidence ok (1 proxy upgrade(s), 1 freeze(s), 1 post-freeze upgrade refused by the proxy, chain read)");`),
  };
}

function runScript(env: Record<string, string> = {}, o: { sheet?: string } = {}) {
  const rh = runDir(o.sheet);
  const state = tmp("tur-state-");
  writeFileSync(join(state, "slot"), ORIG);
  const work = tmp("tur-");
  const log = join(work, "log"), ghEnv = join(work, "env");
  writeFileSync(log, ""); writeFileSync(ghEnv, "");
  const r = Bun.spawnSync([process.execPath, SCRIPT], {
    env: { ...process.env, ...stubs(), STUB_LOG: log, STUB_STATE: state, STUB_NEW_IMPL: NEW_IMPL, STUB_ORIG: ORIG, STUB_FAIL: "",
      GITHUB_WORKSPACE: REPO_ROOT, GITHUB_ENV: ghEnv, RPC_URL: "http://127.0.0.1:1", TWIN_RUN_DIR: rh, TWIN_BUILD_DIR: buildDir(), UPGRADE_PROXY_IN: "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const exported = Object.fromEntries(readFileSync(ghEnv, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return {
    code: r.exitCode, err: r.stderr.toString(), out: r.stdout.toString(), rh, exported, all: lines,
    cli: lines.filter((l) => l.startsWith("cli ")).map((l) => l.slice(4)),
    args: lines.filter((l) => l.startsWith("args ")).map((l) => l.slice(5)),
    cast: lines.filter((l) => l.startsWith("cast ")).map((l) => l.slice(5)),
    evidence: lines.filter((l) => l.startsWith("evidence ")).map((l) => l.slice(9)),
  };
}

/** A green lifecycle as the stub CLI logs it: upgrade, verify, freeze of all, the refused tool upgrade (a rollback to ORIG), the refused Safe -> timelock call, verify. */
const GREEN_CLI = [
  `govern upgrade-proxy proxy=registry implementation=${NEW_IMPL}`,
  "verify",
  "govern freeze-proxy proxy=all",
  `govern upgrade-proxy proxy=registry implementation=${ORIG}`,
  "govern call-post-freeze-upgrade-registry",
  "verify",
] as const;

describe("twin-upgrade-rehearsal step script (QA plan v1 P4, issue 1811)", () => {
  test("a green run: governed upgrade, verify, freeze of every proxy, the post-freeze upgrade refused by the tool and by the proxy, verify, the evidence check", () => {
    const r = runScript();
    expect(r.err).not.toContain("twin-upgrade-rehearsal:");
    expect(r.code).toBe(0);
    expect(r.cli).toEqual([...GREEN_CLI]);
    // the evidence tool reads the run manifest AND the chain, names the refused call and uses the timelock's live delay as the floor
    expect(r.evidence).toHaveLength(1);
    const ev = r.evidence[0]!;
    expect(ev).toContain(`--proxy-lifecycle ${join(r.rh, "evidence", "publish-run.json")}`);
    expect(ev).toContain(`--timelock ${TL}`);
    expect(ev).toContain("--rejected-upgrade post-freeze-upgrade-registry");
    expect(ev).toContain("--delay-floor 60");
    expect(ev).toContain("--rpc http://127.0.0.1:1");
    expect(ev).toContain("--deployment-kind production");
    expect(r.all.findIndex((l) => l.startsWith("evidence "))).toBeGreaterThan(r.all.lastIndexOf("cli verify"));
    // the evidence folder and the labels folder are exported; the run dir (keys, passphrase) is not
    const out = r.exported.TWIN_UPGRADE_REHEARSAL_DIR!;
    expect(out).toBe(join(r.rh, "upgrade-rehearsal"));
    for (const f of ["upgrade-rows.txt", "freeze-rows.txt", "refused-upgrade.json", "rejected-upgrade-rows.txt", "evidence-check.txt", "publish-run.json", "upgrade-rehearsal.json"]) expect([f, existsSync(join(out, f))]).toEqual([f, true]);
    for (const f of ["verify-labels-post-upgrade.txt", "verify-labels-post-freeze.txt"]) expect(existsSync(join(r.exported.TWIN_UPGRADE_REHEARSAL_LABELS_DIR!, f))).toBe(true);
    expect(r.exported.TWIN_RUN_DIR).toBeUndefined();
    const summary = JSON.parse(readFileSync(join(out, "upgrade-rehearsal.json"), "utf8"));
    expect(summary.upgrade).toMatchObject({ proxy: "registry", proxy_address: REGISTRY, artifact: "VaultRegistry", from_implementation: ORIG, implementation: NEW_IMPL, state_read: "listVaults()(address[])" });
    expect(summary.upgrade.state_before).toBe(summary.upgrade.state_after);
    expect(summary.freeze.proxies).toEqual(PROXIES.map((p) => p.name));
    expect(summary.rejected_upgrades.map((x: { by: string; exit_code: number }) => [x.by, x.exit_code])).toEqual([["tool", 14], ["proxy", 1]]);
    const refused = JSON.parse(readFileSync(join(out, "refused-upgrade.json"), "utf8"));
    expect(refused).toMatchObject({ row: "upgrade-proxy", proxy: "registry", implementation: ORIG, exit_code: 14, refusal: REFUSAL });
    // the run dir's secrets never reach the evidence folder
    for (const f of ["upgrade-rows.txt", "freeze-rows.txt", "refused-upgrade.json", "rejected-upgrade-rows.txt", "upgrade-rehearsal.json"]) expect(readFileSync(join(out, f), "utf8")).not.toContain(PASS);
  });

  test("the new implementation is created by the deployer from the build artifact's creation code, and every govern and verify uses the twin-publish flags and run manifest", () => {
    const r = runScript();
    expect(r.code).toBe(0);
    const send = r.cast.filter((l) => l.startsWith("send "));
    expect(send).toHaveLength(1); // one implementation: the post-freeze target is the implementation the proxy ran before (a rollback), never a third deployment
    // `--create` is a cast subcommand: the options come first and the creation code last
    expect(send[0]).toBe(`send --keystore ${join(r.rh, "keys", "DEPLOYER")} --password-file ${join(r.rh, "passphrase")} --rpc-url http://127.0.0.1:1 --json --create 0x6080604052`);
    expect(send[0]).not.toContain(PASS);
    for (const a of r.args) {
      expect(a).toContain("--chain 918453");
      expect(a).toContain(`--sheet ${join(r.rh, "sheet.env")}`);
      expect(a).toContain(`--evidence ${join(r.rh, "evidence")}`);
      expect(a).toContain(`keystore:${join(r.rh, "keys", "DEPLOYER")}:${join(r.rh, "passphrase")}`);
      expect(a).not.toContain(PASS);
    }
    // the post-freeze upgrade through the Safe and the timelock is the generic Twin call of upgradeToAndCall(ORIG, 0x) on the registry proxy
    const call = r.args.find((a) => a.includes("--call-label"))!;
    expect(call).toContain("--call-label post-freeze-upgrade-registry");
    expect(call).toContain(`--call-target ${REGISTRY}`);
    expect(call).toMatch(new RegExp(`--call-data 0x4f1ef286000000000000000000000000${ORIG.slice(2)}`));
  });

  test("a frozen-at-deploy (or undeclared) sheet is refused before anything is deployed or sent", () => {
    for (const sheet of ["UPGRADE_MODE=frozen-at-deploy\n", "X=1\n"]) {
      const r = runScript({}, { sheet });
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("the lifecycle rehearsal needs upgradeable proxies");
      expect(r.cli).toEqual([]);
      expect(r.cast.filter((l) => l.startsWith("send "))).toEqual([]);
    }
  });

  test("a proxy whose build artifact links a library is refused before anything is sent, and an unknown proxy name too", () => {
    const linked = runScript({ UPGRADE_PROXY_IN: "rmUSDC" });
    expect(linked.code).not.toBe(0);
    expect(linked.err).toContain("RobotMoneyVault links libraries");
    expect(linked.cli).toEqual([]);
    const unknown = runScript({ UPGRADE_PROXY_IN: "nope" });
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain("'nope' is not a proxied contract");
    expect(unknown.cli).toEqual([]);
  });

  test("a missing twin-publish run dir is refused", () => {
    const r = runScript({ TWIN_RUN_DIR: join(tmp("tur-empty-"), "nothing") });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("run the twin-publish action with verify and govern in this job first");
  });

  for (const [fail, cli] of [["govern:1", GREEN_CLI.slice(0, 1)], ["verify:1", GREEN_CLI.slice(0, 2)], ["govern:2", GREEN_CLI.slice(0, 3)], ["verify:2", GREEN_CLI]] as const) {
    test(`a failing ${fail} stops the run there: no later step and no evidence check`, () => {
      const r = runScript({ STUB_FAIL: fail });
      expect(r.code).not.toBe(0);
      expect(r.cli).toEqual([...cli]);
      expect(r.evidence).toEqual([]);
      expect(r.exported.TWIN_UPGRADE_REHEARSAL_DIR).toBeUndefined();
    });
  }

  test("a failing evidence check fails the run and exports no evidence folder", () => {
    const r = runScript({ STUB_FAIL: "evidence" });
    expect(r.code).not.toBe(0);
    expect(r.cli).toEqual([...GREEN_CLI]);
    expect(r.exported.TWIN_UPGRADE_REHEARSAL_DIR).toBeUndefined();
  });

  test("an upgrade whose slot does not move, or that changes the proxy's state, fails before the freeze", () => {
    const stay = runScript({ STUB_UPGRADE_SLOT: "stay" });
    expect(stay.code).not.toBe(0);
    expect(stay.err).toContain(`not ${NEW_IMPL}`);
    expect(stay.cli).toEqual([GREEN_CLI[0]]);
    const state = runScript({ STUB_STATE_CHANGES: "1" });
    expect(state.code).not.toBe(0);
    expect(state.err).toContain("changed across the upgrade");
    expect(state.cli).toEqual([GREEN_CLI[0]]);
  });

  test("a freeze round after which a proxy still reads unfrozen fails before any post-freeze upgrade", () => {
    const noop = runScript({ STUB_FREEZE: "noop" });
    expect(noop.code).not.toBe(0);
    expect(noop.err).toContain("reads upgradesFrozen() false after the freeze round executed");
    expect(noop.cli).toEqual(GREEN_CLI.slice(0, 3));
    const one = runScript({ STUB_UNFROZEN: proxyOf("gateway") });
    expect(one.code).not.toBe(0);
    expect(one.err).toContain(`gateway ${proxyOf("gateway")} reads upgradesFrozen() false`);
  });

  test("the tool must refuse the post-freeze upgrade with GOVERN naming the freeze: a scheduled upgrade, another refusal or another exit code fails the run", () => {
    const upgrades = runScript({ STUB_POST_FREEZE: "upgrades" });
    expect(upgrades.code).not.toBe(0);
    expect(upgrades.err).toContain("exited 0: the tool scheduled an upgrade of a frozen proxy");
    const other = runScript({ STUB_POST_FREEZE: "other-refusal" });
    expect(other.code).not.toBe(0);
    expect(other.err).toContain("does not name the freeze");
    const usage = runScript({ STUB_POST_FREEZE: "usage" });
    expect(usage.code).not.toBe(0);
    expect(usage.err).toContain("exited 2, not 14 (GOVERN)");
    for (const r of [upgrades, other, usage]) expect(r.cli).not.toContain("govern call-post-freeze-upgrade-registry");
  });

  test("the Safe -> timelock post-freeze upgrade must be scheduled and then refused: an executed one or one never scheduled fails the run", () => {
    const executes = runScript({ STUB_CALL: "executes" });
    expect(executes.code).not.toBe(0);
    expect(executes.err).toContain("the Safe executed the upgrade of the frozen registry through the timelock");
    const unscheduled = runScript({ STUB_CALL: "unscheduled" });
    expect(unscheduled.code).not.toBe(0);
    expect(unscheduled.err).toContain("was never scheduled through the Safe on the timelock");
    for (const r of [executes, unscheduled]) {
      expect(r.cli).toEqual(GREEN_CLI.slice(0, 5));
      expect(r.evidence).toEqual([]);
    }
  });

  test("a zero timelock delay is refused: the lifecycle runs through a real delay", () => {
    const r = runScript({ STUB_DELAY: "0" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("minimum delay is 0");
    expect(r.evidence).toEqual([]);
  });

  test("the script uses only the CLI's own time warp: no anvil or evm RPC method is named", () => {
    expect(readFileSync(SCRIPT, "utf8")).not.toMatch(/\b(anvil|evm)_[a-zA-Z]+/);
  });
});
