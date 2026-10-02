#!/usr/bin/env bun
/**
 * Nightly job (b): a fresh Base snapshot at the latest block (core issue 1496).
 *
 * Canonical: docs/development/ci-suites.md (nightly fresh snapshot), owner
 * design 2026-10-02. Orchestration is Bun TypeScript; the capture itself stays
 * scripts/devnet/snapshot-fork.ts (anvil forking Base, deploying nothing the
 * production scheme does not ship) and the Twin chain genesis is built by the
 * existing smoke-test-genesis-ingester.
 *
 * No secret, no archive node, nothing committed:
 *   - reads use the public endpoints in scripts/devnet/fork-rpc-lib.sh, with
 *     the same HTTP 429 back-off (fork_rpc_retry) the shell side uses;
 *   - state is read at the LATEST block, which public endpoints serve;
 *   - every output lands in --out (a runner temp dir), never in a tracked path.
 *
 * Subcommands:
 *   snapshot --out DIR    capture at the latest block into DIR and write
 *                         DIR/snapshot-manifest.json (block number, hash,
 *                         timestamp).
 *   realign  --out DIR    build the overlay DIR/overlay/** that mirrors the repo
 *                         layout: CURRENT.json, CURRENT.anvil-state,
 *                         genesis-alloc.json, fork-block.json and
 *                         expected-prices.json, all aligned to the fresh block.
 *   apply    --from DIR   copy DIR/overlay/** over the working tree of THIS
 *                         runner (the suites then boot the Twin chain from it).
 *                         The tree is never committed by the job.
 *
 * Usage: bun scripts/devnet/nightly-fresh-snapshot.ts <subcommand> [flags]
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO = resolve(dirname(import.meta.path), "..", "..");
const LIB = join(REPO, "scripts/devnet/fork-rpc-lib.sh");

const FORK_STATE_REL = "testing/fixtures/fork-state";
const CONFIG_REL = "testing/ethereum-testnet/config";

function die(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function flag(name: string, args: string[]): string {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) die(`${name} is required`);
  return args[i + 1];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Public endpoints, exactly as fork-rpc-lib.sh resolves them. */
async function publicEndpoints(): Promise<string[]> {
  const p = Bun.spawn(["bash", "-c", `. "${LIB}" && fork_rpc_public_endpoints`], { stdout: "pipe" });
  const out = await new Response(p.stdout).text();
  const eps = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (eps.length === 0) die("fork-rpc-lib.sh listed no public endpoints");
  return eps;
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<unparseable RPC URL>";
  }
}

/** JSON-RPC with 429 / 5xx back-off. Never logs the URL, only its origin. */
async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const max = Number(process.env.FORK_RPC_RETRY_MAX ?? 8);
  let delay = Number(process.env.FORK_RPC_RETRY_SLEEP ?? 2) * 1000;
  for (let attempt = 1; ; attempt++) {
    let retryable = false;
    let err = "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429 || res.status >= 500) {
        retryable = true;
        err = `HTTP ${res.status}`;
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${origin(url)}`);
      } else {
        const j: any = await res.json();
        if (j.error) {
          const m = String(j.error.message ?? "");
          if (/rate.?limit|too many requests|429/i.test(m)) {
            retryable = true;
            err = m;
          } else {
            throw new Error(`${method}: ${m}`);
          }
        } else {
          return j.result;
        }
      }
    } catch (e) {
      if (!retryable) {
        // network errors are transient too; bounded by the same attempt budget
        if (e instanceof TypeError) {
          retryable = true;
          err = String(e.message);
        } else throw e;
      }
    }
    if (!retryable || attempt >= max) die(`${method} on ${origin(url)} failed after ${attempt} attempt(s): ${err}`);
    console.error(`[nightly-snapshot] ${origin(url)} ${err}; retry ${attempt}/${max} in ${delay / 1000}s`);
    await sleep(delay);
    delay = Math.min(delay * 2, 60_000);
  }
}

async function run(cmd: string[], env: Record<string, string> = {}, capture = false): Promise<string> {
  const p = Bun.spawn(cmd, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const out = capture ? await new Response(p.stdout).text() : "";
  const code = await p.exited;
  if (code !== 0) die(`${cmd[0]} ${cmd.slice(1, 3).join(" ")} exited ${code}`);
  return out;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ── snapshot ────────────────────────────────────────────────────────────────

async function snapshot(out: string): Promise<void> {
  mkdirSync(out, { recursive: true });
  const endpoints = await publicEndpoints();

  // The first endpoint that answers with a latest block wins. A configured
  // RMPC_FORK_RPC_URL is deliberately ignored: the nightly must need no key.
  let endpoint = "";
  for (const ep of endpoints) {
    try {
      const b = await rpc(ep, "eth_getBlockByNumber", ["latest", false]);
      if (b?.number) {
        endpoint = ep;
        console.log(`[nightly-snapshot] using ${origin(ep)}, tip ${parseInt(b.number, 16)}`);
        break;
      }
    } catch {
      /* try the next endpoint */
    }
  }
  if (!endpoint) die("no public Base endpoint served the latest block");

  // The capture deploys nothing and needs no key: transactions run from anvil's
  // unlocked dev account inside the snapshot node.
  await run(["bun", "scripts/devnet/snapshot-fork.ts"], {
    RMPC_FORK_RPC_URL: endpoint,
    FORK_PIN_LAG: "0",
    FIXTURE_DIR: join(out, "fork-state"),
    ANVIL_EXTRA_ARGS: process.env.ANVIL_EXTRA_ARGS ?? "--retries 30 --fork-retry-backoff 2000",
  });

  const current = JSON.parse(readFileSync(join(out, "fork-state/CURRENT.json"), "utf8"));
  const blockNumber: number = current.fork_block;
  const blk = await rpc(endpoint, "eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false]);
  if (!blk?.hash) die(`could not read block ${blockNumber} from ${origin(endpoint)}`);
  const timestamp = parseInt(blk.timestamp, 16);

  const manifest = {
    chain: "base",
    chain_id: 8453,
    block_number: blockNumber,
    block_hash: blk.hash as string,
    block_timestamp: timestamp,
    block_time_utc: new Date(timestamp * 1000).toISOString(),
    captured_at: current.captured_at as string,
    state_sha256: current.state_sha256 as string,
    upstream_origin: origin(endpoint),
    twin_chain_id: 918453,
    workflow_run: process.env.GITHUB_RUN_ID ?? null,
  };
  writeFileSync(join(out, "snapshot-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[nightly-snapshot] manifest: block ${blockNumber} ${manifest.block_hash} @ ${manifest.block_time_utc}`);
}

// ── realign ─────────────────────────────────────────────────────────────────

/** sqrtPriceX96 -> human price of base in quote (bigint math, as uniswapV3.ts). */
function sqrtPriceToPrice(sqrt: bigint, d0: number, d1: number, baseIsToken0: boolean): number {
  const SCALE = 10n ** 36n;
  const Q96 = 2n ** 96n;
  let r = (sqrt * sqrt * SCALE) / (Q96 * Q96);
  const delta = d0 - d1;
  r = delta >= 0 ? r * 10n ** BigInt(delta) : r / 10n ** BigInt(-delta);
  if (baseIsToken0) return Number(r) / 1e36;
  if (r === 0n) die("price underflow");
  return Number((SCALE * SCALE) / r) / 1e36;
}

async function realign(out: string): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(out, "snapshot-manifest.json"), "utf8"));
  const overlayFork = join(out, "overlay", FORK_STATE_REL);
  const overlayCfg = join(out, "overlay", CONFIG_REL);
  mkdirSync(overlayFork, { recursive: true });
  mkdirSync(overlayCfg, { recursive: true });

  for (const f of ["CURRENT.json", "CURRENT.anvil-state"]) cpSync(join(out, "fork-state", f), join(overlayFork, f));
  const stateSha = sha256(join(overlayFork, "CURRENT.anvil-state"));

  // fork-block.json: keep the committed ingest set and harness grant, move the pin.
  const fb = JSON.parse(readFileSync(join(REPO, CONFIG_REL, "fork-block.json"), "utf8"));
  fb.block_number = manifest.block_number;
  fb.block_hash = manifest.block_hash;
  fb.snapshot_uri = `file://${FORK_STATE_REL}/genesis-alloc.json`;
  fb.pinned = true;
  fb.snapshot_sha256 = "0x" + stateSha;
  const fbPath = join(overlayCfg, "fork-block.json");
  writeFileSync(fbPath, JSON.stringify(fb, null, 2) + "\n");

  // Twin chain genesis alloc, built in the runner by the existing ingester.
  await run([
    "cargo", "run", "--quiet", "--release",
    "--manifest-path", "testing/smoke-test/Cargo.toml",
    "--bin", "smoke-test-genesis-ingester", "--",
    "--manifest", fbPath,
    "--snapshot", join(overlayFork, "CURRENT.anvil-state"),
    "--output", join(overlayFork, "genesis-alloc.json"),
    "--require-pinned",
  ]);

  // expected-prices.json: the landing-strip prices at the fresh block, read from
  // the pools' slot0 at that same block over the public endpoint.
  const ep = JSON.parse(readFileSync(join(REPO, CONFIG_REL, "expected-prices.json"), "utf8"));
  const endpoint = (await publicEndpoints())[0];
  const blockTag = "0x" + Number(manifest.block_number).toString(16);
  for (const pair of ep.pairs) {
    const slot0: string = await rpc(endpoint, "eth_getStorageAt", [pair.pool, "0x0", blockTag]);
    const sqrt = BigInt(slot0) & ((1n << 160n) - 1n);
    if (sqrt === 0n) die(`pool ${pair.pool} (${pair.id}) has zero slot0 at block ${manifest.block_number}`);
    const price = sqrtPriceToPrice(sqrt, pair.base_is_token0 ? pair.base_decimals : pair.quote_decimals,
      pair.base_is_token0 ? pair.quote_decimals : pair.base_decimals, pair.base_is_token0);
    pair.expected_price = Number(price.toPrecision(8));
    pair.captured = true;
  }
  ep.fork_block = manifest.block_number;
  ep.captured = true;
  ep.pinned_on_archive_fork = true;
  writeFileSync(join(overlayCfg, "expected-prices.json"), JSON.stringify(ep, null, 2) + "\n");
  console.log(`[nightly-snapshot] overlay built for block ${manifest.block_number}`);
}

// ── apply ───────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function apply(from: string): void {
  const overlay = join(from, "overlay");
  if (!existsSync(overlay)) die(`${overlay} not found; was the snapshot artifact downloaded?`);
  for (const f of walk(overlay)) {
    const rel = relative(overlay, f);
    const dest = join(REPO, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(f, dest);
    console.log(`[nightly-snapshot] applied ${rel}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "snapshot":
    await snapshot(resolve(flag("--out", rest)));
    break;
  case "realign":
    await realign(resolve(flag("--out", rest)));
    break;
  case "apply":
    apply(resolve(flag("--from", rest)));
    break;
  default:
    die("usage: nightly-fresh-snapshot.ts snapshot|realign --out DIR | apply --from DIR");
}
