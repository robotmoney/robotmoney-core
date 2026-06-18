// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §11 — Vault Catalog; docs/architecture.md §4.2 — Portfolio Router
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {RwaVault} from "../vaults/RwaVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IChronicleOracle} from "../interfaces/IChronicleOracle.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {AerodromeSwapAdapter} from "../adapters/AerodromeSwapAdapter.sol";
import {ChronicleOracleAdapter} from "../adapters/ChronicleOracleAdapter.sol";
import {IUniswapV4SwapRouter} from "../interfaces/IUniswapV4SwapRouter.sol";
import {IAerodromeRouter} from "../interfaces/IAerodromeRouter.sol";
import {IAerodromeSlipstreamRouter} from "../interfaces/IAerodromeSlipstreamRouter.sol";

/// @notice Demo-only stand-in ERC20 for the basket-vault devnet seeds. The
///         devnet has no real liquidity for the PRD §11.2 protocol basket
///         (wETH, cbBTC, wSOL) or the §11.3 agent shortlist; this fills both
///         baskets so `BasketVault.addAsset` can wire entries and the dapp can
///         enumerate them. Never deployed on mainnet (this script is demo-only).
contract DemoBasketToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice Permissionless mint used by demo router stubs to simulate swap output.
    ///         Demo-only; never deployed on mainnet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Minimal Uniswap V3 pool stub exposing `token0()`/`token1()` and
///         `slot0()`. `BasketVault.addAsset` verifies that the pool pairs the
///         basket token with USDC and that `slot0().observationCardinality >= 2`.
///         Demo-only; no swap/observe liquidity.
contract DemoUsdcPool {
    address public immutable token0;
    address public immutable token1;
    int24 public constant tickSpacing = 10_000;

    constructor(address tokenA, address tokenB) {
        // Order is irrelevant to addAsset's check; store as given.
        token0 = tokenA;
        token1 = tokenB;
    }

    /// @notice Stub slot0 — returns observationCardinality = 2 so that
    ///         `BasketVault.addAsset` passes the MIN_POOL_CARDINALITY check.
    ///         All other fields are zeroed (unused by addAsset).
    function slot0()
        external
        pure
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (0, 0, 0, 2, 2, 0, true);
    }

    /// @notice Stub liquidity — returns a value above MIN_POOL_LIQUIDITY (1e6)
    ///         so that `BasketVault.addAsset` passes the minimum-liquidity gate.
    ///         Demo pools are not real Uniswap V3 pools; this value is purely
    ///         a stub to satisfy the gate check without forking mainnet.
    function liquidity() external pure returns (uint128) {
        return 1e18;
    }

    /// @notice Stub observe — returns zero tick cumulatives (1:1 price, tick=0)
    ///         over any requested window. BasketVault._twapQuote uses this to
    ///         compute the TWAP minimum swap output: at tick=0 the price is 1:1
    ///         (1 basket token = 1 USDC). Demo-only; no real TWAP data.
    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
        // All entries zero: arithmetic-mean tick = 0 → sqrtPriceX96 = 2^96 → price 1:1.
    }
}

/// @notice Minimal Uniswap V3 router stub for demo purposes. Swaps USDC ↔ token
///         at a 1:1 rate by minting the output token (DemoBasketToken) to the
///         recipient. The devnet has no real Uniswap V3 SwapRouter02; this stub
///         is used as the `swapRouter` parameter so V3-venue assets (BNKR) can
///         execute deposit swaps in the demo harness. Demo-only.
contract DemoV3SwapRouter {
    function exactInputSingle(ISwapRouter.ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut)
    {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        DemoBasketToken(params.tokenOut).mint(params.recipient, params.amountIn);
        return params.amountIn;
    }
}

/// @notice Minimal Uniswap V4 router stub for demo purposes. Records swaps
///         (USDC in → token out) at a 1:1 rate, minting the output token to the
///         recipient. The devnet has no real V4 router; this stub satisfies the
///         UniswapV4SwapAdapter's exactInputSingle call during demo deposit tests.
///         Demo-only; never deployed on mainnet.
contract DemoV4SwapRouter {
    function exactInputSingle(IUniswapV4SwapRouter.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        // Determine input and output tokens from zeroForOne direction.
        address tokenIn = params.zeroForOne ? params.poolKey.currency0 : params.poolKey.currency1;
        address tokenOut = params.zeroForOne ? params.poolKey.currency1 : params.poolKey.currency0;
        uint256 amountIn = uint256(params.amountIn);
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        // 1:1 conversion for demo.
        DemoBasketToken(tokenOut).mint(msg.sender, amountIn);
        return amountIn;
    }
}

/// @notice Minimal Aerodrome router stub for demo purposes. Records swaps at
///         a 1:1 rate, minting output token to the recipient. Demo-only.
///         Used by AgentTokenVault for its RM leg, where the pool TWAP
///         also returns 1:1 (DemoUsdcPool.observe returns zero ticks), so
///         totalAssets ≈ totalDeposits and no share inflation occurs.
contract DemoAerodromeRouter {
    mapping(bytes32 => address) public pools;

    function setPool(address tokenA, address tokenB, int24 tickSpacing, address pool) external {
        pools[keccak256(abi.encode(tokenA, tokenB, tickSpacing))] = pool;
        pools[keccak256(abi.encode(tokenB, tokenA, tickSpacing))] = pool;
    }

    function getPool(address tokenA, address tokenB, int24 tickSpacing)
        external
        view
        returns (address)
    {
        return pools[keccak256(abi.encode(tokenA, tokenB, tickSpacing))];
    }

    function exactInputSingle(IAerodromeSlipstreamRouter.ExactInputSingleParams calldata params)
        external
        returns (uint256)
    {
        require(
            pools[keccak256(abi.encode(params.tokenIn, params.tokenOut, params.tickSpacing))]
                != address(0),
            "pool not configured"
        );
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        DemoBasketToken(params.tokenOut).mint(params.recipient, params.amountIn);
        return params.amountIn;
    }
}

/// @notice Price-aware Aerodrome router stub for the RWA vault demo.
///         Unlike DemoAerodromeRouter (which swaps 1:1), this stub mirrors the
///         ChronicleOracleAdapter conversion formula so that `totalAssets` stays
///         in sync with `totalSupply` after every deposit. Without this, each
///         deposit into the RWA vault would leave near-zero USDC-denominated
///         assets in the vault (because the Chronicle oracle values deSPXA at
///         5000 USDC each, not 1:1), causing exponential share inflation that
///         overflows uint256 after a handful of deposits.
///
///         Conversion mirrors ChronicleOracleAdapter exactly:
///           USDC → RWA: amountOut = (amountIn * 1e12) * WAD / DEMO_PRICE
///           RWA → USDC: amountOut = amountIn * DEMO_PRICE / (WAD * 1e12)
///
///         Demo-only; never deployed on mainnet.
contract DemoRwaAerodromeRouter {
    /// @dev Must match DemoChronicleOracle.DEMO_PRICE so swaps are consistent
    ///      with the oracle NAV. 5000 USD per deSPXA in 18-decimal WAD format.
    uint256 public constant DEMO_PRICE = 5_000e18;
    uint256 private constant WAD = 1e18;

    address public immutable USDC;

    constructor(address usdc_) {
        USDC = usdc_;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256, /* amountOutMin */
        IAerodromeRouter.Route[] calldata routes,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        require(routes.length > 0, "no routes");
        IERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn);

        uint256 amountOut;
        if (routes[0].from == USDC) {
            // USDC (6 dec) → RWA (18 dec): matches ChronicleOracleAdapter USDC→RWA
            // quoteAmount = (baseAmount * 1e12) * WAD / DEMO_PRICE
            amountOut = (amountIn * 1e12) * WAD / DEMO_PRICE;
        } else {
            // RWA (18 dec) → USDC (6 dec): matches ChronicleOracleAdapter RWA→USDC
            // quoteAmount = amountIn * DEMO_PRICE / (WAD * 1e12)
            amountOut = amountIn * DEMO_PRICE / (WAD * 1e12);
        }

        DemoBasketToken(routes[0].to).mint(to, amountOut);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }

    function defaultFactory() external pure returns (address) {
        return address(0);
    }
}

/// @notice Minimal Chronicle oracle stub for the RWA vault devnet demo.
///         Always returns a fresh price (current block.timestamp) so the
///         staleness check in RwaVault._checkOracleFreshness() never reverts
///         during demo deploys. The price is set to 5000 USD/deSPXA (5000e18)
///         as a plausible S&P 500 NAV reference. Demo-only; never deployed on mainnet.
contract DemoChronicleOracle is IChronicleOracle {
    /// @notice Latest price in 18-decimal WAD format (1e18 = 1 USD).
    ///         Initialised to 5000 USD/deSPXA — a plausible S&P 500 NAV.
    uint256 public constant DEMO_PRICE = 5_000e18;

    /// @notice Latest price returned by this stub oracle.
    function latestAnswer() external pure returns (uint256) {
        return DEMO_PRICE;
    }

    /// @notice Returns `block.timestamp` so the staleness check always passes.
    ///         Demo-only; a real Chronicle feed updates asynchronously.
    function latestTimestamp() external view returns (uint256) {
        return block.timestamp;
    }
}

/// @notice One-shot batch deployer for the RWA vault devnet stubs (PRD §11.4).
///         Deploys the deSPXA stand-in token, its USDC pool stub, the demo
///         Chronicle oracle stub, and the ChronicleOracleAdapter in a single
///         CREATE. Used by `DemoRwaBatchDeployer` to satisfy the RwaVault
///         `addAsset` gate (cardinality + liquidity) on the demo devnet.
///         Demo-only; never deployed on mainnet.
contract DemoRwaStubDeployer {
    DemoBasketToken public immutable despxaToken;
    DemoUsdcPool public immutable pool;
    DemoChronicleOracle public immutable chronicle;
    DemoRwaAerodromeRouter public immutable aeroRouter;
    ChronicleOracleAdapter public immutable chronicleAdapter;

    constructor(address usdc) {
        despxaToken = new DemoBasketToken("Demo deSPXA", "deSPXA");
        pool = new DemoUsdcPool(address(despxaToken), usdc);
        chronicle = new DemoChronicleOracle();
        // Deploy the price-aware RWA router stub. Uses DemoRwaAerodromeRouter
        // instead of DemoAerodromeRouter so that USDC→deSPXA swaps apply the
        // Chronicle NAV price (5000 USD/deSPXA) rather than a 1:1 rate.
        // A 1:1 rate leaves near-zero totalAssets after each deposit (the
        // Chronicle oracle values the minted atoms at ~0 USDC), causing
        // exponential share inflation that overflows uint256 within a handful
        // of deposits. The same stub address is used as both router and factory
        // (ChronicleOracleAdapter requires factory != address(0); on devnet the
        // factory is embedded in the Route struct but never validated by the
        // stub swap implementation). Demo-only.
        aeroRouter = new DemoRwaAerodromeRouter(usdc);
        chronicleAdapter = new ChronicleOracleAdapter(
            address(aeroRouter),
            address(aeroRouter), // factory — non-zero stub; demo only
            false, // stable = false (concentrated pool on devnet)
            address(chronicle),
            address(despxaToken),
            usdc
        );
    }
}

/// @notice One-shot batch deployer for the AgentTokenVault devnet basket
///         stand-ins (PRD §11.3 — BNKR/JUNO/RM, three real-asset demo tokens)
///         AND the per-asset swap router stubs + adapters. Its constructor performs
///         all 11 sub-CREATEs in a single broadcaster transaction:
///           - 3 × DemoBasketToken (BNKR, JUNO, RM)
///           - 3 × DemoUsdcPool
///           - DemoV3SwapRouter (BNKR built-in path)
///           - DemoV4SwapRouter (JUNO V4 path)
///           - DemoAerodromeRouter (RM Aerodrome path)
///           - UniswapV4SwapAdapter (JUNO)
///           - AerodromeSwapAdapter (RM)
///         Collapsed into one broadcaster CREATE to minimize on-chain tx count
///         and keep smoke-test devnet boot inside the 30m CI budget. Demo-only.
contract AgentBasketStubDeployer {
    DemoBasketToken[3] public tokens;
    DemoUsdcPool[3] public pools;
    address public v3Router;
    address public v4Adapter;
    address public aeroAdapter;

    string[3] internal AGENT_SYMBOLS_3 = ["BNKR", "JUNO", "RM"];

    constructor(address usdc) {
        // Deploy router stubs first so adapters can reference them.
        DemoV3SwapRouter v3 = new DemoV3SwapRouter();
        DemoV4SwapRouter v4Router = new DemoV4SwapRouter();
        DemoAerodromeRouter aeroRouter = new DemoAerodromeRouter();

        v3Router = address(v3);
        v4Adapter = address(new UniswapV4SwapAdapter(address(v4Router)));
        aeroAdapter = address(new AerodromeSwapAdapter(address(aeroRouter), address(aeroRouter)));

        for (uint256 i = 0; i < 3; i++) {
            DemoBasketToken token = new DemoBasketToken(
                string.concat("Demo Agent ", AGENT_SYMBOLS_3[i]), AGENT_SYMBOLS_3[i]
            );
            tokens[i] = token;
            pools[i] = new DemoUsdcPool(address(token), usdc);
        }
        aeroRouter.setPool(address(tokens[2]), usdc, 10_000, address(pools[2]));
    }
}

/// @notice One-shot batch deployer for the ProtocolAssetVault devnet basket
///         stand-ins (PRD §11.2 — wETH, cbBTC, wSOL). Mirrors the
///         `AgentBasketStubDeployer` shape: 6 sub-CREATEs (3 stand-in tokens
///         + 3 USDC pool stubs) in a single broadcaster CREATE. Demo-only.
contract ProtocolBasketStubDeployer {
    DemoBasketToken[3] public tokens;
    DemoUsdcPool[3] public pools;

    constructor(string[3] memory symbols, address usdc) {
        for (uint256 i = 0; i < symbols.length; i++) {
            DemoBasketToken token =
                new DemoBasketToken(string.concat("Demo Protocol ", symbols[i]), symbols[i]);
            tokens[i] = token;
            pools[i] = new DemoUsdcPool(address(token), usdc);
        }
    }
}

/// @notice Batch deployer #1 — the canonical `ProtocolAssetVault` (PRD §11.2)
///         deployed inside a single broadcaster CREATE. Constructed with
///         admin = adminAddr (the script broadcaster) so subsequent
///         `addAsset` + registry calls remain on the broadcast key. Demo-only.
contract ProtocolVaultBatchDeployer {
    ProtocolAssetVault public immutable protocolVault;

    constructor(
        address usdc,
        address adminAddr,
        address emergencyResponder,
        address swapRouter,
        uint256 tvlCap,
        uint256 perDepositCap
    ) {
        protocolVault = new ProtocolAssetVault(
            IERC20(usdc),
            ISwapRouter(swapRouter),
            tvlCap,
            perDepositCap,
            0,
            adminAddr,
            adminAddr,
            emergencyResponder
        );
    }
}

/// @notice Batch deployer #2a — the real `RwaVault` (PRD §11.4, deSPXA) alone.
///         Split from `DemoAgentBatchDeployer` to keep each batch deployer's
///         initcode under EIP-3860's 49152-byte limit (geth enforces this on
///         the smoke-test devnet). `RwaVault` initcode is ~25KB; combining it
///         with `AgentTokenVault` (~24KB) would push combined initcode to ~51KB,
///         which exceeds the geth limit. Demo-only.
contract DemoRwaBatchDeployer {
    RwaVault public immutable rwaVault;

    constructor(
        address usdc,
        address adminAddr,
        address emergencyResponder,
        address swapRouter,
        address chronicle,
        uint256 tvlCap,
        uint256 perDepositCap
    ) {
        rwaVault = new RwaVault(
            IERC20(usdc),
            ISwapRouter(swapRouter),
            IChronicleOracle(chronicle),
            tvlCap,
            perDepositCap,
            0, // exitFeeBps
            adminAddr, // feeRecipient
            adminAddr,
            emergencyResponder
        );
    }
}

/// @notice Batch deployer #2b — the `AgentTokenVault` (PRD §11.3) alone.
///         Split from the former `DemoAgentRwaBatchDeployer` to keep each
///         batch deployer's initcode under EIP-3860's 49152-byte limit.
///         All vaults constructed with admin = adminAddr. Demo-only.
contract DemoAgentBatchDeployer {
    AgentTokenVault public immutable agentVault;

    constructor(
        address usdc,
        address adminAddr,
        address emergencyResponder,
        address swapRouter,
        uint256 tvlCap,
        uint256 perDepositCap
    ) {
        agentVault = new AgentTokenVault(
            IERC20(usdc),
            ISwapRouter(swapRouter),
            tvlCap,
            perDepositCap,
            0,
            adminAddr,
            adminAddr,
            emergencyResponder
        );
    }
}

/// @title DeployDemoExtraVaults
/// @notice Demo-only deploy script that aligns the devnet vault set with the
///         four-vault PRD §11 catalog: Stable Yield (deployed by Deploy.s.sol),
///         Protocol Asset, Agent Token, and the real deSPXA RWA vault (ADR-0006).
///         Registers all three additions in `VaultRegistry`, seeds the basket
///         vaults with devnet stand-in tokens, seeds the RWA vault with the
///         deSPXA stub + Chronicle oracle stub, and resets the router weight
///         vector to a four-vault 8500/500/500/500 bps split.
///
///         Why this exists: to exercise the full PRD vault catalog end to end
///         (Portfolio Explorer, /v1/vaults TVL, Router Governance weights) the
///         demo seed deploys the same vault classes the PRD names — no generic
///         stand-in clones. `ProtocolAssetVault` and `AgentTokenVault` carry
///         devnet basket stubs; `RwaVault` (PRD §11.4) holds the deSPXA stub
///         + a demo Chronicle oracle that always returns a fresh price.
///
///         Router eligibility (issues #559, #560, #621, ADR-0006 §1 as amended):
///           - rmPROTO (§11.2) is router-eligible (issue #559). DemoV3SwapRouter
///             stubs satisfy the V3 deposit path on devnet. 500 bps leg.
///           - rmAGENT (§11.3) is router-eligible (issue #560). Multi-DEX stubs
///             (V3/V4/Aerodrome) satisfy all three deposit legs on devnet. 500 bps.
///           - rmRWA (§11.4) is router-eligible at 500 bps (issue #621, ADR-0006
///             §1 amended 2026-06-05 — product owner confirmed). The Aerodrome
///             swap stub and demo Chronicle oracle satisfy the deposit path on devnet.
///           - The primary `RobotMoneyVault` (§11.1) holds 8500 bps (~85%).
///           - Default + voted weight vectors: 8500 / 500 / 500 / 500 bps
///             (primary / rmRWA / rmPROTO / rmAGENT) summing to 10 000 bps.
///
///         Required env vars:
///           ADMIN_ADDRESS               — receives ADMIN_ROLE on the new vaults
///                                         and must already hold ADMIN_ROLE on
///                                         VaultRegistry + PortfolioRouter
///           EMERGENCY_RESPONDER_ADDRESS — receives EMERGENCY_ROLE on the basket
///                                         vaults (hot key for rapid unwind);
///                                         use a distinct address from ADMIN_ADDRESS
///                                         in production for two-role key separation
///           REGISTRY_ADDRESS            — deployed VaultRegistry
///           ROUTER_ADDRESS              — deployed PortfolioRouter
///           PRIMARY_VAULT               — RobotMoneyVault deployed by Deploy.s.sol
///                                         (~3334 bps in the default weight vector)
///           USDC_ADDRESS                — ERC-20 asset every vault denominates in
///
///         Optional env vars:
///           SWAP_ROUTER        — Uniswap V3 SwapRouter02 address for the
///                                basket vaults (defaults to Base mainnet)
///           RWA_VAULT_NAME     — registry name for the RWA vault
///                                (default: "Robot Money RWA / Thematic")
///           DEPLOYMENT_OUT     — output JSON path
///                                (default: "deployments/demo-extra-vaults-<chain_id>.json")
contract DeployDemoExtraVaults is Script {
    using stdJson for string;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        /// @dev `ProtocolAssetVault` (PRD §11.2, rmPROTO). Registered Active and
        ///      router-eligible (issue #559). Included in the default + voted weight
        ///      vectors at 3 333 bps (~33% of routed deposits).
        address protocolVault;
        /// @dev Devnet stand-in ERC20 addresses seeded into ProtocolAssetVault.
        address[] protocolTokens;
        /// @dev `AgentTokenVault` (PRD §11.3). Registered Active AND router-eligible
        ///      (BNKR/V3, JUNO/V4, RM/Aerodrome). Included in defaultWeights.
        address agentTokenVault;
        /// @dev Devnet stand-in ERC20 addresses seeded into AgentTokenVault
        ///      (three real-asset demo stubs: BNKR, JUNO, RM).
        address[] agentTokens;
        /// @dev `RwaVault` (PRD §11.4, deSPXA). Registered Active AND router-eligible at
        ///      500 bps (issue #621, ADR-0006 §1 amended 2026-06-05). The Aerodrome swap
        ///      stub and demo Chronicle oracle satisfy the deposit path on devnet.
        address rwaVault;
        /// @dev UniswapV4SwapAdapter deployed for JUNO (Venue.V4).
        address v4Adapter;
        /// @dev AerodromeSwapAdapter deployed for RM (Venue.Aerodrome).
        address aeroAdapter;
    }

    /// @notice Real four-vault demo agent-token symbols: BNKR (V3), JUNO (V4),
    ///         RM (V4/Aerodrome). Three-token basket per issue #560.
    string[3] internal AGENT_SYMBOLS = ["BNKR", "JUNO", "RM"];
    /// @notice Swap fee tier for BNKR (Uniswap V3, 1% pool tier — illiquid agent token).
    uint24 internal constant DEMO_AGENT_BNKR_FEE = 10_000;
    /// @notice Swap fee tier for JUNO (Uniswap V4, 1% pool tier).
    uint24 internal constant DEMO_AGENT_JUNO_FEE = 10_000;
    /// @notice Swap fee tier for RM (Aerodrome — fee param unused by adapter
    ///         but kept for interface uniformity; 1% matches the illiquid stance).
    uint24 internal constant DEMO_AGENT_RM_FEE = 10_000;

    /// @notice ProtocolAssetVault basket symbols (PRD §11.2 — wETH, cbBTC, wSOL).
    string[3] internal PROTOCOL_SYMBOLS = ["wETH", "cbBTC", "wSOL"];
    /// @notice Swap fee tier for the protocol-asset basket stubs (mainnet wETH
    ///         pools commonly use 0.05%; matches the 1% default-slippage stance
    ///         on `ProtocolAssetVault` headroom).
    uint24 internal constant DEMO_PROTOCOL_SWAP_FEE = 500;

    /// @notice Default human-readable name for the RWA/Thematic placeholder
    ///         (PRD §11.4). Future / not-specified vault category.
    string public constant DEFAULT_RWA_NAME = "Robot Money RWA / Thematic";

    /// @notice TVL cap mirrored from Deploy.s.sol (10M USDC) — demo vaults
    ///         carry the same caps as the primary so the harness can fund any
    ///         scenario without per-vault tuning.
    uint256 public constant DEMO_TVL_CAP = 10_000_000 * 1e6;
    /// @notice Per-deposit cap mirrored from Deploy.s.sol (1M USDC).
    uint256 public constant DEMO_PER_DEPOSIT_CAP = 1_000_000 * 1e6;

    /// @dev Env-derived params bundled to keep `run()` locals below the
    ///      Solidity stack limit (16 slots, ~stack-too-deep).
    struct Params {
        address admin;
        /// @dev Receives EMERGENCY_ROLE on each basket vault. Distinct from
        ///      admin in production (two-role key separation, issue #506).
        address emergencyResponder;
        address registry;
        address router;
        address primaryVault;
        address usdc;
        // Uniswap V3 SwapRouter02 for the basket vaults. On devnet no swaps run
        // during seed (only addAsset + register), so a non-functional address
        // is acceptable; defaults to the Base mainnet SwapRouter02.
        address swapRouter;
        string rwaName;
    }

    /// @notice Base mainnet Uniswap V3 SwapRouter02 — default basket-vault swap
    ///         router when SWAP_ROUTER is unset (mirrors the basket vaults).
    address internal constant DEFAULT_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    /// @notice Forge broadcast entrypoint. Deploys ProtocolAssetVault,
    ///         AgentTokenVault, the RWA placeholder; registers all three;
    ///         seeds the two basket vaults; resets the router weight vector.
    function run() external returns (Deployed memory d) {
        Params memory p = _readParams();

        vm.startBroadcast();
        d = _doDeploy(p);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
        _logResult(d);
    }

    /// @notice In-process entrypoint for forge tests. Runs the same deploy +
    ///         seed body as `run()` but without `vm.startBroadcast`, so the
    ///         caller (the test contract) is the broadcaster and must already
    ///         hold ADMIN_ROLE on the registry and router. No deployment JSON
    ///         is written.
    /// @param p Fully-formed params (no env reads).
    function runInProcess(Params memory p) external returns (Deployed memory d) {
        d = _doDeploy(p);
    }

    function _readParams() internal view returns (Params memory p) {
        p.admin = vm.envAddress("ADMIN_ADDRESS");
        p.emergencyResponder = vm.envAddress("EMERGENCY_RESPONDER_ADDRESS");
        p.registry = vm.envAddress("REGISTRY_ADDRESS");
        p.router = vm.envAddress("ROUTER_ADDRESS");
        p.primaryVault = vm.envAddress("PRIMARY_VAULT");
        p.usdc = vm.envAddress("USDC_ADDRESS");
        p.swapRouter = _envAddressOrDefault("SWAP_ROUTER", DEFAULT_SWAP_ROUTER);
        p.rwaName = _envStringOrDefault("RWA_VAULT_NAME", DEFAULT_RWA_NAME);

        require(p.admin != address(0), "ADMIN_ADDRESS=0");
        require(p.emergencyResponder != address(0), "EMERGENCY_RESPONDER_ADDRESS=0");
        require(p.registry != address(0), "REGISTRY_ADDRESS=0");
        require(p.router != address(0), "ROUTER_ADDRESS=0");
        require(p.primaryVault != address(0), "PRIMARY_VAULT=0");
        require(p.usdc != address(0), "USDC_ADDRESS=0");
    }

    /// @dev Intermediate struct for vault + stub addresses, used to pass
    ///      results from `_deployVaults` to `_wireAndRegister` without
    ///      exceeding the 16-slot Solidity stack limit.
    struct _VaultAddrs {
        address protocolVault;
        address rwaVault;
        address agentVault;
        address v4Adapter;
        address aeroAdapter;
        address agentStubs; // AgentBasketStubDeployer
        address protocolStubs; // ProtocolBasketStubDeployer
        address rwaStubs; // DemoRwaStubDeployer
    }

    /// @dev Caller must hold ADMIN_ROLE on registry + router via broadcast
    ///      key. Splits the body of `run()` so the locals stay below the
    ///      stack-too-deep limit.
    function _doDeploy(Params memory p) internal returns (Deployed memory d) {
        _VaultAddrs memory v = _deployVaults(p);
        d = _wireAndRegister(p, v);
        // Finding L3-D1: the four basket-family vaults DELEGATECALL a
        // deploy-time-linked TickMath library on the NAV / totalAssets() path.
        // Fail the deploy if any vault links a mislinked/zero/non-canonical
        // library, or if any vault's totalAssets() reverts or is out of range.
        _assertTickMathLinkIntegrity(d.protocolVault, d.rwaVault, d.agentTokenVault);
    }

    /// @notice Audited runtime codehash of the canonical `TickMath` library.
    ///         Computed from the vendored `contracts/lib/TickMath.sol` artifact
    ///         (Uniswap v3-core `getSqrtRatioAtTick`, solc 0.8.24, 200 runs,
    ///         Cancun) and pinned here so the deploy assertion detects any drift
    ///         from the reviewed code. Regenerate via
    ///         `forge test --match-test test_tickMathLink_auditedCodehash_matches`
    ///         if the library or compiler settings legitimately change.
    bytes32 internal constant TICKMATH_AUDITED_CODEHASH =
        0x1201c85bdae3b953cb38d7ae72ab099c55bc602a8c68b46cd649e8e38fdb875e;

    /// @dev Assert the TickMath library link integrity for all four basket-family
    ///      vaults (finding L3-D1). Each vault exposes the linked library address
    ///      via `tickMathLibrary()`; the primary `RobotMoneyVault` does not use
    ///      TickMath and is excluded. Checks, per vault:
    ///        1. linked address is non-zero and has non-empty runtime code;
    ///        2. linked runtime codehash equals the audited artifact;
    ///        3. all vaults link the identical library address (single instance);
    ///        4. `totalAssets()` does not revert and is within a sane USDC range.
    ///      A deliberately wrong/zero linked address fails check 1/2; a tampered
    ///      library fails check 2.
    function _assertTickMathLinkIntegrity(
        address protocolVault,
        address rwaVault,
        address agentVault
    ) internal view {
        address[3] memory vaults = [protocolVault, rwaVault, agentVault];
        address expectedLib = BasketVault(vaults[0]).tickMathLibrary();

        for (uint256 i = 0; i < vaults.length; i++) {
            address lib = BasketVault(vaults[i]).tickMathLibrary();
            require(lib != address(0), "TickMath: zero linked library");
            require(lib.code.length > 0, "TickMath: linked library has no code");
            require(lib == expectedLib, "TickMath: vaults link different libraries");
            require(lib.codehash == TICKMATH_AUDITED_CODEHASH, "TickMath: codehash mismatch");

            // Per-vault totalAssets() sanity probe: non-reverting, in range.
            uint256 nav = BasketVault(vaults[i]).totalAssets();
            // Cap mirrors the demo TVL ceiling with generous headroom — a wildly
            // out-of-range NAV implies a broken price path (e.g. a mislinked
            // library returning garbage sqrt ratios).
            require(nav <= DEMO_TVL_CAP * 1000, "TickMath: totalAssets out of range");
        }
    }

    /// @dev Phase 1: deploy all vaults, stubs, and adapters.
    ///      Returns addresses bundled in `_VaultAddrs` to keep the caller
    ///      stack under 16 slots.
    ///
    ///      Router stubs + swap adapters (V3/V4/Aerodrome) are collapsed into
    ///      a single `AgentBasketStubDeployer` CREATE to minimise on-chain tx
    ///      count and keep smoke-test devnet boot under the 30m CI budget.
    function _deployVaults(Params memory p) internal returns (_VaultAddrs memory v) {
        // Collapse all agent basket stubs + router stubs + adapters into one
        // broadcaster CREATE. The batch deployer sets its own v3Router, then
        // uses it as the swapRouter for the downstream vault contracts.
        AgentBasketStubDeployer agentBatch = new AgentBasketStubDeployer(p.usdc);

        // Deploy the RWA stubs: deSPXA token stub, pool stub, demo Chronicle oracle,
        // dedicated DemoAerodromeRouter, and ChronicleOracleAdapter — all collapsed
        // into one CREATE. The stub router address is used as the Aerodrome factory
        // parameter (non-zero required by ChronicleOracleAdapter; demo-only). Demo-only.
        DemoRwaStubDeployer rwaStubs = new DemoRwaStubDeployer(p.usdc);

        ProtocolVaultBatchDeployer batchA = new ProtocolVaultBatchDeployer(
            p.usdc,
            p.admin,
            p.emergencyResponder,
            agentBatch.v3Router(),
            DEMO_TVL_CAP,
            DEMO_PER_DEPOSIT_CAP
        );
        // Deploy RwaVault and AgentTokenVault in separate batch deployers:
        // combined initcode of RwaVault (~25KB) + AgentTokenVault (~24KB) would
        // exceed the EIP-3860 49152-byte limit on geth (smoke-test devnet).
        // Splitting into two single-vault deployers keeps each under the limit.
        DemoRwaBatchDeployer batchB = new DemoRwaBatchDeployer(
            p.usdc,
            p.admin,
            p.emergencyResponder,
            agentBatch.v3Router(),
            address(rwaStubs.chronicle()),
            DEMO_TVL_CAP,
            DEMO_PER_DEPOSIT_CAP
        );
        DemoAgentBatchDeployer batchC = new DemoAgentBatchDeployer(
            p.usdc,
            p.admin,
            p.emergencyResponder,
            agentBatch.v3Router(),
            DEMO_TVL_CAP,
            DEMO_PER_DEPOSIT_CAP
        );

        v.protocolVault = address(batchA.protocolVault());
        v.rwaVault = address(batchB.rwaVault());
        v.agentVault = address(batchC.agentVault());

        v.protocolStubs = address(new ProtocolBasketStubDeployer(PROTOCOL_SYMBOLS, p.usdc));
        v.agentStubs = address(agentBatch);
        v.rwaStubs = address(rwaStubs);
        v.v4Adapter = agentBatch.v4Adapter();
        v.aeroAdapter = agentBatch.aeroAdapter();
    }

    /// @dev Phase 2: seed baskets, register vaults, set router eligibility
    ///      and weights. Separated from `_deployVaults` to avoid stack-too-deep.
    function _wireAndRegister(Params memory p, _VaultAddrs memory v)
        internal
        returns (Deployed memory d)
    {
        d.protocolVault = v.protocolVault;
        d.rwaVault = v.rwaVault;
        d.agentTokenVault = v.agentVault;
        d.v4Adapter = v.v4Adapter;
        d.aeroAdapter = v.aeroAdapter;

        VaultRegistry registry = VaultRegistry(p.registry);

        // 1. Seed ProtocolAssetVault (PRD §11.2) basket with wETH/cbBTC/wSOL
        //    stand-ins and register it Active. Made router-eligible (issue #559):
        //    the demo deploys DemoV3SwapRouter stubs so a router-weighted deposit
        //    succeeds end-to-end on devnet. setRouterEligible is called before
        //    setRouter so the VaultRegistry stale-length guard is inactive (it
        //    only fires when the router is already linked with a non-empty vector).
        d.protocolTokens = _seedProtocolAssetVault(
            ProtocolAssetVault(v.protocolVault), ProtocolBasketStubDeployer(v.protocolStubs)
        );
        _registerIfAbsent(registry, v.protocolVault, p.usdc, "Robot Money Protocol");
        // Set rmPROTO router-eligible (issue #559) before setRouter is called.
        registry.setRouterEligible(d.protocolVault, true);

        // 2. Seed AgentTokenVault (PRD §11.3) with the real four-vault demo
        //    three-token basket: BNKR (Venue.V3), JUNO (Venue.V4 via v4Adapter),
        //    RM (Venue.Aerodrome via aeroAdapter). Register it Active
        //    and make it router-eligible — the demo deploy wires working multi-DEX
        //    swap adapters so a routed deposit succeeds end-to-end on devnet.
        d.agentTokens = _seedAgentTokenVault(
            AgentTokenVault(v.agentVault),
            AgentBasketStubDeployer(v.agentStubs),
            v.v4Adapter,
            v.aeroAdapter
        );
        _registerIfAbsent(registry, v.agentVault, p.usdc, "Robot Money Agent Tokens");
        // Set rmAGENT router-eligible (issue #560): the demo adapters satisfy the
        // deposit path so a router-weighted deposit to agentTokenVault succeeds.
        registry.setRouterEligible(v.agentVault, true);

        // 3. Seed the RWA vault (PRD §11.4) with the deSPXA stand-in asset and
        //    register it Active. Router-eligible at 500 bps per issue #621
        //    (ADR-0006 §1 amended 2026-06-05 — product owner confirmed). The
        //    Aerodrome swap stub and demo Chronicle oracle satisfy the deposit
        //    path on devnet. Set router-eligible before setRouter is called so
        //    the VaultRegistry stale-length guard is inactive.
        _seedRwaVault(RwaVault(v.rwaVault), DemoRwaStubDeployer(v.rwaStubs));
        _registerIfAbsent(registry, v.rwaVault, p.usdc, p.rwaName);
        // Set rmRWA router-eligible (issue #621, ADR-0006 §1 amended).
        registry.setRouterEligible(v.rwaVault, true);

        // 4. Refresh the router default (below-quorum fallback, ADR-0002) and
        //    voted weight vectors. All four vaults are now router-eligible:
        //    PRIMARY_VAULT (§11.1), rwaVault (§11.4, issue #621), protocolVault
        //    (§11.2, issue #559), and agentTokenVault (§11.3, issue #560).
        //    Conservative stablecoin-heavy split: 8500 bps primary + 500 bps each
        //    for the three remaining vaults (summing to 10 000 bps).
        //    All setRouterEligible calls above happened before setRouter, so the
        //    stale-length guard was inactive. Link the router first (idempotent),
        //    then set the four-vault weight vector.
        if (address(registry.router()) != p.router) {
            registry.setRouter(p.router);
        }
        _applyFourVaultWeights(
            PortfolioRouter(p.router), p.primaryVault, v.rwaVault, d.protocolVault, v.agentVault
        );
    }

    /// @dev Wire the three PRD §11.2 basket symbols into the pre-built
    ///      `ProtocolAssetVault` via `addAsset`. Tokens + USDC pool stubs were
    ///      already created inside `ProtocolBasketStubDeployer`. The vault's
    ///      ADMIN_ROLE is held by p.admin, so addAsset succeeds on the
    ///      script broadcast key.
    function _seedProtocolAssetVault(ProtocolAssetVault vault, ProtocolBasketStubDeployer seeder)
        internal
        returns (address[] memory tokens)
    {
        tokens = new address[](PROTOCOL_SYMBOLS.length);
        for (uint256 i = 0; i < PROTOCOL_SYMBOLS.length; i++) {
            address token_ = address(seeder.tokens(i));
            address pool_ = address(seeder.pools(i));
            vault.addAsset(token_, pool_, DEMO_PROTOCOL_SWAP_FEE, address(0), BasketVault.Venue.V3);
            tokens[i] = token_;
        }
    }

    /// @dev Wire the three real-asset demo tokens into the pre-built
    ///      `AgentTokenVault` via `addAsset` with per-asset venue selection:
    ///        index 0: BNKR  — Venue.V3  (built-in SWAP_ROUTER, adapter = address(0))
    ///        index 1: JUNO  — Venue.V4  (UniswapV4SwapAdapter)
    ///        index 2: RM — Venue.Aerodrome (AerodromeSwapAdapter)
    ///
    ///      Tokens + USDC pool stubs were already created inside
    ///      `AgentBasketStubDeployer`. Demo pools satisfy the cardinality and
    ///      liquidity gates in BasketVault.addAsset via stub returns.
    function _seedAgentTokenVault(
        AgentTokenVault vault,
        AgentBasketStubDeployer seeder,
        address v4AdapterAddr,
        address aeroAdapterAddr
    ) internal returns (address[] memory tokens) {
        tokens = new address[](3);

        // BNKR — Venue.V3, no per-asset adapter (uses built-in SWAP_ROUTER).
        tokens[0] = address(seeder.tokens(0));
        vault.addAsset(
            tokens[0],
            address(seeder.pools(0)),
            DEMO_AGENT_BNKR_FEE,
            address(0),
            BasketVault.Venue.V3
        );

        // JUNO — Venue.V4 via UniswapV4SwapAdapter.
        tokens[1] = address(seeder.tokens(1));
        vault.addAsset(
            tokens[1],
            address(seeder.pools(1)),
            DEMO_AGENT_JUNO_FEE,
            v4AdapterAddr,
            BasketVault.Venue.V4
        );

        // RM — Venue.Aerodrome via AerodromeSwapAdapter.
        tokens[2] = address(seeder.tokens(2));
        vault.addAsset(
            tokens[2],
            address(seeder.pools(2)),
            DEMO_AGENT_RM_FEE,
            aeroAdapterAddr,
            BasketVault.Venue.Aerodrome
        );
    }

    /// @dev Wire the deSPXA stand-in asset into the pre-built `RwaVault` via
    ///      `addAsset`. The ChronicleOracleAdapter (already deployed inside
    ///      `DemoRwaStubDeployer`) is passed as the per-asset adapter with
    ///      Venue.Aerodrome so BasketVault routes swaps through it. The fee
    ///      param is 0 — Aerodrome derives fee from the pool config, not the
    ///      adapter. The pool stub satisfies cardinality + liquidity gates.
    ///      Per ADR-0006 §1, the vault is seeded once (maxAssets = 1).
    function _seedRwaVault(RwaVault vault, DemoRwaStubDeployer seeder) internal {
        vault.addAsset(
            address(seeder.despxaToken()),
            address(seeder.pool()),
            0, // fee — Aerodrome ignores this; Chronicle provides NAV pricing
            address(seeder.chronicleAdapter()),
            BasketVault.Venue.Aerodrome
        );
    }

    /// @dev Refresh both the voted weight vector (used by the AC3 smoke test
    ///      which reads `getWeights()`) and the on-chain default (below-quorum
    ///      fallback, ADR-0002). All four router-eligible vaults: primary (§11.1),
    ///      rmRWA (§11.4, issue #621), rmPROTO (§11.2, issue #559), and rmAGENT
    ///      (§11.3, issue #560). Conservative stablecoin-heavy split:
    ///      8500 / 500 / 500 / 500 bps = 10 000 total.
    function _applyFourVaultWeights(
        PortfolioRouter router,
        address primary,
        address rwaVault,
        address proto,
        address agentVault
    ) internal {
        address[] memory vaults = new address[](4);
        vaults[0] = primary;
        vaults[1] = rwaVault;
        vaults[2] = proto;
        vaults[3] = agentVault;
        uint256[] memory bps = new uint256[](4);
        bps[0] = 8_500;
        bps[1] = 500;
        bps[2] = 500;
        bps[3] = 500;
        router.setWeights(vaults, bps);
        router.setDefaultWeights(vaults, bps);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    /// @dev Register `vault` in `registry` if not already present. Returns
    ///      true if registration happened, false if already there.
    function _registerIfAbsent(
        VaultRegistry registry,
        address vault,
        address asset,
        string memory vaultName
    ) internal returns (bool registered) {
        address[] memory existing = registry.listVaults();
        for (uint256 i = 0; i < existing.length; i++) {
            if (existing[i] == vault) {
                console2.log("DeployDemoExtraVaults: vault already registered, skipping");
                return false;
            }
        }
        registry.registerVault(
            vault, VaultRegistry.VaultMetadata({name: vaultName, asset: asset, registeredAt: 0})
        );
        return true;
    }

    function _envStringOrDefault(string memory key, string memory fallback_)
        internal
        view
        returns (string memory)
    {
        try vm.envString(key) returns (string memory v) {
            if (bytes(v).length > 0) return v;
            return fallback_;
        } catch {
            return fallback_;
        }
    }

    function _envAddressOrDefault(string memory key, address fallback_)
        internal
        view
        returns (address)
    {
        try vm.envAddress(key) returns (address v) {
            if (v != address(0)) return v;
            return fallback_;
        } catch {
            return fallback_;
        }
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log("DeployDemoExtraVaults complete");
        console2.log("  protocolVault :", d.protocolVault, "(router-eligible, wETH/cbBTC/wSOL)");
        console2.log("  protocolTokens:", d.protocolTokens.length);
        console2.log("  agentVault    :", d.agentTokenVault, "(router-eligible, BNKR/JUNO/RM)");
        console2.log("  agentTokens   :", d.agentTokens.length, "(V3/V4/Aerodrome)");
        console2.log("  v4Adapter     :", d.v4Adapter);
        console2.log("  aeroAdapter   :", d.aeroAdapter);
        console2.log(
            "  rwaVault      :", d.rwaVault, "(Active, router-eligible 500 bps, deSPXA/Chronicle)"
        );
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath = string.concat(
                "deployments/demo-extra-vaults-", vm.toString(block.chainid), ".json"
            );
        }

        string memory obj = "demo_extra_vaults_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "protocol_vault", d.protocolVault);
        vm.serializeAddress(obj, "protocol_tokens", d.protocolTokens);
        vm.serializeAddress(obj, "agent_token_vault", d.agentTokenVault);
        vm.serializeAddress(obj, "agent_tokens", d.agentTokens);
        vm.serializeAddress(obj, "v4_adapter", d.v4Adapter);
        vm.serializeAddress(obj, "aero_adapter", d.aeroAdapter);
        string memory json = vm.serializeAddress(obj, "rwa_vault", d.rwaVault);

        vm.writeJson(json, outPath);
        console2.log("Wrote demo extra vaults deployment JSON to", outPath);
    }
}
