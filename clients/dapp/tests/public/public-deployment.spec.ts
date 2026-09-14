/**
 * Read-only browser check against a PUBLIC, CDN-fronted deployment
 * (QA finding R20).
 *
 * WHAT IT PROVES
 * The devnet suite serves the dapp straight from `vite preview` on loopback, so
 * it never sees what a Cloudflare-fronted deployment actually serves: the edge
 * injects its Web Analytics beacon into the HTML AFTER the origin's CSP header
 * is written, and the static host answers `/favicon.ico` with a 404. Both make
 * the browser log an error on every page load, which the e2e `_consoleGuard`
 * counts as a failure — so the console gate was structurally un-passable on any
 * real deployment and the gap was invisible to CI.
 *
 * This spec navigates, waits for the network to settle, and asserts a clean
 * console — the same bar `_consoleGuard` sets — plus a 200 on `/favicon.ico` and
 * a CSP that names the beacon origin. It is READ-ONLY: it connects no wallet,
 * signs nothing, and sends no transaction.
 *
 * It runs only when a URL is named, because it needs a deployment to point at:
 *   PUBLIC_DAPP_URL   e.g. https://stage-dapp.robotmoney-labs.dev
 *
 * It is deliberately NOT part of the devnet suite (`playwright.config.ts`,
 * testDir ./tests/e2e) — it has its own config with no devnet globalSetup:
 *   PUBLIC_DAPP_URL=https://stage-dapp.robotmoney-labs.dev \
 *     bunx playwright test -c playwright.public.config.ts
 * and for that reason it is NOT in REQUIRED_SPECS: a run with no URL named is a
 * legitimate no-op, unlike the AC-CORE-08 coverage that must never stop running.
 */
import { test, expect } from "../e2e/helpers/fixtures";
import { CLOUDFLARE_BEACON_SCRIPT_ORIGIN } from "../../src/lib/csp";

const DAPP_URL = process.env.PUBLIC_DAPP_URL ?? "";

test.describe("public deployment — console hygiene behind a CDN", () => {
  test.skip(
    !DAPP_URL,
    "PUBLIC_DAPP_URL must name the public deployment to check, e.g. " +
      "https://stage-dapp.robotmoney-labs.dev",
  );

  test("loads with a clean console, a served favicon and a beacon-admitting CSP", async ({
    page,
  }) => {
    // Recorded independently of _consoleGuard so a failure says WHICH resource
    // broke rather than only that the console was dirty.
    const blocked: string[] = [];
    page.on("requestfailed", (req) => {
      const failure = req.failure()?.errorText ?? "";
      blocked.push(`${req.url()} :: ${failure}`);
    });
    const notFound: string[] = [];
    page.on("response", (res) => {
      if (res.status() >= 400) notFound.push(`${res.status()} ${res.url()}`);
    });

    const response = await page.goto(DAPP_URL, { waitUntil: "networkidle", timeout: 60_000 });
    expect(response?.status()).toBe(200);

    // The app actually mounted — a blank page has a clean console too.
    await expect(page.getByTestId("nav")).toBeVisible({ timeout: 30_000 });

    // The served CSP must name the beacon origin. Read it from the real
    // response header, not from our own source: the point is what the edge
    // serves, and a header rewrite at the CDN would be invisible to a unit test.
    const csp = (response?.headers()["content-security-policy"] ?? "") as string;
    expect(csp, "no Content-Security-Policy response header").not.toBe("");
    expect(csp).toContain(CLOUDFLARE_BEACON_SCRIPT_ORIGIN);
    // The allowance must not have been bought with a relaxation.
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);

    // /favicon.ico must be served, not 404'd.
    const favicon = await page.request.get(new URL("/favicon.ico", DAPP_URL).toString());
    expect(favicon.status(), "/favicon.ico must be served by the deployment").toBe(200);

    // Give late beacon/RUM traffic a chance to be blocked before we judge.
    await page.waitForTimeout(5_000);

    expect(blocked, `blocked subresources:\n${blocked.join("\n")}`).toEqual([]);
    expect(notFound, `4xx/5xx responses:\n${notFound.join("\n")}`).toEqual([]);
    // _consoleGuard asserts the clean console after this body returns.
  });
});
