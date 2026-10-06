// Safe 1.4.1 only. The canonical, deterministic deployments (same address on every chain that carries them, the Twin chain included).
// SafeL2 is the singleton for every chain we run: it emits the events an indexer reads.
import { parseAbi, type Address, type Hex } from "viem";

export const SAFE_VERSION = "1.4.1" as const;
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const BASE_MAINNET_CHAIN_ID = 8453;
export const TWIN_CHAIN_ID = 918453;
/** Chains the tool will sign or send on. Anything else needs an explicit `allowChainIds` (a local anvil for unit work). */
export const DEFAULT_ALLOWED_CHAIN_IDS: readonly number[] = [BASE_MAINNET_CHAIN_ID, TWIN_CHAIN_ID];

export const SAFE_141 = {
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address,
  singletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as Address,
  fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" as Address,
  multiSend: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526" as Address,
  multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as Address,
  signMessageLib: "0xd53cd0aB83D845Ac265BE939c57F53AD838012c9" as Address,
  createCall: "0x9b35Af71d77eaf8d7e40252370304687390A1A52" as Address,
  simulateTxAccessor: "0x3d4BA2E0884aa488718476ca2FB8Efc291A46199" as Address,
  /** keccak of the runtime code every canonical SafeProxy 1.4.1 carries (the factory's proxyCreationCode() with the singleton argument, run as a creation call: the 1.4.1 factory has no proxyRuntimeCode()). */
  proxyCodehash: "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c" as Hex,
} as const;

/** EIP-1967-style Safe storage: slot 0 is the singleton, this slot is the fallback handler. */
export const FALLBACK_HANDLER_SLOT: Hex = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";

export const SAFE_ABI = parseAbi([
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isOwner(address owner) view returns (bool)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function checkNSignatures(bytes32 dataHash, bytes data, bytes signatures, uint256 requiredSignatures) view",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
]);

export const FACTORY_ABI = parseAbi([
  "function proxyCreationCode() pure returns (bytes)",
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);

/** OpenZeppelin TimelockController (v4/v5 share these entry points). */
export const TIMELOCK_ABI = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) pure returns (bytes32)",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) pure returns (bytes32)",
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
  "function cancel(bytes32 id)",
  "function updateDelay(uint256 newDelay)",
]);

export const TIMELOCK_ROLES = ["PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE"] as const;
export type TimelockRole = (typeof TIMELOCK_ROLES)[number];

/** A new timelock delay outside this range is refused unless the caller says so (0, a unit typo or a huge value can brick the timelock). */
export const MIN_SAFE_DELAY = 3600n;
export const MAX_SAFE_DELAY = 2592000n;
