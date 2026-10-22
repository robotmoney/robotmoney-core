// HISTORICAL ONLY (issue 1888). The govern row `register-committee` (issues 1727 and 1750) registered the consensus receipt submitter through the gateway and the IC policy:
// RobotMoneyGateway.setPolicy(submitter, policy) then RobotMoneyGateway.committeeRegister(submitter, label), one timelock batch. Both gateway routes and the IC policy are gone, so
// nothing builds that batch for a new run any more (the live row is `register-submitter`, submitter-register.ts). This module keeps ONLY what evidence-check needs to decode the
// calldata of the historical `committee_registrations` entries that pinned releases and rehearsal fixtures carry, so their evidence still validates.
// Pure module: it reads no chain and sends nothing.
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

/** The retired row name. Historical evidence entries carry `step: "register-committee"`. */
export const HISTORICAL_REGISTER_ROW = "register-committee";
/** The policy's validity from the schedule time, as the historical rows used it. */
export const SUBMITTER_POLICY_CAP = 1n;

const POLICY = "(bool active, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address shareReceiver, address[] allowedDestinations, address assetRecipient, uint256 maxWithdrawPerPayment, uint256 maxWithdrawPerWindow, address[] allowedSourceVaults)";
/** The two retired gateway selectors a historical registration batch called. They no longer exist on the gateway. */
export const HISTORICAL_GATEWAY_REGISTER_ABI = parseAbi([
  `function setPolicy(address agent, ${POLICY} p)`,
  "function committeeRegister(address agent, string agentId_)",
]);

export interface HistoricalRegisterCall { label: string; target: Address; data: Hex }

/** The signalling-only policy of the historical batch, paying shares to `shareReceiver` (the timelock). */
function submitterPolicy(shareReceiver: Address, validUntil: bigint) {
  return {
    active: true, validUntil, maxPerPayment: SUBMITTER_POLICY_CAP, maxPerWindow: SUBMITTER_POLICY_CAP, shareReceiver, allowedDestinations: [] as Address[],
    assetRecipient: "0x0000000000000000000000000000000000000000" as Address, maxWithdrawPerPayment: 0n, maxWithdrawPerWindow: 0n, allowedSourceVaults: [] as Address[],
  };
}

/** The two calls of a HISTORICAL public batch, in order, rebuilt from the recorded submitter, label and validUntil. */
export function buildHistoricalRegisterCalls(gateway: Address, timelock: Address, submitter: Address, agentLabel: string, validUntil: bigint): HistoricalRegisterCall[] {
  return [
    { label: `gateway.setPolicy(${submitter})`, target: gateway, data: encodeFunctionData({ abi: HISTORICAL_GATEWAY_REGISTER_ABI, functionName: "setPolicy", args: [submitter, submitterPolicy(timelock, validUntil)] }) },
    { label: `gateway.committeeRegister(${submitter}, ${agentLabel})`, target: gateway, data: encodeFunctionData({ abi: HISTORICAL_GATEWAY_REGISTER_ABI, functionName: "committeeRegister", args: [submitter, agentLabel] }) },
  ];
}
