// The one source of truth for the chain ids and the mainnet timelock delay floor. No other file under src defines or compares against these literals
// (tests/constants-single-source.test.ts fails if one appears). The Solidity twin is DeployTimelock.s.sol MAINNET_MIN_DELAY, pinned equal by the same test.
export const MAINNET_CHAIN_ID = 8453;
export const TWIN_CHAIN_ID = 918453;
export const MAINNET_DELAY_FLOOR = 172800;

export const isMainnet = (chainId: number): boolean => chainId === MAINNET_CHAIN_ID;
/** The timelock delay floor: 172800 s on 8453, at least 1 s on any other chain. */
export const delayFloor = (chainId: number): number => (isMainnet(chainId) ? MAINNET_DELAY_FLOOR : 1);
