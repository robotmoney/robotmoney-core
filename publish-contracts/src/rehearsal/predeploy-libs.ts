// Twin chain only: deploys the four CREATE2 libraries of the core deploy (TickMath, and BasketAssetConfigGuard, TwapTickMath, BasketViews) onto the fork BEFORE a run,
// through the real CREATE2 factory with the real build, exactly like forge would, so a Twin rehearsal can prove the run where every library already exists (issue 1721).
// It is the state the Base mainnet has after its real deploy. Refuses unless the RPC is a non-Base anvil fork (requireTwin). A library whose code is already there
// must be the build's (hash compared), else it fails. Nothing here can reach a real chain.
import { keccak256, type Hex } from "viem";
import { CREATE2_FACTORY, CREATE2_SALT, buildCreate2Libraries, type Create2Built } from "../libs-adopt.ts";
import type { TableCreate2Library } from "../stage-table.ts";
import { requireTwin, type Rpc } from "./twin.ts";

/** An address nobody holds a role on: it only pays gas for the library creations. */
export const PREDEPLOY_SENDER = "0x00000000000000000000000000000000000d9911";

export async function predeployLibraries(rpc: Rpc, libs: TableCreate2Library[], outDir: string): Promise<{ built: Create2Built; created: boolean }[]> {
  await requireTwin(rpc);
  const factoryCode = String(await rpc("eth_getCode", [CREATE2_FACTORY, "latest"]));
  if (factoryCode === "0x") throw new Error(`the CREATE2 factory ${CREATE2_FACTORY} has no code on this fork`);
  const out: { built: Create2Built; created: boolean }[] = [];
  for (const built of buildCreate2Libraries(libs, outDir).values()) {
    const code = String(await rpc("eth_getCode", [built.address, "latest"]));
    if (code !== "0x") {
      if (keccak256(code as Hex) !== built.runtimeHash) throw new Error(`${built.name} at ${built.address} holds code that is not the build's (hash ${keccak256(code as Hex)}, expected ${built.runtimeHash})`);
      out.push({ built, created: false });
      continue;
    }
    await rpc("anvil_setBalance", [PREDEPLOY_SENDER, "0xde0b6b3a7640000"]);
    await rpc("anvil_impersonateAccount", [PREDEPLOY_SENDER]);
    const hash = await rpc("eth_sendTransaction", [{ from: PREDEPLOY_SENDER, to: CREATE2_FACTORY, data: `${CREATE2_SALT}${built.creation.slice(2)}`, gas: "0x989680" }]);
    let rc = (await rpc("eth_getTransactionReceipt", [hash])) as { status?: string } | null;
    for (let i = 0; !rc && i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); rc = (await rpc("eth_getTransactionReceipt", [hash])) as { status?: string } | null; }
    if (!rc || rc.status !== "0x1") throw new Error(`the creation of ${built.name} did not succeed (receipt ${JSON.stringify(rc)})`);
    const after = String(await rpc("eth_getCode", [built.address, "latest"]));
    if (after === "0x" || keccak256(after as Hex) !== built.runtimeHash) throw new Error(`${built.name} was created but ${built.address} does not hold the build's runtime code`);
    out.push({ built, created: true });
  }
  return out;
}
