// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0001-mvp-agent-token-shortlist.md;
//            docs/prd.md §11.3 — Agent Token Vault
// Covers issue #481 — seed AgentTokenVault with the canonical MVP six-token
//                      shortlist (equal-weight, admin-curated, Base-only).
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {DeployDemoExtraVaults} from "../script/DeployDemoExtraVaults.s.sol";

/// @dev Uniswap V3 pool mock: token0/token1 reads for addAsset validation plus
///      a flat 1:1 TWAP via observe() (arithmetic-mean tick = 0). One unit of
///      basket token is worth one unit of USDC, which makes equal-weight
///      assertions exact and independent of slot0.
contract MockPool {
    address public immutable token0;
    address public immutable token1;
    uint16 public cardinality = 100;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1 << 96), 0, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        // tickCumulativeRate = 0 -> arithmetic-mean tick = 0 -> price 1:1.
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (uint32(block.timestamp), 0, 0, true);
    }
}

/// @dev Swap router mock that records the USDC `amountIn` of every USDC->token
///      deposit swap, keyed by output token, so equal-weight allocation can be
///      asserted directly. Returns `amountIn` 1:1 to the recipient.
contract RecordingSwapRouter is ISwapRouter {
    using SafeERC20 for IERC20;

    mapping(address => uint256) public usdcInForToken;

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256) {
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        usdcInForToken[params.tokenOut] += params.amountIn;
        // 1:1 conversion; mint-free because the pool TWAP is 1:1 and the test
        // pre-funds this router with the output tokens.
        TestERC20(params.tokenOut).mint(params.recipient, params.amountIn);
        return params.amountIn;
    }
}

contract AgentTokenVaultTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant N = 6;

    string[6] internal SYMBOLS = ["JUNO", "ROBOTMONEY", "BANKR", "ZYFAI", "GIZA", "DEUS"];

    TestERC20 internal usdc;
    RecordingSwapRouter internal router;
    AgentTokenVault internal vault;
    TestERC20[6] internal tokens;

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new TestERC20();
        router = new RecordingSwapRouter();
        vault = new AgentTokenVault(
            IERC20(address(usdc)),
            ISwapRouter(address(router)),
            10_000_000 * ONE_USDC,
            1_000_000 * ONE_USDC,
            0,
            admin,
            admin
        );
        _seedSixTokenShortlist();
    }

    /// @dev Seed the vault with the six MVP tokens, in canonical order, each
    ///      paired with USDC via a 1:1 mock pool — mirrors the deploy seed.
    function _seedSixTokenShortlist() internal {
        for (uint256 i = 0; i < N; i++) {
            tokens[i] = new TestERC20();
            MockPool pool = new MockPool(address(tokens[i]), address(usdc));
            vm.prank(admin);
            vault.addAsset(address(tokens[i]), address(pool), 10_000);
        }
    }

    function test_shortlist_seeded_with_six_mvp_tokens() public view {
        (address[] memory t,,,,) = vault.shortlist();
        assertEq(t.length, N, "shortlist holds exactly six MVP tokens");
        for (uint256 i = 0; i < N; i++) {
            assertEq(t[i], address(tokens[i]), "shortlist entry present");
        }
    }

    function test_shortlist_ordering_matches_config() public view {
        // Ordering is load-bearing: the dapp renders shortlist() in array order,
        // which must equal the ADR-0001 / config order (JUNO, ROBOTMONEY, ...).
        (address[] memory t,,,,) = vault.shortlist();
        for (uint256 i = 0; i < N; i++) {
            assertEq(t[i], address(tokens[i]), "shortlist ordering matches seed/config order");
        }
    }

    function test_equal_weight_allocation_across_six_tokens() public {
        // 600 USDC across six assets => each leg swaps exactly 100 USDC.
        uint256 deposit = 600 * ONE_USDC;
        usdc.mint(address(this), deposit);
        usdc.approve(address(vault), deposit);
        vault.deposit(deposit, address(this));

        uint256 expectedPerLeg = deposit / N;
        for (uint256 i = 0; i < N; i++) {
            assertEq(
                router.usdcInForToken(address(tokens[i])),
                expectedPerLeg,
                "each shortlist token receives an equal USDC slice at deposit"
            );
        }
    }

    function test_shortlist_mutation_admin_only() public {
        // ADMIN_ROLE may swap a shortlist entry: remove then add.
        TestERC20 replacement = new TestERC20();
        MockPool pool = new MockPool(address(replacement), address(usdc));

        vm.prank(admin);
        vault.removeAsset(0); // deactivate JUNO slot (vault holds zero)

        vm.prank(admin);
        vault.addAsset(address(replacement), address(pool), 10_000);

        (address[] memory t,,, bool[] memory active,) = vault.shortlist();
        assertEq(t.length, N + 1, "swap adds a new entry");
        assertFalse(active[0], "removed entry deactivated");
        assertTrue(active[N], "replacement entry active");
        assertEq(t[N], address(replacement), "replacement appended");
    }

    function test_shortlist_mutation_rejected_for_non_admin() public {
        TestERC20 newToken = new TestERC20();
        MockPool pool = new MockPool(address(newToken), address(usdc));

        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", stranger, adminRole
            )
        );
        vm.prank(stranger);
        vault.addAsset(address(newToken), address(pool), 10_000);

        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", stranger, adminRole
            )
        );
        vm.prank(stranger);
        vault.removeAsset(0);
    }

    // ─── Demo-seed integration (issue #481 test plan) ──────────────────────

    /// @notice Exercises the real demo seed chain: DeployDemoExtraVaults.run()
    ///         deploys + seeds AgentTokenVault with the six MVP tokens and
    ///         registers it in VaultRegistry. Asserts the vault is reachable via
    ///         the same registry path the dapp uses and that shortlist() returns
    ///         the six-token list. AgentTokenVault must NOT be router-eligible.
    function test_demo_seed_registers_agent_token_vault_with_shortlist() public {
        // The script body runs under vm.startBroadcast(), which executes as the
        // foundry default sender. Registry/router/primary admin must be that
        // address so the broadcast holds ADMIN_ROLE on every governed surface.
        address deployer = DEFAULT_SENDER;
        TestERC20 seedUsdc = new TestERC20();

        vm.startPrank(deployer);
        VaultRegistry registry = new VaultRegistry(deployer);
        PortfolioRouter portfolioRouter =
            new PortfolioRouter(address(seedUsdc), address(registry), deployer);

        // Primary vault must be registered + router-eligible for setWeights.
        RobotMoneyVault primary = new RobotMoneyVault(
            IERC20(address(seedUsdc)),
            10_000_000 * ONE_USDC,
            1_000_000 * ONE_USDC,
            0,
            deployer,
            deployer
        );
        registry.registerVault(
            address(primary),
            VaultRegistry.VaultMetadata({
                name: "Primary", asset: address(seedUsdc), registeredAt: 0
            })
        );
        registry.setRouterEligible(address(primary), true);
        vm.stopPrank();

        vm.setEnv("ADMIN_ADDRESS", vm.toString(deployer));
        vm.setEnv("REGISTRY_ADDRESS", vm.toString(address(registry)));
        vm.setEnv("ROUTER_ADDRESS", vm.toString(address(portfolioRouter)));
        vm.setEnv("PRIMARY_VAULT", vm.toString(address(primary)));
        vm.setEnv("USDC_ADDRESS", vm.toString(address(seedUsdc)));
        vm.setEnv("DEPLOYMENT_OUT", "/tmp/agent-token-demo-seed-test.json");

        DeployDemoExtraVaults script = new DeployDemoExtraVaults();
        DeployDemoExtraVaults.Deployed memory d = script.run();

        // 1. AgentTokenVault deployed and seeded with six tokens.
        assertTrue(d.agentTokenVault != address(0), "agent token vault deployed");
        assertEq(d.agentTokens.length, N, "six MVP shortlist tokens seeded");

        AgentTokenVault agentVault = AgentTokenVault(d.agentTokenVault);
        (address[] memory t,,,,) = agentVault.shortlist();
        assertEq(t.length, N, "shortlist() returns six tokens after demo seed");

        // 2. Reachable via the registry path the dapp uses. getVault reverts if
        //    the vault is not registered, so a successful read proves presence.
        (VaultRegistry.VaultMetadata memory meta,) = registry.getVault(d.agentTokenVault);
        assertEq(meta.name, "Robot Money Agent Tokens", "registered under canonical name");
        assertEq(meta.asset, address(seedUsdc), "registered against USDC");

        // 3. NOT router-eligible per PRD §11.3: BasketVault.deposit needs a
        //    real Uniswap V3 SwapRouter and the devnet has none, so a router-
        //    weighted deposit here would revert. The basket-vault gap (TWAP,
        //    previewRedeem) is the production blocker; nothing in this demo
        //    seed resolves it.
        assertFalse(
            registry.isRouterEligible(d.agentTokenVault),
            "agent token vault must remain router-ineligible"
        );
    }
}
