// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499 — core S3, stage "vault"
// (See also: docs/architecture.md §6 — Roles)
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {AdapterBytecodeGuard} from "./AdapterBytecodeGuard.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../adapters/CompoundV3Adapter.sol";
import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title DeployVault
/// @notice Stage 2 of the core deploy (libs, vault, registry, router, gateway).
///         Deploys RobotMoneyVault (rmUSDC) with its three real strategy adapters (Aave V3,
///         Compound V3, Moonwell Flagship USDC through the ERC-4626 `MorphoAdapter`), allows
///         the adapters, registers them with 3334 / 3333 / 3333 bps caps, and makes the
///         seed deposit that anchors the share price. The vault is deployed paused (core 1710):
///         `pauseDeposits()` runs right after the seed deposit, and the govern stage opens it
///         through the Safe and the timelock like the three basket vaults.
///
///         The gateway, router and registry are NOT deployed here: the registry, router and
///         gateway stages follow. The old single script deployed the gateway with a zero
///         router (core 1493). The order is now fixed by the stage scripts.
///
/// @dev Required env vars (all required on every chain, no defaults):
///        EXPECTED_CHAIN_ID     — mandatory and equal to 8453 on Base mainnet
///        ADMIN_ADDRESS         — receives ADMIN_ROLE and EMERGENCY_ROLE on the vault
///        FEE_RECIPIENT — vault fee recipient (the treasury, never the deployer)
///        TVL_CAP, PER_DEPOSIT_CAP — vault caps, 6-decimal USDC units
///        SEED_SHARE_RECEIVER   — receives the seed shares. Not zero, not the deployer (ADMIN_ADDRESS).
///                                The deployer holds no shares after this stage.
///        DEPLOYMENT_OUT        — output JSON path
///      USDC is the canonical Base USDC constant on every chain (no USDC_ADDRESS).
///        EXIT_FEE_BPS     — exit fee in basis points (0 is a valid value)
///        SEED_DEPOSIT_USDC      — seed in 6-decimal USDC units (non-zero)
contract DeployVault is ExpectedChainGuard {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "vault.json";

    /// @notice Canonical Base mainnet USDC (FiatTokenProxy).
    address public constant CANONICAL_BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // -- Real protocol contract addresses (Base mainnet) ----------------

    /// @notice Aave V3 Pool on Base mainnet.
    address public constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    /// @notice aBasUSDC — Aave V3 interest-bearing USDC receipt token on Base.
    address public constant AAVE_V3_A_TOKEN = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    /// @notice Compound V3 (Comet) USDC market on Base.
    /// @dev Verified against `cast call <compound-adapter> "COMET()(address)"` on Base mainnet.
    address public constant COMPOUND_V3_COMET = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    /// @notice The third venue: Moonwell Flagship USDC (mwUSDC), an ERC-4626 Morpho vault.
    /// @dev Read on Base mainnet: `name()` is "Moonwell Flagship USDC" and `symbol()` is
    ///      "mwUSDC". Decided 2026-10-02 (core 1485): the third venue is Moonwell Flagship, not
    ///      Gauntlet Prime. The constant, the manifest keys and every doc use this name.
    address public constant MOONWELL_FLAGSHIP_USDC = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca;
    /// @notice Display names the manifest records for the three venues. The third equals
    ///         the venue's on-chain `name()`.
    /// @notice Manifest display name of the Aave V3 venue.
    string public constant VENUE_NAME_AAVE = "Aave V3 USDC";
    /// @notice Manifest display name of the Compound V3 venue.
    string public constant VENUE_NAME_COMPOUND = "Compound V3 USDC";
    /// @notice Manifest display name of the third venue (Moonwell Flagship USDC).
    string public constant VENUE_NAME_THIRD = "Moonwell Flagship USDC";

    /// @notice Adapter bps caps, in registration order. They sum to 10 000.
    /// @notice Aave V3 adapter cap in basis points.
    uint16 public constant AAVE_BPS = 3_334;
    /// @notice Compound V3 adapter cap in basis points.
    uint16 public constant COMPOUND_BPS = 3_333;
    /// @notice Third venue adapter cap in basis points.
    uint16 public constant THIRD_VENUE_BPS = 3_333;

    /// @notice Explicit gas for the broadcast seed `deposit` (core 1505). forge sends a call that
    ///         names its gas with exactly that gas limit, so the seed transaction is never sized by
    ///         forge's own estimate.
    /// @dev Why the estimate is not enough: `deposit` routes the seed through every adapter, and
    ///      before each `adapter.deploy` the vault checks `gasleft() >= ADAPTER_CALL_GAS_FLOOR`
    ///      (400 000, `RobotMoneyVault._allocateTo`). forge 1.8.x sets a broadcast gas limit of
    ///      about 1.38x to 1.46x the gas the call used with unlimited gas (G). A deposit needs
    ///      about 1.40x G, because the floor is checked but not spent. On the Twin chain at
    ///      Base block 52256191 forge sent 1 300 462 gas, the third (Moonwell) floor saw 370 589
    ///      and the seed reverted `InsufficientGas(370589, 400000)` after the vault and adapters
    ///      were already mined. `cast estimate` needed about 1.32M to 1.33M there.
    ///
    ///      How 3 000 000 is chosen: the floor is a check, not a cost, so the worst case is every
    ///      gas unit the deposit spends (G, about 1.1M on the Twin pins: three adapter
    ///      `totalAssets` reads, a second read pass, three `deploy` calls with the Moonwell
    ///      MetaMorpho deposit the largest) plus one 400 000 floor plus 1/64 call forwarding and
    ///      the intrinsic cost: about 1.55M. 3M covers that about 1.9x over, so venue state can
    ///      roughly double G (a longer MetaMorpho queue, a new Aave or Comet code path) before
    ///      the limit binds. Unused gas is refunded, so the only cost is the up-front balance
    ///      check (3M x the max fee) that the runner's fee guard already covers.
    uint256 public constant SEED_DEPOSIT_GAS = 3_000_000;

    struct Params {
        address admin;
        address feeRecipient;
        uint256 tvlCap;
        uint256 perDepositCap;
        uint256 exitFeeBps;
        address usdcAddress;
    }

    struct Deployed {
        address usdc;
        RobotMoneyVault vault;
        AaveV3Adapter aaveAdapter;
        CompoundV3Adapter compoundAdapter;
        MorphoAdapter moonwellAdapter;
        address admin;
    }

    /// @notice Forge broadcast entrypoint. Deploys, registers adapters, seeds, writes JSON.
    /// @return d The deployed contracts and admin.
    function run() external returns (Deployed memory d) {
        Params memory p = _readEnvParamsFrom("");
        address seedReceiver = _seedShareReceiver("", p.admin);
        vm.startBroadcast();
        d = _deploy(p);
        // The broadcaster IS d.admin: msg.sender holds ADMIN_ROLE. vm.prank is prohibited here.
        _approveAndRegisterAdapters(d);
        uint256 seed = _seedAmount("");
        uint256 seedShares = _seedStep(d, seedReceiver, seed);
        console2.log("  seed deposit (USDC):", seed);
        console2.log("  seed shares minted :", seedShares);
        console2.log("  seed share receiver:", seedReceiver);
        vm.stopBroadcast();
        _writeDeploymentJsonTo(d, seedReceiver, seedShares, _envStringRequired("DEPLOYMENT_OUT"));
    }

    /// @notice In-process variant for forge tests, no seed deposit. Env-driven.
    /// @return d The deployed contracts and admin.
    function runInProcess() external returns (Deployed memory d) {
        d = _deploy(_readEnvParamsFrom(""));
        vm.startPrank(d.admin);
        _approveAndRegisterAdapters(d);
        vm.stopPrank();
    }

    /// @notice Explicit-parameter variant that also seeds. Needs real venue state (fork tests).
    ///         The caller passes every input: the script holds no default cap, recipient or seed.
    /// @param p Deployment parameters (admin, caps, fee, USDC).
    /// @param seedReceiver_ Address that receives the seed shares.
    /// @param seed_ Seed deposit in 6-decimal USDC units.
    /// @return d The deployed contracts and admin.
    function runInProcessWithSeed(Params memory p, address seedReceiver_, uint256 seed_)
        external
        returns (Deployed memory d)
    {
        _requireSeedReceiver(seedReceiver_, p.admin);
        d = _deploy(p);
        vm.startPrank(d.admin);
        _approveAndRegisterAdapters(d);
        uint256 shares = _seedStep(d, seedReceiver_, seed_);
        vm.stopPrank();
        console2.log("  seed shares minted :", shares);
    }

    /// @notice Direct-parameter variant that takes every economic input. No seed.
    /// @param p Deployment parameters (admin, caps, fee, USDC).
    /// @return d The deployed contracts and admin.
    function runInProcessWithParams(Params memory p) external returns (Deployed memory d) {
        d = _deploy(p);
        vm.startPrank(d.admin);
        _approveAndRegisterAdapters(d);
        vm.stopPrank();
    }

    /// @dev The seed step itself, shared by the broadcast run and the in-process seeded run.
    ///      Refuses an unset (zero) or deployer receiver, deposits the seed for the receiver and
    ///      asserts the deployer holds no shares afterwards, then pauses deposits (core 1710: all
    ///      four vaults deploy paused, the govern stage unpauses them). The caller must be the
    ///      deployer, who holds EMERGENCY_ROLE until the timelock stage.
    function _seedStep(Deployed memory d, address receiver, uint256 seed)
        internal
        returns (uint256 shares)
    {
        _requireSeedReceiver(receiver, d.admin);
        IERC20(d.usdc).approve(address(d.vault), seed);
        // Fixed gas, never forge's estimate: the deposit passes a gas floor check per adapter.
        // See SEED_DEPOSIT_GAS.
        shares = d.vault.deposit{gas: SEED_DEPOSIT_GAS}(seed, receiver);
        require(d.vault.balanceOf(d.admin) == 0, "deployer must hold no seed shares");
        _requireSeeded(d, seed);
        d.vault.pauseDeposits();
        require(d.vault.depositsPaused(), "rmUSDC must deploy paused");
    }

    /// @dev The seed share receiver: `<prefix>SEED_SHARE_RECEIVER`, required on every chain.
    function _seedShareReceiver(string memory prefix, address deployer)
        internal
        view
        returns (address receiver)
    {
        receiver = _envAddressRequired(string.concat(prefix, "SEED_SHARE_RECEIVER"));
        _requireSeedReceiver(receiver, deployer);
    }

    /// @dev The receiver is never zero and never the deployer, so the deployer keeps no shares.
    function _requireSeedReceiver(address receiver, address deployer) internal pure {
        require(receiver != address(0), "SEED_SHARE_RECEIVER=0");
        require(receiver != deployer, "SEED_SHARE_RECEIVER=deployer");
    }

    /// @dev The seed this broadcast run deposits: `<prefix>SEED_DEPOSIT_USDC`, required.
    ///      Must be non-zero.
    function _seedAmount(string memory prefix) internal view returns (uint256 seed) {
        seed = _envUintRequired(string.concat(prefix, "SEED_DEPOSIT_USDC"));
        require(seed > 0, "SEED_DEPOSIT_USDC=0");
    }

    /// @dev `prefix` is "" in production. Tests pass their own prefix because env vars are
    ///      process-wide and forge runs tests in parallel.
    function _readEnvParamsFrom(string memory prefix) internal view returns (Params memory p) {
        _requireExpectedChain(prefix);
        p.admin = _envAddressRequired(string.concat(prefix, "ADMIN_ADDRESS"));
        p.feeRecipient = _envAddressRequired(string.concat(prefix, "FEE_RECIPIENT"));
        p.tvlCap = _envUintRequired(string.concat(prefix, "TVL_CAP"));
        p.perDepositCap = _envUintRequired(string.concat(prefix, "PER_DEPOSIT_CAP"));
        p.exitFeeBps = _envUintRequired(string.concat(prefix, "EXIT_FEE_BPS"));
        p.usdcAddress = BASE_USDC;
    }

    function _approveAndRegisterAdapters(Deployed memory d) internal {
        _approveAdapter(d.vault, address(d.aaveAdapter));
        _approveAdapter(d.vault, address(d.compoundAdapter));
        _approveAdapter(d.vault, address(d.moonwellAdapter));
        d.vault.addAdapter(address(d.aaveAdapter), AAVE_BPS);
        d.vault.addAdapter(address(d.compoundAdapter), COMPOUND_BPS);
        d.vault.addAdapter(address(d.moonwellAdapter), THIRD_VENUE_BPS);
    }

    /// @dev Allow up to 1 bps of rounding loss when real venues convert USDC to receipt
    ///      tokens. The property is that assets landed (totalAssets > 0), not exact round trip.
    function _requireSeeded(Deployed memory d, uint256 seed) internal view {
        require(d.vault.totalAssets() >= seed * 9_999 / 10_000, "seed deposit: totalAssets too low");
        require(d.vault.totalSupply() > 0, "seed deposit: totalSupply must be > 0");
    }

    /// @dev Approves `adapter_` on `vault_` after asserting the no-proxy invariant: the
    ///      adapter's runtime bytecode must not contain a `DELEGATECALL` opcode (issue #448).
    function _approveAdapter(RobotMoneyVault vault_, address adapter_) internal {
        AdapterBytecodeGuard.requireNoDelegatecall(adapter_);
        vault_.setAdapterAllowed(adapter_, true);
        vault_.setAdapterCodeHashAllowed(adapter_.codehash, true);
    }

    function _deploy(Params memory p) internal returns (Deployed memory d) {
        require(p.admin != address(0), "ADMIN_ADDRESS=0");
        require(p.usdcAddress != address(0), "USDC_ADDRESS=0");
        require(p.usdcAddress.code.length > 0, "USDC_ADDRESS has no code");
        require(p.feeRecipient != address(0), "FEE_RECIPIENT=0");
        require(p.feeRecipient != msg.sender, "FEE_RECIPIENT=deployer");
        require(p.feeRecipient != p.admin, "FEE_RECIPIENT=admin");
        require(p.tvlCap > 0 && p.perDepositCap > 0, "TVL_CAP / PER_DEPOSIT_CAP = 0");
        d.admin = p.admin;
        d.usdc = p.usdcAddress;
        d.vault = new RobotMoneyVault(
            IERC20(d.usdc),
            p.tvlCap,
            p.perDepositCap,
            p.exitFeeBps,
            p.feeRecipient,
            p.admin, // vaultAdmin — receives ADMIN_ROLE
            p.admin // emergencyResponder — handed to the emergency key by the timelock stage
        );
        // Registration happens in the callers: the call context differs between broadcast
        // and in-process modes.
        d.aaveAdapter = new AaveV3Adapter(AAVE_V3_POOL, d.usdc, AAVE_V3_A_TOKEN, address(d.vault));
        d.compoundAdapter = new CompoundV3Adapter(COMPOUND_V3_COMET, d.usdc, address(d.vault));
        d.moonwellAdapter = new MorphoAdapter(MOONWELL_FLAGSHIP_USDC, d.usdc, address(d.vault));

        console2.log("RobotMoneyVault + Aave V3, Compound V3, Moonwell Flagship adapters deployed");
        console2.log("  usdc               :", d.usdc);
        console2.log("  vault              :", address(d.vault));
        console2.log("  aave_adapter       :", address(d.aaveAdapter));
        console2.log("  compound_adapter   :", address(d.compoundAdapter));
        console2.log("  moonwell_adapter   :", address(d.moonwellAdapter));
        console2.log("  admin              :", d.admin);
    }

    /// @notice Manifest keys written by this stage: chain_id, usdc, vault, aave_adapter,
    ///         compound_adapter, moonwell_flagship_adapter, admin, and one name/address pair
    ///         per venue: aave_v3_venue_name / aave_v3_venue, compound_v3_venue_name /
    ///         compound_v3_venue, moonwell_flagship_venue_name / moonwell_flagship_venue.
    ///         The old Morpho-named adapter key is gone: the third venue is named for the
    ///         address it wraps.
    ///         Seed fields: seed_share_receiver, seed_shares (minted to the receiver) and
    ///         deployer_share_balance_after (read from the vault at write time, must be 0).
    ///         The verifier asserts the deployer balance is 0 and the receiver holds the seed.
    function _writeDeploymentJsonTo(
        Deployed memory d,
        address seedReceiver,
        uint256 seedShares,
        string memory outPath
    ) internal {
        string memory obj = "vault_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "usdc", d.usdc);
        vm.serializeAddress(obj, "vault", address(d.vault));
        vm.serializeAddress(obj, "aave_adapter", address(d.aaveAdapter));
        vm.serializeAddress(obj, "compound_adapter", address(d.compoundAdapter));
        vm.serializeAddress(obj, "moonwell_flagship_adapter", address(d.moonwellAdapter));
        vm.serializeAddress(obj, "admin", d.admin);
        vm.serializeAddress(obj, "seed_share_receiver", seedReceiver);
        vm.serializeUint(obj, "seed_shares", seedShares);
        vm.serializeUint(obj, "deployer_share_balance_after", d.vault.balanceOf(d.admin));
        vm.serializeString(obj, "aave_v3_venue_name", VENUE_NAME_AAVE);
        vm.serializeAddress(obj, "aave_v3_venue", AAVE_V3_POOL);
        vm.serializeString(obj, "compound_v3_venue_name", VENUE_NAME_COMPOUND);
        vm.serializeAddress(obj, "compound_v3_venue", COMPOUND_V3_COMET);
        vm.serializeString(obj, "moonwell_flagship_venue_name", VENUE_NAME_THIRD);
        string memory json =
            vm.serializeAddress(obj, "moonwell_flagship_venue", MOONWELL_FLAGSHIP_USDC);

        vm.writeJson(json, outPath);
        console2.log("Wrote vault deployment JSON to", outPath);
    }
}
