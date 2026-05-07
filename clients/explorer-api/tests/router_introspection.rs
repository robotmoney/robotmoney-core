// Build-time-style invariant: the router must not expose any non-GET
// methods anywhere except `/health` (which is also GET).
//
// This is a structural test. We don't have ergonomic introspection over
// `axum::Router` post-construction, so instead we walk the route table
// declared in `src/routes.rs` source code and assert that every `route(`
// call uses `get(...)` only. Any future addition of `post`, `put`,
// `delete`, or `patch` is forbidden by §11 ("the API does not sign,
// authorize, or write") and will fail this test.

#[test]
fn routes_are_get_only() {
    let src = include_str!("../src/routes.rs");
    // Collapse to lines that declare a route.
    for line in src.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with(".route(") {
            continue;
        }
        // Each route line must contain `get(` and must NOT contain any
        // mutating method.
        assert!(
            trimmed.contains("get("),
            "non-GET route declared: {trimmed}"
        );
        for forbidden in ["post(", "put(", "delete(", "patch("] {
            assert!(
                !trimmed.contains(forbidden),
                "forbidden method {forbidden} in route: {trimmed}"
            );
        }
    }
}
