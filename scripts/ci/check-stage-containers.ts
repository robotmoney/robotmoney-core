// CI gate for the stage stack in containers (core issue 1549). Bun TypeScript.
//
// Every stage service (the Twin chain, the deploy job, the dapp stack) runs in a container built reproducibly, and
// scripts/stage/core-stack.ts only calls `docker compose`. This gate fails on:
//   1. a Dockerfile FROM without a sha256 digest (a FROM that names an earlier stage is fine),
//   2. a compose service that pulls an image (no `build:`) without a digest,
//   3. `docker.sock` in any compose file, Dockerfile or stage script (no Docker socket mount, ever),
//   4. `cargo build|install|fetch|test` in a Dockerfile without `--locked`, `bun install` without `--frozen-lockfile`,
//   5. a missing lockfile (Cargo.lock, publish-contracts/bun.lock, clients/dapp/bun.lock),
//   6. host process machinery in core-stack.ts (spawn, detached processes, anvil, the harness binary).
// It also fails when it scanned nothing: a gate that read nothing proved nothing.
//
// Usage: bun scripts/ci/check-stage-containers.ts [repo-root]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Dockerfiles that build a stage image, relative to the repo root. */
export const DOCKERFILES = ["docker/rust-services.Dockerfile", "docker/stage-images.Dockerfile", "clients/dapp/Dockerfile"];
/** Compose files of the stage stack (the dapp stack, its stage overlay and the chain project). */
export const COMPOSE_FILES = [
  "testing/ethereum-testnet/config/docker-compose.dapp.yaml",
  "testing/ethereum-testnet/config/docker-compose.dapp.stage.yaml",
  "testing/ethereum-testnet/config/docker-compose.dapp.mainnet.yaml",
  "testing/ethereum-testnet/config/docker-compose.stage-chain.yaml",
];
/** Committed lockfiles the reproducible builds depend on. */
export const LOCKFILES = ["Cargo.lock", "publish-contracts/bun.lock", "clients/dapp/bun.lock"];
const CORE_STACK = "scripts/stage/core-stack.ts";
/** Places a socket mount could hide, besides the files above: every Dockerfile and compose file under these roots. */
const SOCKET_ROOTS = ["docker", "testing/ethereum-testnet/config", "clients/dapp", "scripts/stage"];

const DIGEST = /@sha256:[0-9a-f]{64}\b/;
/** Host process machinery that must not return to core-stack.ts. */
export const HOST_PROCESS_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /spawnDetached/, why: "a detached host process" },
  { re: /node:child_process/, why: "child_process (this tool only calls docker compose through deps.run)" },
  { re: /\bstdbuf\b/, why: "stdbuf (the old host harness launcher)" },
  { re: /"cargo",\s*"run"/, why: "cargo run (the old host harness)" },
  { re: /smoke-test",\s*"--full-stack"/, why: "the host harness in --full-stack mode" },
  { re: /twin-fork\.ts/, why: "the host Twin fork tool" },
  { re: /\banvil\b/, why: "a host anvil" },
];

export interface Violation {
  file: string;
  rule: string;
  detail: string;
}

const code = (text: string): string =>
  text
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

/** Joins `\`-continued lines so one instruction is one string. */
function instructions(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim().startsWith("#") && cur === "") continue;
    if (line.endsWith("\\")) {
      cur += `${line.slice(0, -1)} `;
      continue;
    }
    out.push((cur + line).trim());
    cur = "";
  }
  if (cur) out.push(cur.trim());
  return out.filter((l) => l !== "");
}

export function checkDockerfile(file: string, text: string): Violation[] {
  const v: Violation[] = [];
  const stages = new Set<string>();
  for (const ins of instructions(text)) {
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(ins);
    if (from) {
      const ref = from[1]!;
      if (!stages.has(ref) && ref !== "scratch" && !DIGEST.test(ref)) v.push({ file, rule: "image-digest", detail: `FROM ${ref} has no @sha256 digest` });
      if (from[2]) stages.add(from[2]);
      continue;
    }
    const copyFrom = /^COPY\s+--from=(\S+)/i.exec(ins);
    if (copyFrom && !stages.has(copyFrom[1]!) && /[:/]/.test(copyFrom[1]!) && !DIGEST.test(copyFrom[1]!)) {
      v.push({ file, rule: "image-digest", detail: `COPY --from=${copyFrom[1]} names an external image without a digest` });
    }
    if (!/^RUN\s/i.test(ins)) continue;
    for (const seg of ins.split(/&&|;|\|\|/)) {
      const s = seg.trim().replace(/^RUN\s+/i, "");
      if (/\bcargo\s+(build|install|fetch|test|check)\b/.test(s) && !/--locked\b/.test(s)) v.push({ file, rule: "locked-build", detail: `'${s}' is not --locked` });
      if (/\bbun\s+install\b/.test(s) && !/--frozen-lockfile\b/.test(s)) v.push({ file, rule: "frozen-install", detail: `'${s}' is not --frozen-lockfile` });
    }
  }
  return v;
}

export function checkCompose(file: string, text: string): Violation[] {
  const v: Violation[] = [];
  let doc: any;
  try {
    doc = (Bun as any).YAML.parse(text);
  } catch (e) {
    return [{ file, rule: "parse", detail: `not valid YAML: ${(e as Error).message}` }];
  }
  const services = doc?.services ?? {};
  for (const [name, svc] of Object.entries<any>(services)) {
    if (svc?.build) continue; // built locally from a Dockerfile this gate also checks
    const image = String(svc?.image ?? "");
    if (!image) continue;
    if (!DIGEST.test(image)) v.push({ file, rule: "image-digest", detail: `service ${name}: image ${image} has no @sha256 digest` });
  }
  return v;
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "target" || name === ".git" || name === "tests") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

export function checkCoreStack(file: string, text: string): Violation[] {
  const body = code(text);
  return HOST_PROCESS_PATTERNS.filter(({ re }) => re.test(body)).map(({ re, why }) => ({ file, rule: "no-host-process", detail: `${why} (${re})` }));
}

export interface Result {
  violations: Violation[];
  scanned: number;
}

export function check(root: string): Result {
  const violations: Violation[] = [];
  let scanned = 0;
  const read = (rel: string): string | undefined => {
    const p = join(root, rel);
    if (!existsSync(p)) {
      violations.push({ file: rel, rule: "missing-file", detail: "a stage stack file is missing" });
      return undefined;
    }
    scanned++;
    return readFileSync(p, "utf8");
  };
  for (const rel of DOCKERFILES) {
    const t = read(rel);
    if (t !== undefined) violations.push(...checkDockerfile(rel, t));
  }
  for (const rel of COMPOSE_FILES) {
    const t = read(rel);
    if (t !== undefined) violations.push(...checkCompose(rel, t));
  }
  for (const rel of LOCKFILES) {
    scanned++;
    if (!existsSync(join(root, rel))) violations.push({ file: rel, rule: "lockfile", detail: "the committed lockfile is missing" });
  }
  const stack = read(CORE_STACK);
  if (stack !== undefined) violations.push(...checkCoreStack(CORE_STACK, stack));
  // The socket rule covers every Dockerfile, compose file and stage script under the stage roots, not just the listed ones.
  const seen = new Set<string>();
  for (const r of SOCKET_ROOTS) {
    for (const p of walk(join(root, r))) {
      const rel = relative(root, p);
      if (seen.has(rel) || !/(Dockerfile|\.ya?ml|\.sh|\.ts)$/.test(rel) || /\.test\.ts$/.test(rel)) continue;
      seen.add(rel);
      scanned++;
      if (/docker\.sock/.test(readFileSync(p, "utf8"))) violations.push({ file: rel, rule: "no-docker-socket", detail: "mentions docker.sock: no stage container mounts the Docker socket" });
    }
  }
  return { violations, scanned };
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const { violations, scanned } = check(root);
  if (scanned === 0) {
    console.error("check-stage-containers: scanned nothing");
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const x of violations) console.error(`${x.file}: [${x.rule}] ${x.detail}`);
    console.error(`check-stage-containers: ${violations.length} violation(s) in ${scanned} files`);
    process.exit(1);
  }
  console.log(`check-stage-containers: ok (${scanned} files)`);
}
