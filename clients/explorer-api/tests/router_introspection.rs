// Build-time-style invariant: the router must not expose any non-GET
// methods anywhere except `/health` (which is also GET).
//
// This is a structural test. We don't have ergonomic introspection over
// `axum::Router` post-construction, so instead we walk the route table
// declared in `src/routes.rs` source code and assert that every `route(`
// call uses `get(...)` only. Any future addition of `post`, `put`,
// `delete`, or `patch` is forbidden by §11 ("the API does not sign,
// authorize, or write") and will fail this test.
//
// The implementation collapses each `.route(…)` block — which rustfmt
// may split across multiple lines — into a single whitespace-collapsed
// string before checking for the method token.

#[test]
fn routes_are_get_only() {
    let src = include_str!("../src/routes.rs");

    // Collapse all whitespace runs to a single space so multi-line route
    // declarations become a single searchable string.
    let collapsed: String = src.split_whitespace().collect::<Vec<_>>().join(" ");

    // Split on `.route(` to get each route invocation as a separate segment.
    // The first segment (before the first `.route(`) contains no route; skip it.
    let route_segments: Vec<&str> = collapsed.split(".route(").skip(1).collect();

    assert!(
        !route_segments.is_empty(),
        "routes.rs has no .route( calls — routing table is missing"
    );

    for segment in &route_segments {
        // Each segment starts immediately after `.route(` and runs to the
        // next `.route(` or end-of-string. We only need the first `)` close
        // to capture the handler argument, but inspecting the whole segment
        // up to the matching close paren is simpler and safe.
        // The forbidden-method check only needs to find the token anywhere
        // in the segment before the next route boundary.

        // Accept this route if `get(` appears before any forbidden method.
        assert!(
            segment.contains("get("),
            "non-GET route declared (no `get(` found): …route({segment}"
        );
        for forbidden in ["post(", "put(", "delete(", "patch("] {
            assert!(
                !segment.contains(forbidden),
                "forbidden method `{forbidden}` found in route: …route({segment}"
            );
        }
    }
}
