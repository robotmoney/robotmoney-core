// Integration tests for CORS behaviour (issue #166).
//
// Acceptance criteria:
//   1. EXPLORER_API_ALLOW_ORIGINS env var configures the allowed origins list.
//   2. Access-Control-Allow-Origin is present on all /v1/ responses for allowed origins.
//   3. Only GET method is advertised in Access-Control-Allow-Methods.
//   4. Preflight OPTIONS request returns correct CORS headers.
//
// These tests build a CorsLayer directly (mirroring the logic in main.rs) and
// pass it to `start_with_seed_and_cors` so no real process or env var is
// required.

mod common;

use axum::http::{HeaderValue, Method};
use tower_http::cors::{AllowOrigin, CorsLayer};

use common::start_with_seed_and_cors;

const ALLOWED_ORIGIN: &str = "http://localhost:5173";
const OTHER_ORIGIN: &str = "http://evil.example.com";

fn cors_layer_for_test() -> CorsLayer {
    let origin: HeaderValue = ALLOWED_ORIGIN.parse().unwrap();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list([origin]))
        .allow_methods([Method::GET])
        .allow_headers(tower_http::cors::Any)
}

// --- Preflight (OPTIONS) ---

#[tokio::test]
async fn preflight_returns_correct_cors_headers() {
    let s = start_with_seed_and_cors(Some(cors_layer_for_test())).await;
    let client = reqwest::Client::builder().build().unwrap();

    let resp = client
        .request(
            reqwest::Method::OPTIONS,
            format!("http://{}/v1/vault/snapshot/latest", s.addr),
        )
        .header("Origin", ALLOWED_ORIGIN)
        .header("Access-Control-Request-Method", "GET")
        .header("Access-Control-Request-Headers", "content-type")
        .send()
        .await
        .unwrap();

    // Tower's CorsLayer responds to a valid preflight with 200.
    assert!(
        resp.status().is_success(),
        "preflight should succeed, got {}",
        resp.status()
    );

    let acao = resp
        .headers()
        .get("access-control-allow-origin")
        .expect("Access-Control-Allow-Origin header must be present on preflight");
    assert_eq!(
        acao, ALLOWED_ORIGIN,
        "Access-Control-Allow-Origin must echo the allowed origin"
    );

    let acam = resp
        .headers()
        .get("access-control-allow-methods")
        .expect("Access-Control-Allow-Methods must be present on preflight");
    let methods = acam.to_str().unwrap().to_uppercase();
    assert!(
        methods.contains("GET"),
        "GET must be advertised in Access-Control-Allow-Methods, got: {methods}"
    );
    // POST must NOT be advertised — the API is read-only.
    assert!(
        !methods.contains("POST"),
        "POST must not be advertised in Access-Control-Allow-Methods, got: {methods}"
    );
}

// --- Simple GET from allowed origin ---

#[tokio::test]
async fn get_from_allowed_origin_returns_acao_header() {
    let s = start_with_seed_and_cors(Some(cors_layer_for_test())).await;
    let client = reqwest::Client::builder().build().unwrap();

    let resp = client
        .get(format!("http://{}/health", s.addr))
        .header("Origin", ALLOWED_ORIGIN)
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let acao = resp
        .headers()
        .get("access-control-allow-origin")
        .expect("Access-Control-Allow-Origin must be present for allowed origin");
    assert_eq!(acao, ALLOWED_ORIGIN);
}

// --- Request from a disallowed origin must NOT get ACAO header ---

#[tokio::test]
async fn get_from_disallowed_origin_does_not_return_acao_header() {
    let s = start_with_seed_and_cors(Some(cors_layer_for_test())).await;
    let client = reqwest::Client::builder().build().unwrap();

    let resp = client
        .get(format!("http://{}/health", s.addr))
        .header("Origin", OTHER_ORIGIN)
        .send()
        .await
        .unwrap();

    // The server returns the data (it's public read-only), but the browser
    // will block it because ACAO is absent.
    assert_eq!(resp.status(), 200);
    assert!(
        resp.headers().get("access-control-allow-origin").is_none(),
        "Access-Control-Allow-Origin must not be present for disallowed origin"
    );
}

// --- /v1/ endpoints all carry the header ---

#[tokio::test]
async fn v1_endpoints_carry_acao_header() {
    let s = start_with_seed_and_cors(Some(cors_layer_for_test())).await;
    let client = reqwest::Client::builder().build().unwrap();

    let urls = [
        format!("http://{}/v1/chains/8453/contracts", s.addr),
        format!("http://{}/v1/vault/snapshot/latest", s.addr),
        format!(
            "http://{}/v1/agents/0x3333333333333333333333333333333333333333",
            s.addr
        ),
    ];

    for url in &urls {
        let resp = client
            .get(url)
            .header("Origin", ALLOWED_ORIGIN)
            .send()
            .await
            .unwrap();
        let acao = resp.headers().get("access-control-allow-origin");
        assert!(
            acao.is_some(),
            "Access-Control-Allow-Origin must be present on {url}"
        );
        assert_eq!(acao.unwrap(), ALLOWED_ORIGIN, "wrong origin on {url}");
    }
}
