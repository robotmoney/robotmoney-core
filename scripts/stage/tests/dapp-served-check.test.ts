// Core issue 1731: the served /config.json check is a JSON parse, and the bundle class check is the real one.
import { describe, expect, test } from "bun:test";
import { bundleEnvClass, classifyServedConfig, httpFailure, judgeServed } from "../dapp-served-check.ts";

const SPA = '<!doctype html><html><head><title>Robot Money</title></head><body><div id="root"></div><script src="/assets/index-abc.js"></script></body></html>';

describe("classifyServedConfig", () => {
  test("the single page app fallback (index.html, HTTP 200) is not-served, not clean", () => {
    const r = classifyServedConfig(SPA, "text/html");
    expect(r.kind).toBe("not-served");
  });
  test("a JSON object without VITE_ENV_CLASS is clean and lists its keys", () => {
    expect(classifyServedConfig('{"VITE_EXPLORER_API_URL":"https://x"}', "application/json")).toEqual({ kind: "json-clean", keys: ["VITE_EXPLORER_API_URL"] });
  });
  test("a JSON object with VITE_ENV_CLASS fails the check, whatever its value", () => {
    expect(classifyServedConfig('{"VITE_ENV_CLASS":"fork"}', "application/json").kind).toBe("json-has-env-class");
  });
  test("a key that merely contains the text is not the key", () => {
    expect(classifyServedConfig('{"note":"VITE_ENV_CLASS is build time"}', "application/json").kind).toBe("json-clean");
  });
  test("JSON that is not an object is refused", () => {
    expect(classifyServedConfig("[1]", "application/json").kind).toBe("json-not-an-object");
    expect(classifyServedConfig("null", "application/json").kind).toBe("json-not-an-object");
  });
  test("non JSON, non HTML text is not-served too", () => {
    expect(classifyServedConfig("oops", "text/plain").kind).toBe("not-served");
  });
});

describe("bundleEnvClass", () => {
  test("reads the minified baked class", () => {
    expect(bundleEnvClass('x={VITE_ENV_CLASS:"mainnet",VITE_CHAIN_ID:"8453"}')).toBe("mainnet");
    expect(bundleEnvClass('VITE_ENV_CLASS:"fork"')).toBe("fork");
  });
  test("returns undefined when the bundle names none", () => {
    expect(bundleEnvClass("console.log(1)")).toBeUndefined();
  });
});

describe("judgeServed", () => {
  const bundle = 'a={VITE_ENV_CLASS:"mainnet"}';
  test("SPA fallback passes the config check but says the pass is trivial, and the bundle check decides", () => {
    const [cfg, cls] = judgeServed({ configBody: SPA, configContentType: "text/html", bundleText: bundle, expectedClass: "mainnet" });
    expect(cfg!.ok).toBe(true);
    expect(cfg!.detail).toContain("trivial");
    expect(cls!).toMatchObject({ name: "bundle class", ok: true });
  });
  test("a fork-class bundle fails even when the served config looks clean", () => {
    const [, cls] = judgeServed({ configBody: "{}", configContentType: "application/json", bundleText: 'a={VITE_ENV_CLASS:"fork"}', expectedClass: "mainnet" });
    expect(cls!.ok).toBe(false);
  });
  test("a bundle with no class fails", () => {
    const [, cls] = judgeServed({ configBody: "{}", configContentType: "application/json", bundleText: "x", expectedClass: "mainnet" });
    expect(cls!.ok).toBe(false);
  });
  test("a served document carrying VITE_ENV_CLASS fails", () => {
    const [cfg] = judgeServed({ configBody: '{"VITE_ENV_CLASS":"mainnet"}', configContentType: "application/json", bundleText: bundle, expectedClass: "mainnet" });
    expect(cfg!.ok).toBe(false);
  });
});

describe("httpFailure", () => {
  test("2xx is no failure", () => {
    expect(httpFailure("x", { status: 200 })).toBeNull();
    expect(httpFailure("x", { status: 204 })).toBeNull();
  });
  test("a non-2xx is a named failure", () => {
    for (const status of [301, 403, 404, 500, 502]) {
      const f = httpFailure("fetch /", { status });
      expect(f).toMatchObject({ name: "fetch /", ok: false });
      expect(f!.detail).toContain(`HTTP ${status}`);
    }
  });
  test("a request that failed outright is a named failure with the message", () => {
    const f = httpFailure("fetch /", { status: null, error: "connection refused" });
    expect(f).toMatchObject({ ok: false });
    expect(f!.detail).toContain("connection refused");
  });
  test("a 404 is allowed only where 'not served' is a valid answer (/config.json)", () => {
    expect(httpFailure("fetch /config.json", { status: 404 }, true)).toBeNull();
    expect(httpFailure("fetch /config.json", { status: 500 }, true)).not.toBeNull();
    expect(httpFailure("fetch /", { status: 404 })).not.toBeNull();
  });
});
