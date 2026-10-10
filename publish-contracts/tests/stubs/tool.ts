// A stand-in for forge and cast, put on PATH by the runner tests. It keeps a tiny chain in a JSON file ($STUB_STATE): a deployer nonce,
// the chain id and a log of every call. Behaviour per script comes from $STUB_CONFIG. It is a test double for the TOOLS (the real
// forge and cast run later, on the Twin chain). It stands in for no contract, no Safe and no governance.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface Cfg {
  counts: Record<string, number>;          // script file -> tx count of simulation and broadcast
  sent?: Record<string, number>;           // script file -> tx count the broadcast really sends (a mismatch)
  failBroadcast?: string;                  // script file whose first broadcast dies halfway
  failBroadcastOutput?: { stdout?: string; stderr?: string }; // what that failing broadcast prints (default: a dropped RPC on stdout)
  castReplies?: Record<string, { stdout?: string; stderr?: string; code?: number }>; // cast subcommand -> its canned reply (receipt, call)
  simFails?: string;                       // script file whose simulation fails
  zeroTx?: string;                         // script file that plans ZERO transactions (issue 1721): exit 0, "Script ran successfully.", no SIMULATION COMPLETE, no broadcast file; the manifest is still written
  zeroTxBumps?: number;                    // with zeroTx: the deployer nonce moves by this much during the run (its own transaction landed meanwhile)
  codeAt?: Record<string, string>;         // lower-case address -> the runtime code `cast code` prints there (default: STUB_CODE)
  libsAddress?: string;                    // the tick_math address the stub manifest holds (default 0x1009)
  chainId: number;
  gitDirty?: string[];                     // `git status --porcelain` lines the stub git prints (default: a clean tree)
}
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

/** The runtime code the stub cast returns for any address. harness.ts pins its hash as the USDC hash. */
export const STUB_CODE = "0x6001600155";

export async function stub(tool: "forge" | "cast" | "git"): Promise<void> {
  const args = process.argv.slice(2);
  const statePath = process.env.STUB_STATE!;
  const cfg: Cfg = JSON.parse(readFileSync(process.env.STUB_CONFIG!, "utf8"));
  const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { nonces: {}, calls: [], resumed: [] };
  st.resumed ??= []; st.calls ??= []; st.nonces ??= {};
  const secret = Object.keys(process.env).filter((k) => /PRIVATE_KEY|ETH_PASSWORD|MNEMONIC|CHAIN_SIGNER|^YES$|^CONFIRM$/.test(k));
  st.calls.push({ tool, args, hasRpcEnv: !!process.env.ETH_RPC_URL, rpcEnv: process.env.ETH_RPC_URL, secretEnv: secret, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/PRIVATE_KEY|ETH_PASSWORD|MNEMONIC|CHAIN_SIGNER|^YES$|^CONFIRM$/.test(k))), argv0: basename(process.argv[1] ?? "") });
  const save = () => writeFileSync(statePath, JSON.stringify(st));
  const out = (s: string, code = 0): never => { save(); process.stdout.write(s + "\n"); process.exit(code); };

  if (tool === "git") {
    // only the read-only status of the core checkout is ever asked: anything else is an error the test sees
    if (args[0] !== "-C" || args[2] !== "status" || args[3] !== "--porcelain") out(`stub git: unsupported ${args.join(" ")}`, 1);
    out((cfg.gitDirty ?? []).join("\n"));
  }

  if (tool === "cast") {
    const [cmd, a0] = args;
    const reply = cfg.castReplies?.[cmd!];
    if (reply) { process.stderr.write(reply.stderr ?? ""); out(reply.stdout ?? "", reply.code ?? 0); }
    if (cmd === "chain-id") out(String(cfg.chainId));
    if (cmd === "nonce") out(String(st.nonces[a0!.toLowerCase()] ?? 0));
    if (cmd === "balance") out("10000000000000000000");
    if (cmd === "client") out("stub-node/1.0");
    if (cmd === "block-number") out("100");
    if (cmd === "rpc") out("null");
    if (cmd === "code") out(cfg.codeAt?.[a0!.toLowerCase()] ?? STUB_CODE);
    if (cmd === "codehash") out(`0x${"ab".repeat(32)}`);
    out(`stub cast: unsupported ${cmd}`, 1);
  }

  if (args[0] === "--version") out("forge 1.0.0-stub");
  if (args[0] !== "script") out(`stub forge: unsupported ${args[0]}`, 1);
  const script = args[1]!;
  const file = basename(script.split(":")[0]!);
  const chain = args[args.indexOf("--chain") + 1]!;
  const sender = (args[args.indexOf("--sender") + 1] ?? "").toLowerCase();
  const broadcast = args.includes("--broadcast");
  const resume = args.includes("--resume");
  const count = cfg.counts[file];
  if (count === undefined) out(`stub forge: no count for ${file}`, 1);
  if (cfg.simFails === file) out("Error: script failed", 1);

  const writeFiles = (n: number, dry: boolean) => {
    if (cfg.zeroTx === file) n = -1; // zero planned transactions: forge writes no broadcast file, only the script's own manifest
    const dir = join("broadcast", file, chain, ...(dry ? ["dry-run"] : []));
    if (n >= 0) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run-latest.json"), JSON.stringify({
        transactions: Array.from({ length: n }, (_, i) => ({ hash: `0x${(i + 1).toString(16).padStart(64, "0")}` })),
        ...(dry ? {} : { receipts: Array.from({ length: n }, () => ({ blockNumber: "0x64" })) }),
      }));
    }
    const outPath = process.env.DEPLOYMENT_OUT;
    if (outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify({
        vault: addr(0x1001), registry: addr(0x1002), router: addr(0x1003), gateway: addr(0x1004), governance: addr(0x1005), policy: addr(0x1006),
        consensus_receipt: addr(0x1007), timelock: addr(0x1008), tick_math: cfg.libsAddress ?? addr(0x1009), adapter: addr(0xa2),
        recorder: addr(0x100a), adapter_v4: addr(0xa4),
      }));
    }
  };

  if (cfg.zeroTx === file) { st.nonces[sender] = (st.nonces[sender] ?? 0) + (cfg.zeroTxBumps ?? 0); writeFiles(0, !broadcast); out("Script ran successfully."); }
  if (!broadcast) {
    writeFiles(count, true);
    out(`Estimated amount required: 0.000001 ETH\nSIMULATION COMPLETE. To broadcast these transactions, add --broadcast`);
  }
  if (cfg.failBroadcast === file && !resume && !(st.resumed ?? []).includes(file)) {
    st.broadcastStart = { ...(st.broadcastStart ?? {}), [file]: st.nonces[sender] ?? 0 };
    st.nonces[sender] = (st.nonces[sender] ?? 0) + Math.max(1, Math.floor(count / 2));
    if (cfg.failBroadcastOutput) { process.stderr.write(cfg.failBroadcastOutput.stderr ?? ""); out(cfg.failBroadcastOutput.stdout ?? "", 1); }
    out("Error: RPC connection dropped", 1);
  }
  if (resume) st.resumed.push(file);
  const sent = cfg.sent?.[file] ?? count;
  const startNonce = st.broadcastStart?.[file] ?? (st.nonces[sender] ?? 0);
  st.broadcastStart = { ...(st.broadcastStart ?? {}), [file]: startNonce };
  st.nonces[sender] = startNonce + sent;
  writeFiles(sent, false);
  out("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.");
}
