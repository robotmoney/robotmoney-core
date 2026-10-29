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
  callAt?: Record<string, string>;         // lower-case address -> what `cast call <address> ...` prints there (before castReplies.call; issue 1866: one proxy reads another timelock)
  emptyCode?: string[];                    // addresses `cast code` answers 0x for (no code). Default: the Safe the fake Safe API predicts, a fresh address (issue 1727); [] gives it code
  simFails?: string;                       // script file whose simulation fails
  zeroTx?: string;                         // script file that plans ZERO transactions (issue 1721): exit 0, "Script ran successfully.", no SIMULATION COMPLETE, no broadcast file; the manifest is still written
  zeroTxBumps?: number;                    // with zeroTx: the deployer nonce moves by this much during the run (its own transaction landed meanwhile)
  codeAt?: Record<string, string>;         // lower-case address -> the runtime code `cast code` prints there (default: STUB_CODE)
  creates?: Record<string, string[]>;     // script file -> the CREATE2 library addresses its first transactions create (issue 1721); the file marks them transactionType CREATE2
  libsAddress?: string;                    // the tick_math address the stub manifest holds (default 0x1009)
  chainId: number;
  forgeVersion?: string;                   // what `forge --version` prints (issue 1926: the runner refuses any forge but the pinned one). Default: the pinned 1.8.5
  vaultOut?: Record<string, string>;       // script file -> the vault address the stub manifest holds (default 0x1001): a redeploy writes a NEW vault (issue 1796)
                                           // and its FIRST broadcast transaction is the deployer's CREATE of it (QA plan v1 C2: the receipt's contractAddress)
  createdOut?: Record<string, string>;     // script file -> the address that CREATE receipt names instead (a manifest that is not the created contract)
  revertedReceipt?: Record<string, number>; // script file -> the index of a broadcast receipt whose status is 0x0 (forge still reported success)
  staleNonceReads?: Record<string, number>; // script file -> how many `cast nonce` reads of the sender after its successful broadcast answer the nonce from BEFORE it
                                           // (QA plan v1 E6, issue 1723: a load-balanced RPC node behind the broadcast block)
  gitDirty?: string[];                     // `git status --porcelain` lines the stub git prints (default: a clean tree)
  gitDirtyFor?: Record<string, string[]>;  // issue 1927: the lines for one `git -C <dir> status` (the --upgrade-build checkout), before gitDirty
  gitCountsDirty?: string[];               // issue 1816: the lines it prints for the path-limited status of the frozen counts file (default: committed and clean)
  gitAncestor?: boolean;                   // tooling-sha.ts: `git merge-base --is-ancestor` answers 0 (default: not an ancestor)
  gitInputsChanged?: string[];             // tooling-sha.ts: the deployed-input paths `git diff --name-only` prints (default: none)
  manifestMode?: Record<string, string>;   // script file -> the upgrade_mode its manifest records instead of the UPGRADE_MODE it read (issue 1809: a stage that came back in another mode)
  upgradeTimelock?: Record<string, string>; // script file -> the upgrade_timelock its manifest records instead of the prediction (issue 1835: a stage built with another toolchain)
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
    // only the read-only status of the core checkout and the tooling-sha reads are ever asked: anything else is an error the test sees
    if (args[0] === "-C" && args[2] === "merge-base" && args[3] === "--is-ancestor") out("", cfg.gitAncestor ? 0 : 1);
    if (args[0] === "-C" && args[2] === "diff" && args[3] === "--name-only") out((cfg.gitInputsChanged ?? []).join("\n"));
    if (args[0] !== "-C" || args[2] !== "status" || args[3] !== "--porcelain") out(`stub git: unsupported ${args.join(" ")}`, 1);
    out(((args.includes("--") ? cfg.gitCountsDirty : cfg.gitDirtyFor?.[args[1]!] ?? cfg.gitDirty) ?? []).join("\n"));
  }

  if (tool === "cast") {
    const [cmd, a0] = args;
    if (cmd === "call" && cfg.callAt?.[a0!.toLowerCase()] !== undefined) out(cfg.callAt[a0!.toLowerCase()]!);
    const reply = cfg.castReplies?.[cmd!];
    if (reply) { process.stderr.write(reply.stderr ?? ""); out(reply.stdout ?? "", reply.code ?? 0); }
    if (cmd === "chain-id") out(String(cfg.chainId));
    if (cmd === "nonce" && st.stale?.left > 0 && st.stale.who === a0!.toLowerCase()) { st.stale.left--; out(String(st.stale.nonce)); }
    if (cmd === "nonce") out(String(st.nonces[a0!.toLowerCase()] ?? 0));
    if (cmd === "balance") out("10000000000000000000");
    if (cmd === "client") out("stub-node/1.0");
    if (cmd === "block-number") out("100");
    if (cmd === "rpc") out("null");
    if (cmd === "code") out(cfg.codeAt?.[a0!.toLowerCase()] ?? ((cfg.emptyCode ?? ["0x00000000000000000000000000000000000050fe"]).includes((a0 ?? "").toLowerCase()) ? "0x" : STUB_CODE));
    if (cmd === "codehash") out(`0x${"ab".repeat(32)}`);
    out(`stub cast: unsupported ${cmd}`, 1);
  }

  if (args[0] === "--version") out(cfg.forgeVersion ?? "forge Version: 1.8.5-v1.8.5\nCommit SHA: stub");
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

  // issue 1835: like the real stage scripts, a proxy stage names the CREATE2 prediction of the core timelock (build artifact, SAFE_ADDRESS, TIMELOCK_MIN_DELAY)
  const upgradeTimelock = async (): Promise<string> => {
    if (cfg.upgradeTimelock?.[file]) return cfg.upgradeTimelock[file]!;
    if (process.env.GATEWAY_UPGRADE_TIMELOCK) return process.env.GATEWAY_UPGRADE_TIMELOCK; // issue 1892: the gateway stage names the explicit timelock of its sheet
    if (!existsSync(join("out", "ProposerFloorTimelock.sol", "ProposerFloorTimelock.json")) || !process.env.SAFE_ADDRESS || !process.env.TIMELOCK_MIN_DELAY) return addr(0x1008);
    const [{ loadStageTable }, { predictCoreTimelock }] = await Promise.all([import("../../src/stage-table.ts"), import("../../src/timelock-pin.ts")]);
    return predictCoreTimelock(loadStageTable(".").upgradeAuthority!, "out", process.env.SAFE_ADDRESS as `0x${string}`, BigInt(process.env.TIMELOCK_MIN_DELAY)).address;
  };
  // Like real forge: `forge script --broadcast` runs the script (which writes its manifest) and then sends; `--resume` only sends what is missing from the
  // broadcast cache and never runs the script, so it writes no manifest (Deploy 3, 2026-10-18).
  const writeFiles = async (n: number, dry: boolean, manifest = true) => {
    if (cfg.zeroTx === file) n = -1; // zero planned transactions: forge writes no broadcast file, only the script's own manifest
    const dir = join("broadcast", file, chain, ...(dry ? ["dry-run"] : []));
    if (n >= 0) {
      mkdirSync(dir, { recursive: true });
      const hash = (i: number) => `0x${(i + 1).toString(16).padStart(64, "0")}`;
      // a redeploy (vaultOut) CREATEs its vault in its first transaction; forge copies each receipt's status, sender and created contract from the chain (QA plan v1 C2)
      const created = cfg.vaultOut?.[file] !== undefined ? (cfg.createdOut?.[file] ?? cfg.vaultOut[file]!) : undefined;
      writeFileSync(join(dir, "run-latest.json"), JSON.stringify({
        transactions: Array.from({ length: n }, (_, i) => ({
          hash: hash(i), ...(cfg.creates?.[file]?.[i] ? { transactionType: "CREATE2", contractAddress: cfg.creates[file]![i] } : {}),
          ...(i === 0 && created ? { transactionType: "CREATE", contractName: "ProtocolAssetVault", contractAddress: created } : {}),
        })),
        ...(dry ? {} : { receipts: Array.from({ length: n }, (_, i) => ({ transactionHash: hash(i), blockNumber: "0x64", status: cfg.revertedReceipt?.[file] === i ? "0x0" : "0x1", from: sender, contractAddress: i === 0 && created ? created : null })) }),
      }));
    }
    const outPath = process.env.DEPLOYMENT_OUT;
    if (outPath && manifest) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify({
        vault: cfg.vaultOut?.[file] ?? addr(0x1001), registry: addr(0x1002), router: addr(0x1003), gateway: addr(0x1004), governance: addr(0x1005), policy: addr(0x1006),
        consensus_receipt: addr(0x1007), timelock: addr(0x1008), tick_math: cfg.libsAddress ?? addr(0x1009), adapter: addr(0xa2),
        recorder: addr(0x100a), adapter_v4: addr(0xa4),
        // issue 1808/1809: a proxy stage records each implementation, the upgrade authority and the release mode it read (UPGRADE_MODE)
        ...(process.env.UPGRADE_MODE ? {
          vault_implementation: addr(0x1101), registry_implementation: addr(0x1102), router_implementation: addr(0x1103), gateway_implementation: addr(0x1104),
          governance_implementation: addr(0x1105), policy_implementation: addr(0x1106), consensus_receipt_implementation: addr(0x1107), implementation: addr(0x1108),
          upgrade_timelock: await upgradeTimelock(), upgrade_mode: cfg.manifestMode?.[file] ?? process.env.UPGRADE_MODE,
        } : {}),
        // the vault stage's three strategy adapters (issue 1705 C4: the verifier sheet reads them)
        aave_adapter: addr(0xe1), compound_adapter: addr(0xe2), moonwell_flagship_adapter: addr(0xe3),
      }));
    }
  };

  if (cfg.zeroTx === file) { st.nonces[sender] = (st.nonces[sender] ?? 0) + (cfg.zeroTxBumps ?? 0); await writeFiles(0, !broadcast); out("Script ran successfully."); }
  if (!broadcast) {
    await writeFiles(count, true);
    out(`Estimated amount required: 0.000001 ETH\nSIMULATION COMPLETE. To broadcast these transactions, add --broadcast`);
  }
  if (cfg.failBroadcast === file && !resume && !(st.resumed ?? []).includes(file)) {
    st.broadcastStart = { ...(st.broadcastStart ?? {}), [file]: st.nonces[sender] ?? 0 };
    st.nonces[sender] = (st.nonces[sender] ?? 0) + Math.max(1, Math.floor(count / 2));
    const outPath = process.env.DEPLOYMENT_OUT;
    if (outPath) { mkdirSync(dirname(outPath), { recursive: true }); await writeFiles(-1, false); } // the script ran before the send failed: its manifest is on disk
    if (cfg.failBroadcastOutput) { process.stderr.write(cfg.failBroadcastOutput.stderr ?? ""); out(cfg.failBroadcastOutput.stdout ?? "", 1); }
    out("Error: RPC connection dropped", 1);
  }
  if (resume) st.resumed.push(file);
  const sent = cfg.sent?.[file] ?? count;
  const startNonce = st.broadcastStart?.[file] ?? (st.nonces[sender] ?? 0);
  st.broadcastStart = { ...(st.broadcastStart ?? {}), [file]: startNonce };
  st.nonces[sender] = startNonce + sent;
  if (cfg.staleNonceReads?.[file]) st.stale = { who: sender, nonce: startNonce, left: cfg.staleNonceReads[file] };
  await writeFiles(sent, false, !resume);
  out("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.");
}
