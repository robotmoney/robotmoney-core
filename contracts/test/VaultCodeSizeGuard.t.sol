// SPDX-License-Identifier: MIT
// Canonical: Plan tracking issue #109 §11 — four-vault catalog.
// Implements: issue #865
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @title VaultCodeSizeGuard
/// @notice Asserts every deployable vault's runtime bytecode stays under the
///         EIP-170 24576-byte limit.
///
///         Why this exists: Foundry's test/script EVM raises the contract-size
///         limit, so an oversize vault passes every unit/invariant/fork test and
///         even the deploy *simulation*, yet reverts when actually broadcast to a
///         real EIP-170 chain (Base mainnet, or the Geth smoke-test devnet). That
///         is exactly how the retired RwaBasketVault predecessor (24834) and AgentTokenVault (25241) became
///         undeployable without any test catching it (issue #865). This guard
///         reads the compiled artifact size directly so the limit is enforced
///         regardless of the test EVM's relaxed limit.
contract VaultCodeSizeGuard is Test {
    /// @dev EIP-170 maximum contract runtime bytecode size, in bytes.
    uint256 internal constant EIP170_LIMIT = 24576;

    /// @dev ADR-0014 §9: runtime margin every proxied implementation keeps when P1 lands.
    uint256 internal constant UPGRADE_HEADROOM_FLOOR = 1_024;

    function _assertUnderLimit(string memory artifact) internal {
        uint256 size = vm.getDeployedCode(artifact).length;
        emit log_named_uint(string.concat(artifact, " runtime bytes"), size);
        assertLe(
            size,
            EIP170_LIMIT,
            string.concat(
                artifact, " exceeds the EIP-170 24576-byte limit; it cannot be deployed on-chain"
            )
        );
    }

    function test_RobotMoneyVault_underEip170() public {
        _assertUnderLimit("RobotMoneyVault.sol:RobotMoneyVault");
    }

    function test_ProtocolAssetVault_underEip170() public {
        _assertUnderLimit("ProtocolAssetVault.sol:ProtocolAssetVault");
    }

    function test_RwaBasketVault_underEip170() public {
        _assertUnderLimit("RwaBasketVault.sol:RwaBasketVault");
    }

    function test_AgentTokenVault_underEip170() public {
        _assertUnderLimit("AgentTokenVault.sol:AgentTokenVault");
    }

    /// @notice Aggregate check matching issue #1284's test-plan command
    ///         (`forge test --match-test test_bytecodeSize`) — the vault-family
    ///         members already individually guarded above, asserted together
    ///         after the last-admin-floor consolidation and BasketVault
    ///         retirement-flag addition.
    function test_bytecodeSize_vaultFamilyUnderEip170() public {
        _assertUnderLimit("RobotMoneyVault.sol:RobotMoneyVault");
        _assertUnderLimit("RwaBasketVault.sol:RwaBasketVault");
        _assertUnderLimit("AgentTokenVault.sol:AgentTokenVault");
        _assertUnderLimit("ProtocolAssetVault.sol:ProtocolAssetVault");
    }

    // ─── Adapter set ───────────────────────────────────────────────────────
    //
    // Every adapter below is a direct on-chain deployment (lending adapters and
    // the swap venue seams), so each must independently fit EIP-170 or it is
    // undeployable on Base mainnet (issue #865). It runs in the required
    // `forge-unit-tests` job (suite-01-02-forge-tests.yml) with a non-zero
    // executed count.

    function test_AaveV3Adapter_underEip170() public {
        _assertUnderLimit("AaveV3Adapter.sol:AaveV3Adapter");
    }

    function test_CompoundV3Adapter_underEip170() public {
        _assertUnderLimit("CompoundV3Adapter.sol:CompoundV3Adapter");
    }

    function test_MorphoAdapter_underEip170() public {
        _assertUnderLimit("MorphoAdapter.sol:MorphoAdapter");
    }

    function test_UniswapV3SwapAdapter_underEip170() public {
        _assertUnderLimit("UniswapV3SwapAdapter.sol:UniswapV3SwapAdapter");
    }

    function test_AerodromeSwapAdapter_underEip170() public {
        _assertUnderLimit("AerodromeSwapAdapter.sol:AerodromeSwapAdapter");
    }

    // Core 1676: the Uniswap V4 swap adapter and the permissionless price recorder are direct on-chain deployments.

    function test_UniswapV4SwapAdapter_underEip170() public {
        _assertUnderLimit("UniswapV4SwapAdapter.sol:UniswapV4SwapAdapter");
    }

    function test_UniswapV4PriceRecorder_underEip170() public {
        _assertUnderLimit("UniswapV4PriceRecorder.sol:UniswapV4PriceRecorder");
    }

    // ─── ADR-0014: proxied implementations, their libraries, the factory ──
    //
    // Every proxied implementation is a direct on-chain deployment (behind its ERC1967Proxy), and so
    // is each CREATE2-linked library and the ExclusionLedgerFactory, so each must fit EIP-170 on its
    // own. The ledger itself is created by the factory, one per rmUSDC proxy.

    function test_RobotMoneyGateway_underEip170() public {
        _assertUnderLimit("RobotMoneyGateway.sol:RobotMoneyGateway");
    }

    function test_PortfolioRouter_underEip170() public {
        _assertUnderLimit("PortfolioRouter.sol:PortfolioRouter");
    }

    function test_VaultRegistry_underEip170() public {
        _assertUnderLimit("VaultRegistry.sol:VaultRegistry");
    }

    function test_InvestmentCommitteePolicy_underEip170() public {
        _assertUnderLimit("InvestmentCommitteePolicy.sol:InvestmentCommitteePolicy");
    }

    function test_ConsensusRecommendationReceipt_underEip170() public {
        _assertUnderLimit("ConsensusRecommendationReceipt.sol:ConsensusRecommendationReceipt");
    }

    function test_ExclusionLedgerAndFactory_underEip170() public {
        _assertUnderLimit("ExclusionLedger.sol:ExclusionLedger");
        _assertUnderLimit("ExclusionLedgerFactory.sol:ExclusionLedgerFactory");
    }

    function test_linkedLibraries_underEip170() public {
        _assertUnderLimit("VaultAdapterOps.sol:VaultAdapterOps");
        _assertUnderLimit("BasketSwapOps.sol:BasketSwapOps");
        _assertUnderLimit("BasketAssetConfigGuard.sol:BasketAssetConfigGuard");
        _assertUnderLimit("BasketViews.sol:BasketViews");
        _assertUnderLimit("GatewayWindows.sol:GatewayWindows");
        _assertUnderLimit("GatewayAuth.sol:GatewayAuth");
        _assertUnderLimit("GatewayWithdrawOps.sol:GatewayWithdrawOps");
    }

    /// @notice ADR-0014 §9: when P1 lands, every proxied implementation keeps at least 1,024 bytes of
    ///         runtime margin under 24,576, about one D-sized fix. Measured with `forge build --sizes`
    ///         (solc 0.8.24, 100 runs, cancun) after the upgrade base and the size libraries landed:
    ///         RobotMoneyVault 22,978 B (1,598 B margin), AgentTokenVault 23,280 B (1,296),
    ///         ProtocolAssetVault 23,209 B (1,367), RwaBasketVault 23,202 B (1,374),
    ///         RobotMoneyGateway 23,305 B (1,271 after P3's `implementationVersion` added 50 B),
    ///         PortfolioRouter 19,116 B, VaultRegistry 10,123 B,
    ///         InvestmentCommitteePolicy 9,886 B, ConsensusRecommendationReceipt 8,798 B. The P1
    ///         follow-up (write-once `__GovernedUpgrade_init`) added about 42 B to each: the gateway now
    ///         has 1,229 B and AgentTokenVault 1,254 B of margin, the tightest two. A change that
    ///         eats into the floor fails here; move code into a linked library or amend the ADR.
    function test_proxiedImplementations_keepUpgradeHeadroom() public {
        string[9] memory proxied = [
            "RobotMoneyVault.sol:RobotMoneyVault",
            "ProtocolAssetVault.sol:ProtocolAssetVault",
            "AgentTokenVault.sol:AgentTokenVault",
            "RwaBasketVault.sol:RwaBasketVault",
            "PortfolioRouter.sol:PortfolioRouter",
            "VaultRegistry.sol:VaultRegistry",
            "RobotMoneyGateway.sol:RobotMoneyGateway",
            "InvestmentCommitteePolicy.sol:InvestmentCommitteePolicy",
            "ConsensusRecommendationReceipt.sol:ConsensusRecommendationReceipt"
        ];
        for (uint256 i = 0; i < proxied.length; i++) {
            uint256 size = vm.getDeployedCode(proxied[i]).length;
            emit log_named_uint(string.concat(proxied[i], " margin"), EIP170_LIMIT - size);
            assertGe(
                EIP170_LIMIT - size,
                UPGRADE_HEADROOM_FLOOR,
                string.concat(proxied[i], " keeps under 1,024 bytes of EIP-170 margin (ADR-0014 9)")
            );
        }
    }

    /// @notice The vault family keeps its recorded headroom. Before ADR-0014 the basket kinds had
    ///         268 to 310 bytes. The upgrade base cost each tight contract about 2.6 KB and its
    ///         initializer about 2 KB of runtime; the size libraries (`VaultAdapterOps`,
    ///         `BasketSwapOps`, the single-call `BasketAssetConfigGuard.addAsset`) moved more than
    ///         that out. The floors below are the measured margins (`forge build --sizes`) after the
    ///         P1 follow-up that made `__GovernedUpgrade_init` write-once (about 42 bytes each):
    ///         AgentTokenVault 1,254 bytes, ProtocolAssetVault 1,325, RwaBasketVault 1,332,
    ///         RobotMoneyVault 1,556 (after P1 alone: 1,296, 1,367, 1,374, 1,598). Security round 1
    ///         spent some of it on purpose, still above the 1,024-byte ADR-0014 §9 floor: the
    ///         `emergencyExcludeAdapter` lever, the record-keeping `forceRemoveAdapter` and the
    ///         `nonReentrant` re-add cost RobotMoneyVault 169 bytes (now 1,387), and the ORA-4
    ///         check in `BasketVault.previewDeposit` cost each basket kind 15 (AgentTokenVault
    ///         1,239, ProtocolAssetVault 1,310, RwaBasketVault 1,317). Security round 2 spent 174
    ///         more RobotMoneyVault bytes on the `recoverRemovedAdapter` lever (now 1,213, still
    ///         above the floor). Security round 3 spent 36 more on the venue-health deposit gate
    ///         (`VaultAdapterOps.anyActiveBlocked`, now 1,177). A change that eats them fails here
    ///         before it fails an EIP-170 deploy.
    function test_vaultFamily_keepsItsMeasuredHeadroom() public {
        assertGe(
            EIP170_LIMIT - vm.getDeployedCode("AgentTokenVault.sol:AgentTokenVault").length, 1_239
        );
        assertGe(
            EIP170_LIMIT - vm.getDeployedCode("ProtocolAssetVault.sol:ProtocolAssetVault").length,
            1_310
        );
        assertGe(
            EIP170_LIMIT - vm.getDeployedCode("RwaBasketVault.sol:RwaBasketVault").length, 1_317
        );
        assertGe(
            EIP170_LIMIT - vm.getDeployedCode("RobotMoneyVault.sol:RobotMoneyVault").length, 1_177
        );
    }
}
