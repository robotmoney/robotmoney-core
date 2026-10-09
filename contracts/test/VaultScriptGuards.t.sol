// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499, core S1 (issue 1483)
pragma solidity ^0.8.24;

import {BasketDeployFixture} from "./helpers/BasketDeployFixture.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";

contract ProtocolGuardHarness is DeployProtocolAssetVault {
    function runPrefixed(string memory prefix) external returns (Deployed memory) {
        return _runFrom(prefix, CONFIG_FILE, "assets");
    }

    function readPrefixed(string memory prefix) external view returns (Params memory) {
        return _readParamsFrom(prefix);
    }
}

contract AgentGuardHarness is DeployAgentTokenVault {
    function runPrefixed(string memory prefix) external returns (Deployed memory) {
        return _runFrom(prefix, CONFIG_FILE, "shortlist");
    }

    function readPrefixed(string memory prefix) external view returns (Params memory) {
        return _readParamsFrom(prefix);
    }
}

contract RwaGuardHarness is DeployRwaBasketVault {
    function runPrefixed(string memory prefix) external returns (Deployed memory) {
        return _runFrom(prefix, CONFIG_FILE, "assets");
    }

    function readPrefixed(string memory prefix) external view returns (Params memory) {
        return _readParamsFrom(prefix);
    }
}

/// @notice Shared guard and sheet-input cases for the three basket vault scripts. Env vars are
///         process-wide and forge runs test contracts in parallel, so every case reads its inputs
///         through a prefix that no other test uses. The unprefixed `run()` guard is covered in
///         `DeployScriptChainGuards.t.sol`. A subclass supplies the harness and its prefix.
abstract contract VaultScriptGuardBase is BasketDeployFixture {
    string internal constant MSG = "EXPECTED_CHAIN_ID must be set to 8453 on Base mainnet";

    function _runPrefixed(string memory prefix) internal virtual;
    function _readPrefixed(string memory prefix)
        internal
        virtual
        returns (BasketVaultDeployBase.Params memory);
    function _runInProcess(BasketVaultDeployBase.Params memory p) internal virtual;
    /// @dev Unique per subclass.
    function _ns() internal pure virtual returns (string memory);

    function setUp() public {
        _fixtureSetUp();
    }

    /// @dev Sets every sheet input under `<ns>_<tag>_` except `skip`.
    function _setSheet(string memory prefix, string memory skip) internal {
        _setIf(prefix, skip, "ADMIN_ADDRESS", vm.toString(deployer));
        _setIf(prefix, skip, "SWAP_ROUTER", vm.toString(router02));
        _setIf(prefix, skip, "REGISTRY_ADDRESS", vm.toString(address(registry)));
        _setIf(prefix, skip, "TVL_CAP", "50000000000");
        _setIf(prefix, skip, "PER_DEPOSIT_CAP", "5000000000");
        _setIf(prefix, skip, "FEE_RECIPIENT", vm.toString(feeRecipient));
        _setIf(prefix, skip, "EXIT_FEE_BPS", "0");
        _setIf(prefix, skip, "NAV_DEVIATION_BPS", "100");
        _setIf(prefix, skip, "MIN_POOL_LIQUIDITY", "1000000000000");
    }

    function _setIf(
        string memory prefix,
        string memory skip,
        string memory name,
        string memory value
    ) internal {
        if (keccak256(bytes(skip)) == keccak256(bytes(name))) return;
        vm.setEnv(string.concat(prefix, name), value);
    }

    function _p(string memory tag) internal pure returns (string memory) {
        return string.concat(_ns(), "_", tag, "_");
    }

    // ─── chain guard on chain id 8453 ─────────────────────────────────────────

    function test_guard_unsetExpectedChainIdRevertsOnBase() public {
        vm.chainId(8453);
        vm.expectRevert(bytes(MSG));
        _runPrefixed(_p("unset"));
    }

    function test_guard_wrongExpectedChainIdRevertsOnBase() public {
        vm.chainId(8453);
        string memory prefix = _p("wrong");
        vm.setEnv(string.concat(prefix, "EXPECTED_CHAIN_ID"), "31337");
        vm.expectRevert(bytes(MSG));
        _runPrefixed(prefix);
        vm.setEnv(string.concat(prefix, "EXPECTED_CHAIN_ID"), "0");
    }

    function test_guard_zeroExpectedChainIdRevertsOnBase() public {
        vm.chainId(8453);
        string memory prefix = _p("zero");
        vm.setEnv(string.concat(prefix, "EXPECTED_CHAIN_ID"), "0");
        vm.expectRevert(bytes(MSG));
        _runPrefixed(prefix);
    }

    function test_guard_mismatchRevertsOnTwinChain() public {
        vm.chainId(918453);
        string memory prefix = _p("twin");
        vm.setEnv(string.concat(prefix, "EXPECTED_CHAIN_ID"), "8453");
        vm.expectRevert(bytes("EXPECTED_CHAIN_ID does not match the RPC's chain id"));
        _runPrefixed(prefix);
        vm.setEnv(string.concat(prefix, "EXPECTED_CHAIN_ID"), "0");
    }

    // ─── sheet inputs: caps, recipient ────────────────────────────────────────

    function test_sheet_allInputsPresentReads() public {
        string memory prefix = _p("ok");
        _setSheet(prefix, "");
        BasketVaultDeployBase.Params memory p = _readPrefixed(prefix);
        assertEq(p.tvlCap, 50_000_000_000);
        assertEq(p.perDepositCap, 5_000_000_000);
        assertEq(p.feeRecipient, feeRecipient);
    }

    function test_sheet_missingTvlCapReverts() public {
        string memory prefix = _p("notvl");
        _setSheet(prefix, "TVL_CAP");
        vm.expectRevert(bytes(string.concat(prefix, "TVL_CAP must be set")));
        _readPrefixed(prefix);
    }

    function test_sheet_missingPerDepositCapReverts() public {
        string memory prefix = _p("nopdc");
        _setSheet(prefix, "PER_DEPOSIT_CAP");
        vm.expectRevert(bytes(string.concat(prefix, "PER_DEPOSIT_CAP must be set")));
        _readPrefixed(prefix);
    }

    function test_sheet_missingFeeRecipientReverts() public {
        string memory prefix = _p("nofee");
        _setSheet(prefix, "FEE_RECIPIENT");
        vm.expectRevert(bytes(string.concat(prefix, "FEE_RECIPIENT must be set")));
        _readPrefixed(prefix);
    }

    function test_sheet_malformedTvlCapReverts() public {
        string memory prefix = _p("badtvl");
        _setSheet(prefix, "TVL_CAP");
        vm.setEnv(string.concat(prefix, "TVL_CAP"), "50k");
        vm.expectRevert(
            bytes(string.concat(prefix, "TVL_CAP is malformed: expected an unsigned integer"))
        );
        _readPrefixed(prefix);
    }

    function test_sheet_malformedPerDepositCapReverts() public {
        string memory prefix = _p("badpdc");
        _setSheet(prefix, "PER_DEPOSIT_CAP");
        vm.setEnv(string.concat(prefix, "PER_DEPOSIT_CAP"), "-1");
        vm.expectRevert(
            bytes(
                string.concat(prefix, "PER_DEPOSIT_CAP is malformed: expected an unsigned integer")
            )
        );
        _readPrefixed(prefix);
    }

    function test_sheet_malformedFeeRecipientReverts() public {
        string memory prefix = _p("badfee");
        _setSheet(prefix, "FEE_RECIPIENT");
        vm.setEnv(string.concat(prefix, "FEE_RECIPIENT"), "not-an-address");
        vm.expectRevert(
            bytes(string.concat(prefix, "FEE_RECIPIENT is malformed: expected an address"))
        );
        _readPrefixed(prefix);
    }

    function test_sheet_missingExitFeeReverts() public {
        string memory prefix = _p("noexit");
        _setSheet(prefix, "EXIT_FEE_BPS");
        vm.expectRevert(bytes(string.concat(prefix, "EXIT_FEE_BPS must be set")));
        _readPrefixed(prefix);
    }

    function test_sheet_malformedExitFeeRevertsInsteadOfDefaulting() public {
        string memory prefix = _p("badexit");
        _setSheet(prefix, "");
        vm.setEnv(string.concat(prefix, "EXIT_FEE_BPS"), "ten");
        vm.expectRevert(
            bytes(string.concat(prefix, "EXIT_FEE_BPS is malformed: expected an unsigned integer"))
        );
        _readPrefixed(prefix);
    }

    // ─── caps checked again at deploy time ────────────────────────────────────

    function test_deploy_zeroTvlCapReverts() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.tvlCap = 0;
        vm.expectRevert(bytes("TVL_CAP missing from the sheet"));
        _runInProcess(p);
    }

    function test_deploy_zeroPerDepositCapReverts() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.perDepositCap = 0;
        vm.expectRevert(bytes("PER_DEPOSIT_CAP missing from the sheet"));
        _runInProcess(p);
    }

    function test_deploy_perDepositAboveTvlReverts() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.perDepositCap = p.tvlCap + 1;
        vm.expectRevert(bytes("PER_DEPOSIT_CAP exceeds TVL_CAP"));
        _runInProcess(p);
    }

    function test_deploy_zeroFeeRecipientReverts() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.feeRecipient = address(0);
        vm.expectRevert(bytes("FEE_RECIPIENT=0"));
        _runInProcess(p);
    }

    function test_sheet_missingNavDeviationBpsReverts() public {
        string memory prefix = _p("nonav");
        _setSheet(prefix, "NAV_DEVIATION_BPS");
        vm.expectRevert(bytes(string.concat(prefix, "NAV_DEVIATION_BPS must be set")));
        _readPrefixed(prefix);
    }

    function test_sheet_missingMinPoolLiquidityReverts() public {
        string memory prefix = _p("nofloor");
        _setSheet(prefix, "MIN_POOL_LIQUIDITY");
        vm.expectRevert(bytes(string.concat(prefix, "MIN_POOL_LIQUIDITY must be set")));
        _readPrefixed(prefix);
    }

    function test_deploy_zeroNavDeviationBpsReverts() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.navDeviationGuardBps = 0;
        vm.expectRevert(bytes("NAV_DEVIATION_BPS must be 1..2000"));
        _runInProcess(p);
    }

    function test_deploy_navDeviationBpsAboveCeilingReverts() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.navDeviationGuardBps = 2001;
        vm.expectRevert(bytes("NAV_DEVIATION_BPS must be 1..2000"));
        _runInProcess(p);
    }

    function _emptyJson(string memory key) internal view returns (string memory) {
        return string.concat('{"swapRouter02":"', vm.toString(router02), '","', key, '":[]}');
    }
}

contract ProtocolAssetVaultScriptGuardsTest is VaultScriptGuardBase {
    ProtocolGuardHarness internal h = new ProtocolGuardHarness();

    function _ns() internal pure override returns (string memory) {
        return "GPROTO";
    }

    function _runPrefixed(string memory prefix) internal override {
        h.runPrefixed(prefix);
    }

    function _readPrefixed(string memory prefix)
        internal
        override
        returns (BasketVaultDeployBase.Params memory)
    {
        return h.readPrefixed(prefix);
    }

    function _runInProcess(BasketVaultDeployBase.Params memory p) internal override {
        h.runInProcess(p, _emptyJson("assets"));
    }
}

contract AgentTokenVaultScriptGuardsTest is VaultScriptGuardBase {
    AgentGuardHarness internal h = new AgentGuardHarness();

    function _ns() internal pure override returns (string memory) {
        return "GAGENT";
    }

    function _runPrefixed(string memory prefix) internal override {
        h.runPrefixed(prefix);
    }

    function _readPrefixed(string memory prefix)
        internal
        override
        returns (BasketVaultDeployBase.Params memory)
    {
        return h.readPrefixed(prefix);
    }

    function _runInProcess(BasketVaultDeployBase.Params memory p) internal override {
        h.runInProcess(p, _emptyJson("shortlist"));
    }
}

contract RwaBasketVaultScriptGuardsTest is VaultScriptGuardBase {
    RwaGuardHarness internal h = new RwaGuardHarness();

    function _ns() internal pure override returns (string memory) {
        return "GRWA";
    }

    function _runPrefixed(string memory prefix) internal override {
        h.runPrefixed(prefix);
    }

    function _readPrefixed(string memory prefix)
        internal
        override
        returns (BasketVaultDeployBase.Params memory)
    {
        return h.readPrefixed(prefix);
    }

    function _runInProcess(BasketVaultDeployBase.Params memory p) internal override {
        h.runInProcess(p, _emptyJson("assets"));
    }
}
