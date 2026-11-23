// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1 (the keeper service).
// Usage: bun src/cli.ts [--config <file.json|file.toml>] [--once]
//   The config path may also come from KEEPER_CONFIG. Every field can be overridden by KEEPER_<FIELD> (src/config.ts).
//   The keystore password comes from passwordFile (mode 0600), KEEPER_PASSWORD (cleared once read), or stdin.
// Exit codes: 0 a clean stop (or --once with no alert), 1 --once raised an alert, 2 bad config, a failed start-up
// check, or another instance holds the state dir lock.
import { readFileSync } from "node:fs";
import { Alerts, log } from "./alerts.ts";
import { makeChainIO } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { startHealthServer } from "./health.ts";
import { Keeper } from "./keeper.ts";
import { decryptKeystore, readPassword, readStdin } from "./keystore.ts";
import { runLoop } from "./loop.ts";
import { acquireLock, loadState, saveState } from "./state.ts";

function args(argv: string[]) {
  let config = process.env.KEEPER_CONFIG;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") config = argv[++i];
    else if (argv[i] === "--once") once = true;
    else throw Object.assign(new Error(`unknown argument '${argv[i]}'`), { exitCode: 2 });
  }
  return { config, once };
}

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  const cfg = loadConfig(a.config);
  const release = acquireLock(cfg.stateDir);
  process.on("exit", release);
  const state = loadState(cfg.stateDir);
  let keyJson: string;
  try {
    keyJson = readFileSync(cfg.keystore, "utf8");
  } catch {
    throw Object.assign(new Error(`keystore ${cfg.keystore} cannot be read`), { exitCode: 2 });
  }
  const password = await readPassword({ passwordFile: cfg.passwordFile, env: process.env, stdin: readStdin });
  const pk = decryptKeystore(keyJson, password);
  const { io, address } = makeChainIO([cfg.rpcUrl, ...cfg.rpcFallbackUrls], cfg.chainId, pk);
  const alerts = new Alerts({ realertSecs: cfg.realertSecs, webhook: cfg.alertWebhook, queue: cfg.queue, active: state.alerts });
  const keeper = new Keeper({ cfg, io, key: address, state, alerts });
  const health = cfg.healthPort > 0 ? startHealthServer(keeper.ctx.metrics, cfg.intervalSecs, cfg.healthPort) : undefined;
  try {
    await keeper.startup();
    if (a.once) {
      const r = await keeper.tick();
      saveState(cfg.stateDir, state);
      return r.alerts ? 1 : 0;
    }
    await runLoop({ tick: () => keeper.tick(), afterTick: () => saveState(cfg.stateDir, state) });
    log("stopped", {});
    return 0;
  } finally {
    saveState(cfg.stateDir, state);
    health?.stop();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    const code = (e as { exitCode?: number }).exitCode === 2 ? 2 : 1;
    const msg = String((e as Error)?.message ?? e).split("\n")[0];
    // Start-up failures before the Keeper exists still produce one keeper_unconfigured line (no secret in any message).
    if (code === 2 && !(e as { alerted?: boolean }).alerted) {
      process.stderr.write(JSON.stringify({ alert: "keeper_unconfigured", cause: "startup", detail: msg, ts: Math.floor(Date.now() / 1000) }) + "\n");
    } else {
      log("fatal", { error: msg });
    }
    process.exit(code);
  },
);
