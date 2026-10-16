// The core timelock's CREATE2 prediction, pinned across the deploy stages (issue 1835).
// Canonical: docs/technical/contract-upgradeability-plan.md (Mechanism and authority), docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md.
//
// Every proxy names the timelock from its first block: the CREATE2 address (stage table `upgradeAuthority`: factory, keccak256(salt)) of the TimelockController init
// code for the Safe and TIMELOCK_MIN_DELAY (contracts/script/UpgradeAuthority.sol predictTimelock). That init code is the build's creation code, CBOR metadata included,
// so a toolchain change between the first proxy stage and the timelock stage would move the address and leave every proxy naming a timelock nobody can deploy.
// The runner therefore derives the prediction from the build here, pins it in the run manifest at the first proxy stage, and refuses every later proxy stage and
// the timelock stage before their broadcast when the recomputed prediction differs (issue 1853; scripts/ci/check-timelock-prediction-parity.ts holds this
// function equal to UpgradeAuthority.predictTimelock). The same prediction lets the timelock stage adopt a timelock someone else already deployed at that address (anyone can: the init
// code is public once the proxies are on chain).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, getAddress, getCreate2Address, keccak256, toBytes, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import type { AdoptedLibrary } from "./libs-adopt.ts";
import type { UpgradeAuthority } from "./stage-table.ts";

/** What the first proxy stage records (`StageRecord.timelockPrediction`) and the timelock stage recomputes. */
export interface TimelockPrediction { address: Address; initCodeHash: Hex; safe: Address; minDelay: string }

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** The build artifact of the timelock contract: its creation code and runtime code. A missing or empty artifact fails closed. */
function timelockArtifact(outDir: string, contract: string): { creation: Hex; runtime: Hex } {
  const path = join(outDir, `${contract}.sol`, `${contract}.json`);
  if (!existsSync(path)) throw new PublishError("MANIFEST", `timelock prediction: no build artifact ${path}, so the core timelock address cannot be derived. Nothing was sent.`, { path });
  const j = JSON.parse(readFileSync(path, "utf8"));
  const creation = String(j.bytecode?.object ?? ""), runtime = String(j.deployedBytecode?.object ?? "");
  if (!/^0x([0-9a-fA-F]{2})+$/.test(creation) || !/^0x([0-9a-fA-F]{2})+$/.test(runtime)) throw new PublishError("MANIFEST", `timelock prediction: the build artifact ${path} has no creation or runtime bytecode. Nothing was sent.`, { path });
  return { creation: creation as Hex, runtime: runtime as Hex };
}

/** `UpgradeAuthority.timelockInitCode(safe, minDelay)`: creation code ++ abi.encode(minDelay, [safe], [address(0)], address(0)). */
export function timelockInitCode(creation: Hex, safe: Address, minDelay: bigint): Hex {
  const args = encodeAbiParameters([{ type: "uint256" }, { type: "address[]" }, { type: "address[]" }, { type: "address" }], [minDelay, [getAddress(safe.toLowerCase())], [ZERO], ZERO]);
  return `${creation}${args.slice(2)}` as Hex;
}

/** `UpgradeAuthority.predictTimelock(safe, minDelay)` from the build in `outDir`, and the keccak256 of the timelock's runtime code. */
export function predictCoreTimelock(u: Pick<UpgradeAuthority, "contract" | "factory" | "salt">, outDir: string, safe: Address, minDelay: bigint): TimelockPrediction & { runtimeHash: Hex } {
  const art = timelockArtifact(outDir, u.contract);
  const initCodeHash = keccak256(timelockInitCode(art.creation, safe, minDelay));
  const address = getCreate2Address({ from: u.factory as Address, salt: keccak256(toBytes(u.salt)), bytecodeHash: initCodeHash });
  return { address, initCodeHash, safe, minDelay: minDelay.toString(), runtimeHash: keccak256(art.runtime) };
}

const same = (a: TimelockPrediction, b: TimelockPrediction): boolean => a.address.toLowerCase() === b.address.toLowerCase() && a.initCodeHash.toLowerCase() === b.initCodeHash.toLowerCase();

/**
 * The timelock stage (and a resumed first proxy stage): the prediction recomputed from this build must equal the one the first proxy stage pinned. Otherwise the
 * proxies name an address this build would not deploy the timelock at. MANIFEST, nothing sent.
 */
export function assertTimelockPin(stage: string, pinnedBy: string, pinned: TimelockPrediction | undefined, now: TimelockPrediction): void {
  if (!pinned) throw new PublishError("MANIFEST", `stage ${stage}: the run manifest has no timelock prediction from the first proxy stage ${pinnedBy}, so it cannot be shown that every proxy names the timelock this build deploys. Run the deploy from stage ${pinnedBy} with this release of publish-contracts. Nothing was sent.`, { stage, pinnedBy });
  if (!same(pinned, now)) {
    throw new PublishError("MANIFEST", `stage ${stage}: the core timelock prediction changed since stage ${pinnedBy}: pinned ${pinned.address} (init code hash ${pinned.initCodeHash}, Safe ${pinned.safe}, delay ${pinned.minDelay}), recomputed ${now.address} (init code hash ${now.initCodeHash}, Safe ${now.safe}, delay ${now.minDelay}). Every proxy names the pinned address. A different toolchain, build or sheet would deploy the timelock elsewhere. Rebuild with the toolchain of the first proxy stage. Nothing was sent.`, { stage, pinned, recomputed: now });
  }
}

/**
 * Timelock stage: the TimelockController already sits at the predicted address (anyone can deploy it there once the proxies are public), so the stage script
 * reuses it and sends one transaction fewer. Adopted only when the runtime code there hashes to the build's TimelockController runtime code. Returns the adoption
 * entry, or none: no code, or other code (the stage then keeps its frozen count and a shortfall is the usual COUNT_MISMATCH).
 */
export async function adoptableCoreTimelock(contract: string, p: TimelockPrediction & { runtimeHash: Hex }, getCode: (a: Address) => Promise<string>): Promise<AdoptedLibrary[]> {
  const code = (await getCode(p.address)).toLowerCase();
  if (code === "" || code === "0x") return [];
  const got = keccak256(code as Hex);
  return got === p.runtimeHash ? [{ name: contract, artifact: contract, address: p.address, codeHash: got }] : [];
}
