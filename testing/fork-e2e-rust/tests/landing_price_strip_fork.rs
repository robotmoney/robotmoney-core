//! Canonical: docs/prd.md#112-protocol-asset-vault (issue #482).
//!
//! Fork integration test — primary verification path for the landing-page
//! live DEX price strip. Reads each of the four Uniswap V3 pools' `slot0`
//! directly from the running forked-Base devnet (no RPC mock, no off-chain
//! price source) and converts `sqrtPriceX96` to a human mid price with the
//! same decimals-aware math the dapp uses (clients/dapp/src/lib/uniswapV3.ts).
//!
//! The converted prices are checked against the sanity band of each pair in
//! `testing/ethereum-testnet/config/price-strip-pairs.json`. The Twin chain is pinned at the
//! upstream head minus 2 at the start of each CI run, so there is no golden price: the band is
//! wide, and it still catches wrong decimals (a factor of 10^12), inverted pairs (the reciprocal)
//! and a missing pool.

use alloy_primitives::{Address, U256};
use alloy_sol_types::{sol, SolCall};
use rmpc_fork_e2e::{skip_if_no_devnet_fork, ForkFixture};

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

/// One price-strip pair.
struct PairFixture {
    id: String,
    pool: Address,
    base_decimals: i32,
    quote_decimals: i32,
    base_is_token0: bool,
    min_price: f64,
    max_price: f64,
}

struct Fixture {
    pairs: Vec<PairFixture>,
}

fn load_fixture() -> Fixture {
    let repo = test_utils::find_workspace_root().expect("locate repo root");
    let raw = std::fs::read_to_string(
        repo.join("testing/ethereum-testnet/config/price-strip-pairs.json"),
    )
    .expect("price-strip-pairs.json readable");
    let v: serde_json::Value = serde_json::from_str(&raw).expect("price-strip-pairs.json parses");

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
            min_price: p["min_price"].as_f64().expect("min_price"),
            max_price: p["max_price"].as_f64().expect("max_price"),
        })
        .collect();

    Fixture { pairs }
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
fn landing_price_strip_is_inside_the_sanity_band() {
    skip_if_no_devnet_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[landing_price_strip_fork] {}", fx.summary_line());

    let fixture = load_fixture();

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
            "pool {} ({}) returned zero sqrtPriceX96 — pool missing or uninitialized on the Twin chain",
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

        assert!(
            price >= pair.min_price && price <= pair.max_price,
            "{} price {price} is outside the band [{}, {}]: wrong decimals, an inverted pair \
             or a missing pool",
            pair.id,
            pair.min_price,
            pair.max_price
        );
    }
}

#[test]
fn landing_price_strip_cbbtc_pool_exists() {
    skip_if_no_devnet_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    let fixture = load_fixture();
    let caller: Address = "0x0000000000000000000000000000000000000001"
        .parse()
        .unwrap();

    // cbBTC is the smaller pool, most likely to be absent if the upstream state
    // drifts; assert it returns a positive sqrtPriceX96.
    let id = "cbbtc-usdc";
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
        "{id} pool {} has no liquidity on the Twin chain — pool address drift?",
        pair.pool
    );
}
