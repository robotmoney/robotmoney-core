// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §3 — seed deposit precondition
// Covers: issue #656 — CI fork test for ERC-4626 seed deposit precondition
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";

/// @title DeploySeedDeposit
/// @notice Fork test asserting that after running the deploy script the vault
///         satisfies the seed deposit precondition required by the deploy runbook:
///           - vault.totalAssets() >= 1_000 * 1e6 (1,000 USDC)
///           - vault.totalSupply() > 0
///         before any simulated public deposit.
///
/// @dev These tests run against a live Base mainnet fork.  They skip cleanly
///      when neither `FORK_RPC_URL` nor `RMPC_FORK_RPC_URL` is set so that
///      contributor laptops without an archive RPC remain green.
///
///      To run locally:
///        FORK_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> \
///          forge test --match-contract DeploySeedDeposit --fork-url $FORK_RPC_URL -vvv
///
///      In CI the secret is `RMPC_FORK_RPC_URL` (same variable used by the
///      suite-01-02 fork-regressions job).  The job sets it before calling
///      forge test so these tests execute rather than skip.
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

    Deploy internal script;

    // ─── Fork helpers ──────────────────────────────────────────────────────────

    /// @dev Attempt to read FORK_RPC_URL / RMPC_FORK_RPC_URL.
    ///      Returns "" if neither is set so callers can skip gracefully.
    function _forkRpcUrl() internal view returns (string memory) {
        try vm.envString("FORK_RPC_URL") returns (string memory s) {
            if (bytes(s).length > 0) return s;
        } catch {}
        try vm.envString("RMPC_FORK_RPC_URL") returns (string memory s) {
            if (bytes(s).length > 0) return s;
        } catch {}
        return "";
    }

    /// @dev Create and select a Base mainnet fork.
    ///      Returns false (skip signal) when no RPC URL is configured.
    function _trySelectFork() internal returns (bool) {
        string memory rpc = _forkRpcUrl();
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        return true;
    }

    /// @dev Shared setup: create the deploy script, named test accounts,
    ///      and ensure admin has enough USDC for the seed deposit.
    ///      Returns false when the fork URL is absent (test should skip).
    function _setUp() internal returns (bool) {
        if (!_trySelectFork()) return false;

        admin = makeAddr("admin");
        pauser = makeAddr("pauser");
        agent = makeAddr("agent");
        shareReceiver = makeAddr("shareReceiver");
        script = new Deploy();

        // Fund admin with the seed deposit amount so the deploy can execute it.
        deal(BASE_USDC, admin, script.SEED_DEPOSIT_AMOUNT());

        return true;
    }

    /// @dev Run the deploy script in-process with real Base USDC and seed deposit.
    ///      Adapters are deployed against real Base mainnet protocol addresses.
    ///      Uses runInProcessWithSeed() which includes the mandatory seed deposit step.
    function _runDeploy() internal returns (Deploy.Deployed memory) {
        return script.runInProcessWithSeed(admin, pauser, agent, shareReceiver, BASE_USDC);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Core seed deposit precondition tests (issue #656 acceptance criteria)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice After deploy, vault.totalAssets() >= 1_000_000_000 (1,000 USDC).
    ///
    ///         This is the primary AC from issue #656: the deploy runbook must
    ///         seed the vault with ≥ 1,000 USDC before the vault is opened to
    ///         the public (security-model.md §3).
    function test_fork_deploySeed_totalAssetsAtLeastMinSeed() public {
        if (!_setUp()) return; // skip: no FORK_RPC_URL

        Deploy.Deployed memory d = _runDeploy();

        assertGe(
            d.vault.totalAssets(),
            1_000_000_000, // 1,000 USDC in 6-decimal wei
            "vault.totalAssets must be >= 1_000_000_000 after deploy seed"
        );
    }

    /// @notice After deploy, vault.totalSupply() > 0.
    ///
    ///         A zero totalSupply before the first public deposit would leave
    ///         the vault vulnerable to the inflation attack despite the 18-decimal
    ///         offset.  The seed deposit eliminates this window.
    function test_fork_deploySeed_totalSupplyPositive() public {
        if (!_setUp()) return; // skip: no FORK_RPC_URL

        Deploy.Deployed memory d = _runDeploy();

        assertGt(
            d.vault.totalSupply(),
            0,
            "vault.totalSupply must be > 0 before any public deposit"
        );
    }

    /// @notice Admin (deployer) holds seed shares after deploy.
    ///
    ///         The seed deposit mints shares to the admin/deployer; the
    ///         public cannot exploit a zero-supply state even briefly.
    function test_fork_deploySeed_adminHoldsShares() public {
        if (!_setUp()) return; // skip: no FORK_RPC_URL

        Deploy.Deployed memory d = _runDeploy();

        assertGt(
            d.vault.balanceOf(admin),
            0,
            "admin must hold seed shares after deploy"
        );
    }

    /// @notice A public deposit made immediately after deploy mints fair shares.
    ///
    ///         This is the downstream consequence of the seed precondition:
    ///         a first public depositor cannot be front-run by an inflation attacker
    ///         because the vault already has positive supply and assets.
    function test_fork_deploySeed_firstPublicDepositReceivesFairShares() public {
        if (!_setUp()) return; // skip: no FORK_RPC_URL

        Deploy.Deployed memory d = _runDeploy();

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
