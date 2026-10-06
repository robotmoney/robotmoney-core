// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §3 — seed deposit precondition
// Covers: issue #656 — CI fork test for ERC-4626 seed deposit precondition
pragma solidity ^0.8.24;

import {ForkSelect} from "./helpers/ForkSelect.sol";
import {VaultTestParams} from "./helpers/VaultTestParams.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployVault} from "../script/DeployVault.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";

/// @title DeploySeedDeposit
/// @notice Fork test asserting that after running the deploy script the vault
///         satisfies the seed deposit precondition required by the deploy runbook:
///           - vault.totalAssets() >= 99.99% of the seed (1 USDC, `VaultTestParams.SEED_DEPOSIT_AMOUNT`;
///             the broadcast run reads it from `SEED_DEPOSIT_USDC`)
///           - vault.totalSupply() > 0
///           - the seed shares go to the seed receiver (`SEED_SHARE_RECEIVER` in the broadcast run),
///             never to the deployer, who pays the seed USDC and holds no shares
///         before any simulated public deposit.
///
/// @dev CI runs this on the Twin chain (a pinned lazy anvil fork of real Base state) named by
///      `FORK_RPC_URL`. Unset, the tests skip with a named reason.
///
///      To run locally:
///        bun scripts/devnet/twin-fork.ts start && FORK_RPC_URL=http://127.0.0.1:8545 \
///          forge test --match-contract DeploySeedDeposit -vvv
///
///      No secret is needed: the upstream is the public Base endpoint unless BASE_UPSTREAM_RPC is set.
///
/// See docs/technical/security-model.md §3 and docs/technical/smart-contracts.md §8.3.
contract DeploySeedDeposit is Test {
    // ─── Base mainnet USDC ────────────────────────────────────────────────────

    /// @dev Real USDC on Base (Circle FiatTokenProxy).
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // ─── Test roles ────────────────────────────────────────────────────────────

    address internal admin;
    address internal pauser;
    address internal agent;
    address internal shareReceiver;

    DeployVault internal script;

    // ─── Fork helpers ──────────────────────────────────────────────────────────

    /// @dev Use the Twin chain named by FORK_RPC_URL, or skip.
    function _forkRpcUrl() internal view returns (string memory) {
        try vm.envString("FORK_RPC_URL") returns (string memory s) {
            if (bytes(s).length > 0) return s;
        } catch {}
        return "";
    }

    /// @dev Create and select a Base mainnet fork.
    ///      Returns false (skip signal) when no RPC URL is configured.
    function _trySelectFork() internal returns (bool) {
        string memory rpc = _forkRpcUrl();
        return ForkSelect.selectOrSkip(rpc);
    }

    /// @dev Shared setup: create the deploy script, named test accounts,
    ///      and fund the deployer (`admin`) with the 1 USDC seed it pays.
    ///      Returns false when the fork URL is absent (test should skip).
    function _setUp() internal returns (bool) {
        if (!_trySelectFork()) return false;

        admin = makeAddr("admin");
        pauser = makeAddr("pauser");
        agent = makeAddr("agent");
        shareReceiver = makeAddr("shareReceiver");
        script = new DeployVault();

        // Fund admin with the seed deposit amount so the deploy can execute it.
        deal(BASE_USDC, admin, VaultTestParams.SEED_DEPOSIT_AMOUNT);

        return true;
    }

    /// @dev Run the deploy script in-process with real Base USDC and seed deposit.
    ///      Adapters are deployed against real Base mainnet protocol addresses.
    ///      Uses runInProcessWithSeed() which includes the mandatory seed deposit step:
    ///      the deployer pays the seed and `shareReceiver` gets the seed shares.
    function _runDeploy() internal returns (DeployVault.Deployed memory) {
        return script.runInProcessWithSeed(
            VaultTestParams.params(admin, BASE_USDC),
            shareReceiver,
            VaultTestParams.SEED_DEPOSIT_AMOUNT
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Core seed deposit precondition tests (issue #656 acceptance criteria)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice After deploy, vault.totalAssets() >= 99.99% of the 1 USDC seed
    ///         (`VaultTestParams.SEED_DEPOSIT_AMOUNT` = 1e6).
    ///
    ///         This is the primary AC from issue #656: the deploy runbook must
    ///         seed the vault before it is opened to the public
    ///         (security-model.md §3). The broadcast run seeds `SEED_DEPOSIT_USDC`
    ///         (1 USDC on the stage sheet) and mints the shares to `SEED_SHARE_RECEIVER`.
    function test_fork_deploySeed_totalAssetsAtLeastMinSeed() public {
        _setUp();

        DeployVault.Deployed memory d = _runDeploy();

        assertGe(
            d.vault.totalAssets(),
            VaultTestParams.SEED_DEPOSIT_AMOUNT * 9_999 / 10_000,
            "vault.totalAssets must retain >= 99.99% of deploy seed"
        );
    }

    /// @notice After deploy, vault.totalSupply() > 0.
    ///
    ///         A zero totalSupply before the first public deposit would leave
    ///         the vault vulnerable to the inflation attack despite the 18-decimal
    ///         offset.  The seed deposit eliminates this window.
    function test_fork_deploySeed_totalSupplyPositive() public {
        _setUp();

        DeployVault.Deployed memory d = _runDeploy();

        assertGt(
            d.vault.totalSupply(), 0, "vault.totalSupply must be > 0 before any public deposit"
        );
    }

    /// @notice The seed receiver holds the seed shares and the deployer holds none.
    function test_fork_deploySeed_receiverHoldsShares() public {
        _setUp();

        DeployVault.Deployed memory d = _runDeploy();

        assertGt(d.vault.balanceOf(shareReceiver), 0, "receiver must hold seed shares");
        assertEq(d.vault.balanceOf(admin), 0, "deployer must hold no seed shares");
        assertEq(d.vault.balanceOf(shareReceiver), d.vault.totalSupply(), "receiver holds all");
    }

    /// @notice The seed deposit is called with the script's fixed gas, never a forge estimate
    ///         (core 1505). forge broadcasts a call that names its gas with exactly that gas
    ///         limit (`isFixedGasLimit` in the broadcast file), so this pins the gas limit of the
    ///         broadcast seed transaction. It also shows the fixed gas clears every adapter gas
    ///         floor at the fork's venue state.
    function test_fork_deploySeed_depositUsesFixedGas() public {
        _setUp();

        // The vault is the first contract the script creates.
        address vaultAt = vm.computeCreateAddress(address(script), vm.getNonce(address(script)));
        vm.expectCall(
            vaultAt,
            0,
            uint64(script.SEED_DEPOSIT_GAS()),
            abi.encodeWithSignature(
                "deposit(uint256,address)", VaultTestParams.SEED_DEPOSIT_AMOUNT, shareReceiver
            )
        );

        DeployVault.Deployed memory d = _runDeploy();

        assertEq(address(d.vault), vaultAt, "the vault is the script's first creation");
        assertGt(d.vault.totalSupply(), 0, "the seed deposit landed with the fixed gas");
    }

    /// @notice The fixed seed gas keeps at least 2x the largest `cast estimate` measured for the
    ///         seed deposit (1 329 873 on the Twin chain at Base block 52256191, core 1505). Runs
    ///         without a fork, so lowering the constant fails the plain unit run.
    function test_seedDepositGas_keepsHeadroomOverMeasuredEstimate() public {
        DeployVault s = new DeployVault();
        assertGe(s.SEED_DEPOSIT_GAS(), 2 * 1_329_873, "seed gas below 2x the measured estimate");
    }

    // The seed step refuses an unset (zero) or deployer receiver before it deploys anything,
    // so these three need no fork state.

    /// @notice An unset receiver reads as the zero address: the seed step reverts.
    function test_seedStep_unsetReceiver_reverts() public {
        DeployVault s = new DeployVault();
        address a = makeAddr("seed-admin");
        vm.expectRevert(bytes("SEED_SHARE_RECEIVER=0"));
        s.runInProcessWithSeed(
            VaultTestParams.params(a, BASE_USDC), address(0), VaultTestParams.SEED_DEPOSIT_AMOUNT
        );
    }

    /// @notice A zero receiver reverts the seed step.
    function test_seedStep_zeroReceiver_reverts() public {
        DeployVault s = new DeployVault();
        address a = makeAddr("seed-admin");
        vm.expectRevert(bytes("SEED_SHARE_RECEIVER=0"));
        s.runInProcessWithSeed(
            VaultTestParams.params(a, BASE_USDC), address(0x0), VaultTestParams.SEED_DEPOSIT_AMOUNT
        );
    }

    /// @notice The deployer as receiver reverts the seed step (the deployer is retired).
    function test_seedStep_deployerReceiver_reverts() public {
        DeployVault s = new DeployVault();
        address a = makeAddr("seed-admin");
        vm.expectRevert(bytes("SEED_SHARE_RECEIVER=deployer"));
        s.runInProcessWithSeed(
            VaultTestParams.params(a, BASE_USDC), a, VaultTestParams.SEED_DEPOSIT_AMOUNT
        );
    }

    /// @notice A public deposit made immediately after deploy mints fair shares.
    ///
    ///         This is the downstream consequence of the seed precondition:
    ///         a first public depositor cannot be front-run by an inflation attacker
    ///         because the vault already has positive supply and assets.
    function test_fork_deploySeed_firstPublicDepositReceivesFairShares() public {
        _setUp();

        DeployVault.Deployed memory d = _runDeploy();

        address publicUser = makeAddr("publicUser");
        uint256 publicDeposit = 1_000 * 1e6; // 1,000 USDC
        deal(BASE_USDC, publicUser, publicDeposit);

        vm.prank(publicUser);
        IERC20(BASE_USDC).approve(address(d.vault), publicDeposit);

        vm.prank(publicUser);
        uint256 shares = d.vault.deposit(publicDeposit, publicUser);

        // Non-zero shares: the vault has sufficient supply to price correctly.
        assertGt(shares, 0, "first public deposit must mint non-zero shares");

        // Value recovery: public user can recover ≥ 90% of their deposit.
        // The 90% floor is intentionally generous; the seed + 18-decimal offset
        // makes the actual loss negligible but a hard floor catches regressions.
        uint256 valueBack = d.vault.previewRedeem(shares);
        assertGe(
            valueBack * 100,
            publicDeposit * 90,
            "first public depositor must recover >= 90% of deposit value"
        );
    }
}
