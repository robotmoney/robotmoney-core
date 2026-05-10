/**
 * Playwright globalTeardown for the full-stack Geth+Lighthouse devnet.
 *
 * Called automatically by Playwright after all tests complete when
 * `globalTeardown` is set in playwright.config.ts. Kills the smoke-test
 * child process started by devnet-global-setup.ts, triggering the binary's
 * Drop teardown of both docker compose stacks (devnet chain + dapp stack).
 *
 * Canonical: docs/implementation-plan.md §10.5, issue #230.
 */

export { globalTeardown as default } from "./devnet-global-setup";
