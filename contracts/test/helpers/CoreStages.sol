// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499 — core S3
pragma solidity ^0.8.24;

import {VaultTestParams} from "./VaultTestParams.sol";
import {Vm} from "forge-std/Vm.sol";

import {DeployLibs} from "../../script/DeployLibs.s.sol";
import {DeployVault} from "../../script/DeployVault.s.sol";
import {DeployVaultRegistry} from "../../script/DeployVaultRegistry.s.sol";
import {DeployPortfolioRouter} from "../../script/DeployPortfolioRouter.s.sol";
import {DeployGateway} from "../../script/DeployGateway.s.sol";
import {RobotMoneyVault} from "../../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../../gateway/RobotMoneyGateway.sol";
import {VaultRegistry} from "../../VaultRegistry.sol";
import {PortfolioRouter} from "../../PortfolioRouter.sol";

/// @notice Runs the core stage scripts in process, in production order:
///         libs, vault, registry, router, gateway. Tests use it where a single deploy script used to be called. Agent authorization is part of the gateway stage and runs
///         after the gateway exists. The IC policy stage is a separate script that tests call
///         when they need it.
/// @dev Not a Script: it carries no cheatcode state of its own. The stage scripts it creates
///      are the production scripts. `stages` is the order the run followed, for tests that
///      assert the order.
contract CoreStages {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Stack {
        address usdc;
        RobotMoneyVault vault;
        RobotMoneyGateway gateway;
        VaultRegistry registry;
        PortfolioRouter router;
        DeployVault.Deployed vaultStage;
        address admin;
        address pauser;
        address agent;
        address shareReceiver;
        bytes32 gatewayRuntimeHash;
    }

    DeployLibs public libsScript;
    DeployVault public vaultScript;
    DeployVaultRegistry public registryScript;
    DeployPortfolioRouter public routerScript;
    DeployGateway public gatewayScript;

    /// @notice Stage names in the order `run` executed them.
    string[] public stages;

    constructor() {
        libsScript = new DeployLibs();
        vaultScript = new DeployVault();
        registryScript = new DeployVaultRegistry();
        routerScript = new DeployPortfolioRouter();
        gatewayScript = new DeployGateway();
    }

    function stageCount() external view returns (uint256) {
        return stages.length;
    }

    function run(
        address admin_,
        address pauser_,
        address agent_,
        address shareReceiver_,
        address usdc_
    ) external returns (Stack memory s) {
        s.admin = admin_;
        s.pauser = pauser_;
        s.agent = agent_;
        s.shareReceiver = shareReceiver_;
        s.usdc = usdc_;

        libsScript.runInProcess();
        stages.push("libs");

        s.vaultStage = vaultScript.runInProcessWithParams(VaultTestParams.params(admin_, usdc_));
        s.vault = s.vaultStage.vault;
        stages.push("vault");

        DeployVaultRegistry.Deployed memory r =
            registryScript.runInProcessWith(admin_, address(s.vault), usdc_, "Robot Money USDC");
        s.registry = r.registry;
        stages.push("registry");

        DeployPortfolioRouter.Deployed memory rt =
            routerScript.runInProcessWith(admin_, address(s.registry), address(s.vault), usdc_);
        s.router = rt.router;
        stages.push("router");

        DeployGateway.Deployed memory g = gatewayScript.runInProcessWith(
            admin_, pauser_, agent_, shareReceiver_, usdc_, address(s.vault), address(s.router)
        );
        s.gateway = g.gateway;
        s.gatewayRuntimeHash = g.gatewayRuntimeHash;
        stages.push("gateway");
    }
}
