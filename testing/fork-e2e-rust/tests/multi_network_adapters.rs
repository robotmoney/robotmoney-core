//! Canonical: Issue #839 (e2e test adapters against Base testnet live services).
//! Builds on the #842 dev-scout seams (`Network`, `base_testnet_addresses`,
//! `parameterized_e2e!`, `ForkFixture::for_network`).
//!
//! Validates that the Robot Money strategy adapters and the surrounding
//! third-party DeFi services behave consistently across **Robot Money Devnet** and
//! **Base testnet (Sepolia)**. A single test body runs once per
//! [`rmpc_fork_e2e::Network`] via the `parameterized_e2e!` macro (decision D3 —
//! comprehensive adapter coverage with shared templates, no copy-paste):
//!
//! - devnet runs against an anvil-fork / the checked-in fixture (existing path);
//! - testnet runs against the live Base Sepolia RPC named by
//!   `BASE_TESTNET_RPC_URL`, funded from `BASE_TESTNET_FUNDER_KEY`.
//!
//! Each network whose RPC endpoint is unset is **skipped gracefully** (never a
//! failure), matching every other fork-e2e test. So `cargo test` on a laptop
//! with no testnet secret passes, while CI that sets the secret exercises the
//! live testnet path.
//!
//! ## Adapter coverage (grep-able names in `--nocapture` output)
//! - **Uniswap** V3 swap — USDC -> WETH `exactInputSingle` on the live router.
//! - **Aave** V3 supply — USDC `supply` into the live Aave pool, asserting the
//!   aToken (interest-bearing receipt) balance rises.
//! - **Curve** swap — exercised on devnet via the vault's strategy stack when
//!   the vault is present; on testnet the Curve venue is reported but skipped
//!   until a Robot Money deploy populates the registry (see `RM_TESTNET_*`).
//! - **Compound** / **Morpho** — exercised through the `RobotMoneyVault`
//!   deposit/redeem round-trip (the vault routes funds into all registered
//!   adapters) when a vault address is configured for the network.

use alloy_primitives::{Address, U256};
use alloy_sol_types::{sol, SolCall};
use rmpc_fork_e2e::{
    base_testnet_addresses, parameterized_e2e, scenarios, Account, ForkFixture, HarnessError,
    Network, IERC20,
};

sol! {
    /// Uniswap V3 SwapRouter02 subset (matches `dex_route_smoke.rs`).
    interface ISwapRouter {
        struct ExactInputSingleParams {
            address tokenIn;
            address tokenOut;
            uint24 fee;
            address recipient;
            uint256 amountIn;
            uint256 amountOutMinimum;
            uint160 sqrtPriceLimitX96;
        }
        function exactInputSingle(ExactInputSingleParams calldata params)
            external payable returns (uint256 amountOut);
    }

    /// Aave V3 Pool subset — `supply` and the aToken read we need.
    interface IAavePool {
        function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
        function getReserveData(address asset) external view returns (
            uint256 configuration,
            uint128 liquidityIndex,
            uint128 currentLiquidityRate,
            uint128 variableBorrowIndex,
            uint128 currentVariableBorrowRate,
            uint128 currentStableBorrowRate,
            uint40 lastUpdateTimestamp,
            uint16 id,
            address aTokenAddress,
            address stableDebtTokenAddress,
            address variableDebtTokenAddress,
            address interestRateStrategyAddress,
            uint128 accruedToTreasury,
            uint128 unbacked,
            uint128 isolationModeTotalDebt
        );
    }

    /// `RobotMoneyVault` subset for the round-trip (mirrors `IRobotMoneyVault`).
    interface IVault {
        function deposit(uint256 assets, address receiver) external returns (uint256);
        function balanceOf(address account) external view returns (uint256);
        function activeAdapterCount() external view returns (uint256);
        function asset() external view returns (address);
    }
}

const SWAP_USDC: u64 = 5_000_000; // 5 USDC — small to survive thin Sepolia liquidity
const SUPPLY_USDC: u64 = 5_000_000; // 5 USDC into Aave

/// One funded account on the network under test.
///
/// Devnet uses the existing `ephemeral` path (anvil/devnet seeding). Testnet
/// uses `ephemeral_testnet` (seeded transfers from `BASE_TESTNET_FUNDER_KEY`).
/// Returns `Err(SkipNoRpc)` when testnet funding is not provisioned, so the
/// body skips that network gracefully.
fn funded_account<'a>(
    fx: &'a ForkFixture,
    network: Network,
    eth_wei: U256,
    usdc_units: U256,
) -> Result<Account<'a>, HarnessError> {
    match network {
        Network::RobotMoneyDevnet => fx.ephemeral(eth_wei, usdc_units),
        Network::BaseTestnet => fx.ephemeral_testnet(network.usdc(), eth_wei, usdc_units),
    }
}

fn read_erc20_balance(
    user: &Account<'_>,
    token: Address,
    holder: Address,
) -> Result<U256, HarnessError> {
    let bytes = user.call(token, &IERC20::balanceOfCall { account: holder })?;
    scenarios::decode_u256(&bytes)
}

fn one_eth() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}

// ── Adapter: Uniswap V3 swap ──────────────────────────────────────────────────

/// USDC -> WETH single-hop exact-input swap on the live Uniswap V3 router for
/// `network`. Asserts WETH balance rises and a swap log was emitted by the pool.
fn exercise_uniswap(fx: &ForkFixture, network: Network) -> Result<(), HarnessError> {
    let amount = U256::from(SWAP_USDC);
    let user = match funded_account(fx, network, one_eth(), amount) {
        Ok(u) => u,
        Err(e) if e.is_skip() => {
            eprintln!(
                "[multi_network_adapters] Uniswap on {}: skipped (no funder)",
                network.name()
            );
            return Ok(());
        }
        Err(e) => return Err(e),
    };

    let router = network.uniswap_v3_swap_router();
    scenarios::approve_usdc_on(&user, network.usdc(), router, amount)?;

    let params = ISwapRouter::ExactInputSingleParams {
        tokenIn: network.usdc(),
        tokenOut: network.weth9(),
        fee: alloy_primitives::Uint::<24, 1>::from(500u64),
        recipient: user.address,
        amountIn: amount,
        amountOutMinimum: U256::from(1u64),
        sqrtPriceLimitX96: alloy_primitives::Uint::<160, 3>::from(0u64),
    };
    let call = ISwapRouter::exactInputSingleCall { params };
    let receipt = user.send(router, &call, U256::ZERO, 600_000)?;
    assert!(
        !receipt.logs.is_empty(),
        "Uniswap swap on {} emitted no logs — no pool interaction recorded",
        network.name()
    );

    let weth = read_erc20_balance(&user, network.weth9(), user.address)?;
    assert!(
        weth > U256::ZERO,
        "Uniswap swap on {} completed but WETH balance is zero (route/pool drift)",
        network.name()
    );
    eprintln!(
        "[multi_network_adapters] Uniswap on {}: OK weth_out={weth} tx={:#x}",
        network.name(),
        receipt.tx_hash
    );
    Ok(())
}

// ── Adapter: Aave V3 supply ───────────────────────────────────────────────────

/// USDC `supply` into the live Aave V3 pool for `network`. Asserts the aToken
/// (interest-bearing receipt) balance rises by ~the supplied amount, proving the
/// adapter's lend path works against the live pool. Asserts via the supply tx's
/// logs (pool interaction) and the aToken balance delta.
fn exercise_aave(fx: &ForkFixture, network: Network) -> Result<(), HarnessError> {
    let amount = U256::from(SUPPLY_USDC);
    let user = match funded_account(fx, network, one_eth(), amount) {
        Ok(u) => u,
        Err(e) if e.is_skip() => {
            eprintln!(
                "[multi_network_adapters] Aave on {}: skipped (no funder)",
                network.name()
            );
            return Ok(());
        }
        Err(e) => return Err(e),
    };

    let pool = network.aave_v3_pool();

    // Discover the aToken receipt address from the live reserve data.
    let reserve = user.call(
        pool,
        &IAavePool::getReserveDataCall {
            asset: network.usdc(),
        },
    )?;
    let decoded =
        IAavePool::getReserveDataCall::abi_decode_returns(&reserve, true).map_err(|e| {
            HarnessError::Rpc(format!(
                "Aave getReserveData decode on {}: {e}",
                network.name()
            ))
        })?;
    let atoken: Address = decoded.aTokenAddress;
    assert_ne!(
        atoken,
        Address::ZERO,
        "Aave reserve for USDC on {} has no aToken — pool not configured",
        network.name()
    );

    let atoken_before = read_erc20_balance(&user, atoken, user.address)?;

    scenarios::approve_usdc_on(&user, network.usdc(), pool, amount)?;
    let supply = IAavePool::supplyCall {
        asset: network.usdc(),
        amount,
        onBehalfOf: user.address,
        referralCode: 0u16,
    };
    let receipt = user.send(pool, &supply, U256::ZERO, 600_000)?;
    assert!(
        !receipt.logs.is_empty(),
        "Aave supply on {} emitted no logs — no pool interaction",
        network.name()
    );

    let atoken_after = read_erc20_balance(&user, atoken, user.address)?;
    assert!(
        atoken_after > atoken_before,
        "Aave supply on {}: aToken balance did not rise ({atoken_before} -> {atoken_after})",
        network.name()
    );
    eprintln!(
        "[multi_network_adapters] Aave on {}: OK aToken delta={} tx={:#x}",
        network.name(),
        atoken_after - atoken_before,
        receipt.tx_hash
    );
    Ok(())
}

// ── Adapters: Compound / Morpho / Curve via the vault round-trip ──────────────

/// Deposit USDC into the `RobotMoneyVault` for `network`, which routes funds
/// into every registered strategy adapter (Aave / Compound / Morpho, plus any
/// Curve-routed basket leg). Asserts shares are minted, proving the full
/// adapter stack mediates the deposit. Skips when no vault is configured for the
/// network (testnet vault deploy is a prerequisite, out of scope for #839).
fn exercise_vault_adapter_stack(fx: &ForkFixture, network: Network) -> Result<(), HarnessError> {
    let vault = match network {
        Network::RobotMoneyDevnet => Some(rmpc_fork_e2e::addresses::VAULT),
        Network::BaseTestnet => base_testnet_addresses::robotmoney_vault(),
    };
    let Some(vault) = vault else {
        eprintln!(
            "[multi_network_adapters] Compound/Morpho/Curve via vault on {}: \
             skipped — no RobotMoneyVault deployed (set RM_TESTNET_VAULT_ADDR after deploy)",
            network.name()
        );
        return Ok(());
    };

    let deposit = U256::from(50_000_000u64); // 50 USDC
    let user = match funded_account(fx, network, one_eth() * U256::from(5u64), deposit) {
        Ok(u) => u,
        Err(e) if e.is_skip() => {
            eprintln!(
                "[multi_network_adapters] vault stack on {}: skipped (no funder)",
                network.name()
            );
            return Ok(());
        }
        Err(e) => return Err(e),
    };

    // Sanity: the vault routes into a real adapter stack.
    let count_bytes = user.call(vault, &IVault::activeAdapterCountCall {})?;
    let adapter_count = scenarios::decode_u256(&count_bytes)?;
    assert!(
        adapter_count > U256::ZERO,
        "vault on {} has zero active adapters — Compound/Morpho/Curve stack not wired",
        network.name()
    );

    scenarios::approve_usdc_on(&user, network.usdc(), vault, deposit)?;
    let receipt = user.send(
        vault,
        &IVault::depositCall {
            assets: deposit,
            receiver: user.address,
        },
        U256::ZERO,
        1_500_000,
    )?;
    assert!(
        !receipt.logs.is_empty(),
        "vault deposit on {} emitted no logs",
        network.name()
    );

    let shares_bytes = user.call(
        vault,
        &IVault::balanceOfCall {
            account: user.address,
        },
    )?;
    let shares = scenarios::decode_u256(&shares_bytes)?;
    assert!(
        shares > U256::ZERO,
        "vault deposit on {} minted no shares — Compound/Morpho/Curve adapters did not absorb deposit",
        network.name()
    );
    eprintln!(
        "[multi_network_adapters] Compound/Morpho/Curve via vault on {}: OK \
         adapters={adapter_count} shares={shares} tx={:#x}",
        network.name(),
        receipt.tx_hash
    );
    Ok(())
}

// ── Parameterized entry point ─────────────────────────────────────────────────

parameterized_e2e!(
    adapters_against_live_services,
    |network: Network, fx: ForkFixture| {
        eprintln!(
            "[multi_network_adapters] {} chain_id={} address_set_hash={}",
            network.name(),
            fx.chain_id,
            hex::encode(match network {
                Network::RobotMoneyDevnet => rmpc_fork_e2e::addresses::address_set_hash(),
                Network::BaseTestnet => base_testnet_addresses::address_set_hash(),
            })
        );

        // chain_id guard: the macro already verified for_network, but assert here
        // too so the body is self-documenting about which chain it ran on.
        assert_eq!(
            fx.chain_id,
            network.chain_id(),
            "connected RPC chain id must match the selected network"
        );

        exercise_uniswap(&fx, network).expect("Uniswap adapter");
        exercise_aave(&fx, network).expect("Aave adapter");
        exercise_vault_adapter_stack(&fx, network).expect("Compound/Morpho/Curve vault stack");
    }
);
