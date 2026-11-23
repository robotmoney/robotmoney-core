// Anvil harness for the keeper service tests. Starts anvil, deploys the one-vault stack with the same deploy scripts the
// shell keeper's self-test uses (contracts/test/prototype/anvil), and gives chain helpers. It throws (the test fails
// loudly) when anvil or forge is missing or a contract does not deploy. It never skips.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createTestClient, createPublicClient, http, parseAbi, encodeFunctionData, type Address, type Hex,
} from "viem";
import { foundry } from "viem/chains";
import { fixtureKeystore, tmp } from "../test/helpers/fixtures.ts";

export const REPO = resolve(import.meta.dir, "../../..");

function need(bin: string) {
  if (!Bun.which(bin)) throw new Error(`${bin} is not installed (Foundry is required for the anvil suite)`);
}

function run(cmd: string[], env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(cmd, { cwd: REPO, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed:\n${p.stdout.toString().slice(-3000)}\n${p.stderr.toString().slice(-3000)}`);
  return p.stdout.toString();
}

const parseEnv = (text: string) =>
  Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));

export interface Stack {
  rpcUrl: string;
  deployer: Address; emergency: Address;
  bot: ReturnType<typeof fixtureKeystore>;
  keeperAccount?: Address;
  a: Record<string, string>;
  stop(): void;
}

const ERC = parseAbi([
  "function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)",
  "function setRound(uint8,int256,uint256,uint256)", "function requestDeposit(uint256,address) returns (uint256)",
  "function requestRedeem(uint256,address) returns (uint256)", "function settlementCount() view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)", "function deposit(uint256,address) returns (uint256)",
  "function setPaused(bool)", "function setClosed(bool)", "function delistAsset(uint256)", "function isAssetInSale(uint256) view returns (bool)",
  "function setTargetAndOpenPlan(address[],uint256[],(uint64,uint16),bytes32)", "function requestCount() view returns (uint256)",
  "function grantRole(bytes32,address)", "function KEEPER_ROLE() view returns (bytes32)",
  "function closed() view returns (bool)", "function assetBackoffUntil(uint256) view returns (uint64)",
]);

let portSeq = 18700 + Math.floor(Math.random() * 200);

/** Deploys the stack. account mode: a KeeperAccount holds KEEPER_ROLE with the bot as bot key. direct: the bot holds it. */
export async function deployStack(mode: "account" | "direct"): Promise<Stack> {
  for (const b of ["anvil", "forge"]) need(b);
  const port = portSeq++;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = Bun.spawn(["anvil", "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
  const pub = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  for (let i = 0; i < 100; i++) {
    try { await pub.getChainId(); break; } catch { await Bun.sleep(100); }
  }
  await pub.getChainId();
  const accts = (await pub.request({ method: "eth_accounts" } as any)) as Address[];
  const [deployer, emergency] = [accts[0]!, accts[1]!];
  const dir = tmp("keeper-anvil-");
  const bot = fixtureKeystore(dir);
  const t = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  await t.setBalance({ address: bot.address, value: 100n * 10n ** 18n });

  let keeperAccount: Address | undefined;
  if (mode === "account") {
    const out = run(["forge", "create", "contracts/KeeperAccount.sol:KeeperAccount", "--rpc-url", rpcUrl, "--unlocked", "--from", deployer,
      "--broadcast", "--json", "--constructor-args", `[${deployer}]`, `[${bot.address}]`]);
    keeperAccount = JSON.parse(out.slice(out.indexOf("{"))).deployedTo as Address;
  }
  const holder = keeperAccount ?? bot.address;
  mkdirSync(join(REPO, "out/prototype"), { recursive: true });
  const envOut = join(REPO, `out/prototype/keeper-service-anvil-${process.pid}-${port}.env`);
  const rebOut = join(REPO, `out/prototype/keeper-service-rebalancer-${process.pid}-${port}.env`);
  run(["forge", "script", "contracts/test/prototype/anvil/OneVaultDeliveryAnvil.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--unlocked",
    "--sender", deployer, "--slow"], { ONEVAULT_ANVIL_OUT: envOut, KEEPER_ADDRESS: holder, EMERGENCY_ADDRESS: emergency });
  const a: Record<string, string> = parseEnv(readFileSync(envOut, "utf8"));
  run(["forge", "script", "contracts/test/prototype/anvil/OneVaultKeeperAnvil.s.sol:OneVaultKeeperAnvil", "--rpc-url", rpcUrl, "--broadcast",
    "--unlocked", "--sender", deployer, "--slow"],
    { FUND_ADDRESS: a.FUND!, TIMELOCK_ADDRESS: a.TIMELOCK!, KEEPER_ADDRESS: holder, USDC_ADDRESS: a.USDC!, REBALANCER_ANVIL_OUT: rebOut });
  Object.assign(a, parseEnv(readFileSync(rebOut, "utf8")));
  rmSync(envOut, { force: true });
  rmSync(rebOut, { force: true });
  return { rpcUrl, deployer, emergency, bot, keeperAccount, a, stop: () => { anvil.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Chain helpers over a deployed stack. Every send is from an unlocked anvil account. */
export function helpers(s: Stack) {
  const pub = createPublicClient({ chain: foundry, transport: http(s.rpcUrl) });
  const t = createTestClient({ chain: foundry, mode: "anvil", transport: http(s.rpcUrl) });
  const A = (k: string) => s.a[k] as Address;
  const sendAbi = async (from: Address, to: Address, abi: readonly unknown[], fn: string, args: unknown[] = []) => {
    const data = encodeFunctionData({ abi, functionName: fn, args } as any);
    const hash = (await pub.request({ method: "eth_sendTransaction", params: [{ from, to, data }] } as any)) as Hex;
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${fn} reverted`);
  };
  const send = (from: Address, to: Address, fn: string, args: unknown[] = []) => sendAbi(from, to, ERC, fn, args);
  const call = <T>(to: Address, fn: string, args: unknown[] = []) => pub.readContract({ address: to, abi: ERC, functionName: fn, args } as any) as Promise<T>;
  const now = async () => Number((await pub.getBlock()).timestamp);
  const warp = async (secs: number) => { await t.increaseTime({ seconds: secs }); await t.mine({ blocks: 1 }); };
  const refreshFeeds = async () => {
    const n = BigInt(await now());
    await send(s.deployer, A("USDC_FEED"), "setRound", [8, 100000000n, n, n]);
    await send(s.deployer, A("SEQUENCER_FEED"), "setRound", [0, 0n, n - 86400n, n]);
    await send(s.deployer, A("BASKET_FEED"), "setRound", [8, 100000000n, n, n]);
  };
  /** 1 h 5 min past the next 6 h epoch start: the request's epoch is the settleable round and no later epoch has ended. */
  const waitForRound = async () => {
    const n = await now();
    const next = (Math.floor(n / 21600) + 1) * 21600;
    await warp(next + 3900 - n);
  };
  const requestDeposit = async (owner: Address, usdc = 1_000_000_000n) => {
    await send(s.deployer, A("USDC"), "mint", [owner, usdc]);
    await send(owner, A("USDC"), "approve", [A("QUEUE"), usdc]);
    await send(owner, A("QUEUE"), "requestDeposit", [usdc, owner]);
  };
  const settlements = () => call<bigint>(A("QUEUE"), "settlementCount");
  return { pub, t, A, send, sendAbi, call, now, warp, refreshFeeds, waitForRound, requestDeposit, settlements };
}
