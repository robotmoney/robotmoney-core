// Tests of scripts/ci/check-stage-containers.ts (core issue 1549). Each rule has a case that must fail on a mutated
// copy of the real stage files, and the real tree must pass: a rule that cannot fail proves nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check, checkCompose, checkCoreStack, checkDockerfile, COMPOSE_FILES, DOCKERFILES, LOCKFILES } from "./check-stage-containers.ts";

const REAL = join(import.meta.dir, "../..");
const WORK = mkdtempSync(join(tmpdir(), "stage-containers-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

let n = 0;
/** A copy of the stage files of the real tree, with `edit` applied to one of them. */
function tree(edit?: (rel: string, text: string) => string): string {
  const root = join(WORK, `t${n++}`);
  for (const rel of [...DOCKERFILES, ...COMPOSE_FILES, "scripts/stage/core-stack.ts"]) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, edit ? edit(rel, readFileSync(join(REAL, rel), "utf8")) : readFileSync(join(REAL, rel), "utf8"));
  }
  for (const rel of LOCKFILES) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), "");
  }
  return root;
}
const rules = (root: string) => check(root).violations.map((v) => v.rule);
const only = (target: string, f: (t: string) => string) => (rel: string, t: string) => (rel === target ? f(t) : t);

describe("the real stage stack", () => {
  test("passes the gate", () => {
    const r = check(REAL);
    expect(r.violations).toEqual([]);
    expect(r.scanned).toBeGreaterThan(8);
  });
  test("the copied tree passes too (the mutation baseline)", () => expect(rules(tree())).toEqual([]));
});

describe("image digests", () => {
  test("a Dockerfile FROM without a digest fails", () => {
    const r = tree(only("docker/stage-images.Dockerfile", (t) => t.replace(/(FROM debian:bookworm-slim)@sha256:[0-9a-f]{64}/, "$1")));
    expect(rules(r)).toContain("image-digest");
  });
  test("a FROM that names an earlier stage needs no digest", () => {
    expect(checkDockerfile("x", "FROM a/b:1@sha256:" + "0".repeat(64) + " AS base\nFROM base AS next\n")).toEqual([]);
  });
  test("an external COPY --from image without a digest fails", () => {
    expect(checkDockerfile("x", "FROM a/b:1@sha256:" + "0".repeat(64) + "\nCOPY --from=ghcr.io/x/y:1 /a /b\n").map((v) => v.rule)).toEqual(["image-digest"]);
  });
  test("a compose service that pulls an unpinned image fails", () => {
    const r = tree(only("testing/ethereum-testnet/config/docker-compose.dapp.yaml", (t) => t.replace(/(image: postgres:16-alpine)@sha256:[0-9a-f]{64}/, "$1")));
    expect(rules(r)).toContain("image-digest");
  });
  test("a compose service that builds locally needs no digest on its tag", () => {
    expect(checkCompose("x", "services:\n  a:\n    image: local:tag\n    build: {context: .}\n")).toEqual([]);
  });
});

describe("no Docker socket", () => {
  test("a socket mount in a stage compose file fails", () => {
    const r = tree(only("testing/ethereum-testnet/config/docker-compose.stage-chain.yaml", (t) => t.replace("volumes:\n  twin-cache:", "volumes:\n  twin-cache:\n  # - /var/run/docker.sock:/var/run/docker.sock")));
    expect(rules(r)).toContain("no-docker-socket");
  });
  test("a socket mount in a Dockerfile fails", () => {
    expect(rules(tree(only("docker/rust-services.Dockerfile", (t) => `${t}\nVOLUME /var/run/docker.sock\n`)))).toContain("no-docker-socket");
  });
  test("a socket mention in a stage script fails", () => {
    expect(rules(tree(only("scripts/stage/core-stack.ts", (t) => `${t}\n// -v /var/run/docker.sock\n`)))).toContain("no-docker-socket");
  });
});

describe("reproducible builds", () => {
  test("cargo build without --locked fails", () => {
    expect(rules(tree(only("docker/rust-services.Dockerfile", (t) => t.replace(/^RUN cargo build --release --locked/m, "RUN cargo build --release"))))).toContain("locked-build");
  });
  test("cargo build in a multi-command RUN without --locked fails", () => {
    expect(checkDockerfile("x", "FROM a@sha256:" + "0".repeat(64) + "\nRUN apt-get update && cargo build --release\n").map((v) => v.rule)).toEqual(["locked-build"]);
  });
  test("bun install without --frozen-lockfile fails", () => {
    expect(rules(tree(only("docker/stage-images.Dockerfile", (t) => t.replace(/^RUN bun install --frozen-lockfile/m, "RUN bun install"))))).toContain("frozen-install");
  });
  test("a missing lockfile fails", () => {
    const r = tree();
    rmSync(join(r, "publish-contracts/bun.lock"));
    expect(rules(r)).toContain("lockfile");
  });
  test("a missing stage file fails", () => {
    const r = tree();
    rmSync(join(r, "docker/stage-images.Dockerfile"));
    expect(rules(r)).toContain("missing-file");
  });
});

describe("core-stack starts no host process", () => {
  const cases: [string, string][] = [
    ["spawnDetached", "deps.spawnDetached(cmd, log, cwd);"],
    ["node:child_process", 'import { spawn } from "node:child_process";'],
    ["stdbuf", 'run(["stdbuf", "-oL"]);'],
    ["cargo run", 'run(["cargo", "run", "-p", "smoke-test"]);'],
    ["the host harness", 'run(["smoke-test", "--full-stack"]);'],
    ["twin-fork.ts", 'run(["bun", "scripts/devnet/twin-fork.ts", "start"]);'],
    ["anvil", 'run(["anvil", "--port", "18545"]);'],
  ];
  for (const [name, line] of cases) {
    test(`${name} fails`, () => {
      expect(checkCoreStack("scripts/stage/core-stack.ts", line).map((v) => v.rule)).toEqual(["no-host-process"]);
      expect(rules(tree(only("scripts/stage/core-stack.ts", (t) => `${t}\n${line}\n`)))).toContain("no-host-process");
    });
  }
  test("a comment that names them is not code", () => {
    expect(checkCoreStack("x", "// the old host anvil and spawnDetached are gone\n")).toEqual([]);
  });
});

describe("the gate reads something", () => {
  test("an empty directory is not a pass", () => {
    const r = check(join(WORK, "does-not-exist"));
    expect(r.violations.length).toBeGreaterThan(0);
  });
  test("the CLI exits 1 on a violation and 0 on the real tree", () => {
    const run = (root: string) => Bun.spawnSync(["bun", join(REAL, "scripts/ci/check-stage-containers.ts"), root]).exitCode;
    expect(run(REAL)).toBe(0);
    expect(run(tree(only("docker/rust-services.Dockerfile", (t) => t.replace(/^RUN cargo build --release --locked/m, "RUN cargo build --release"))))).toBe(1);
  });
});
