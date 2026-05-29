//! Canonical: docs/prd.md#112-protocol-asset-vault (issue #482).
//!
//! Fork integration test — primary verification path for the landing-page
//! live DEX price strip. Reads each of the four Uniswap V3 pools' `slot0`
//! directly from the running forked-Base devnet (no RPC mock, no off-chain
//! price source) and converts `sqrtPriceX96` to a human mid price with the
//! same decimals-aware math the dapp uses (clients/dapp/src/lib/uniswapV3.ts).
//!
//! The converted prices are compared against the pinned expected-prices
//! fixture at `testing/ethereum-testnet/config/expected-prices.json` within
//! the fixture's `tolerance_pct`. The fixture's `fork_block` is pinned to the
//! fork-block manifest by the CI guard `fork_block_aligns_with_expected_prices`
//! in `testing/smoke-test/src/fork_manifest.rs`.
//!
//! Posture while `captured == false`: the fixture has no archive-pinned
//! magnitudes yet, so this test asserts every pool EXISTS at the fork block
//! and returns a positive `sqrtPriceX96` (the cbBTC and wSOL pools are the
//! smaller pools most likely to be missing if the fork manifest drifts) and
//! prints the live converted price for capture. Once real values are pinned
//! (`captured == true`) it additionally asserts each price is within
//! `tolerance_pct` of `expected_price`.

use alloy_primitives::{Address, U256};
use alloy_sol_types::{sol, SolCall};
use rmpc_fork_e2e::{skip_if_no_mainnet_fork, ForkFixture};

sol! {
    /// The single field we read off a Uniswap V3 pool.
    interface IUniswapV3PoolSlot0 {
        function slot0() external view returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    }
}

/// One expected-prices fixture entry.
struct PairFixture {
    id: String,
    pool: Address,
    base_decimals: i32,
    quote_decimals: i32,
    base_is_token0: bool,
    expected_price: Option<f64>,
}

struct Fixture {
    fork_block: u64,
    tolerance_pct: f64,
    captured: bool,
    pairs: Vec<PairFixture>,
}

fn load_fixture() -> Fixture {
    let repo = test_utils::find_workspace_root().expect("locate repo root");
    let raw =
        std::fs::read_to_string(repo.join("testing/ethereum-testnet/config/expected-prices.json"))
            .expect("expected-prices.json readable");
    let v: serde_json::Value = serde_json::from_str(&raw).expect("expected-prices.json parses");

    let pairs = v["pairs"]
        .as_array()
        .expect("pairs array")
        .iter()
        .map(|p| PairFixture {
            id: p["id"].as_str().expect("id").to_string(),
            pool: p["pool"]
                .as_str()
                .expect("pool")
                .parse()
                .expect("pool addr"),
            base_decimals: p["base_decimals"].as_i64().expect("base_decimals") as i32,
            quote_decimals: p["quote_decimals"].as_i64().expect("quote_decimals") as i32,
            base_is_token0: p["base_is_token0"].as_bool().expect("base_is_token0"),
            expected_price: p["expected_price"].as_f64(),
        })
        .collect();

    Fixture {
        fork_block: v["fork_block"].as_u64().expect("fork_block"),
        tolerance_pct: v["tolerance_pct"].as_f64().expect("tolerance_pct"),
        captured: v["captured"].as_bool().unwrap_or(false),
        pairs,
    }
}

/// Decimals-aware sqrtPriceX96 -> human price. Mirrors
/// `sqrtPriceX96ToPrice` in clients/dapp/src/lib/uniswapV3.ts so the producer
/// (fork) and the dapp share one conversion.
fn sqrt_price_x96_to_price(
    sqrt_price_x96: U256,
    token0_decimals: i32,
    token1_decimals: i32,
    base_is_token0: bool,
) -> f64 {
    assert!(sqrt_price_x96 > U256::ZERO, "sqrtPriceX96 must be positive");
    // rawRatio = sqrtPriceX96^2 / 2^192 (token1 per token0, raw units).
    // Keep precision as f64 after dividing into manageable magnitude.
    let q96 = 2f64.powi(96);
    let sp = u256_to_f64(sqrt_price_x96) / q96;
    let raw_ratio = sp * sp; // token1/token0, raw
    let decimal_delta = token0_decimals - token1_decimals;
    let t1_per_t0 = raw_ratio * 10f64.powi(decimal_delta);
    if base_is_token0 {
        t1_per_t0
    } else {
        1.0 / t1_per_t0
    }
}

fn u256_to_f64(v: U256) -> f64 {
    // sqrtPriceX96 fits in 160 bits; f64 has enough range. Convert via decimal
    // string to avoid intermediate overflow.
    v.to_string().parse::<f64>().expect("u256 -> f64")
}

#[test]
fn landing_price_strip_matches_base_mainnet_at_fork_block() {
    skip_if_no_mainnet_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[landing_price_strip_fork] {}", fx.summary_line());

    let fixture = load_fixture();

    // The devnet must be at (or after) the pinned fork block.
    let block = fx.rpc().block_number().expect("block number");
    assert!(
        block >= fixture.fork_block,
        "devnet block {block} is before pinned fork block {}",
        fixture.fork_block
    );

    // Read-only caller address (no value transfer in eth_call).
    let caller: Address = "0x0000000000000000000000000000000000000001"
        .parse()
        .unwrap();

    for pair in &fixture.pairs {
        let call = IUniswapV3PoolSlot0::slot0Call {};
        let ret = fx
            .rpc()
            .eth_call(caller, pair.pool, call.abi_encode().into())
            .unwrap_or_else(|e| panic!("slot0 read failed for {} ({}): {e}", pair.id, pair.pool));
        let decoded = IUniswapV3PoolSlot0::slot0Call::abi_decode_returns(&ret, true)
            .unwrap_or_else(|e| panic!("slot0 decode failed for {}: {e}", pair.id));

        let sqrt_price = U256::from(decoded.sqrtPriceX96);
        assert!(
            sqrt_price > U256::ZERO,
            "pool {} ({}) returned zero sqrtPriceX96 — pool missing or uninitialized at fork block",
            pair.id,
            pair.pool
        );

        let price = sqrt_price_x96_to_price(
            sqrt_price,
            pair.base_decimals,
            pair.quote_decimals,
            pair.base_is_token0,
        );
        eprintln!(
            "[landing_price_strip_fork] {} = {price} (pool {})",
            pair.id, pair.pool
        );

        if fixture.captured {
            let expected = pair.expected_price.unwrap_or_else(|| {
                panic!("captured fixture missing expected_price for {}", pair.id)
            });
            let drift_pct = ((price - expected) / expected).abs() * 100.0;
            assert!(
                drift_pct <= fixture.tolerance_pct,
                "{} price {price} drifted {drift_pct:.4}% from expected {expected} \
                 (tolerance {}%)",
                pair.id,
                fixture.tolerance_pct
            );
        }
    }
}

#[test]
fn landing_price_strip_cbbtc_and_wsol_pools_exist_at_fork_block() {
    skip_if_no_mainnet_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let fixture = load_fixture();
    let caller: Address = "0x0000000000000000000000000000000000000001"
        .parse()
        .unwrap();

    // cbBTC and wSOL are the smaller pools most likely to be absent if the
    // fork manifest drifts; assert both return a positive sqrtPriceX96.
    for id in ["cbbtc-usdc", "wsol-usdc"] {
        let pair = fixture
            .pairs
            .iter()
            .find(|p| p.id == id)
            .unwrap_or_else(|| panic!("fixture missing pair {id}"));
        let call = IUniswapV3PoolSlot0::slot0Call {};
        let ret = fx
            .rpc()
            .eth_call(caller, pair.pool, call.abi_encode().into())
            .unwrap_or_else(|e| panic!("slot0 read failed for {id} ({}): {e}", pair.pool));
        let decoded = IUniswapV3PoolSlot0::slot0Call::abi_decode_returns(&ret, true)
            .unwrap_or_else(|e| panic!("slot0 decode failed for {id}: {e}"));
        assert!(
            U256::from(decoded.sqrtPriceX96) > U256::ZERO,
            "{id} pool {} has no liquidity at fork block — manifest drift?",
            pair.pool
        );
    }
}
