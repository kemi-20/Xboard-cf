import test from "node:test";
import assert from "node:assert/strict";
import { analyticsData, __test } from "../src/analytics.ts";

test("analytics queries remain fixed templates with bounded input", () => {
  const query = __test.queryFor("user-rank", { start: -1, end: 999999999999, limit: 9999 });
  assert.match(query, /FROM xboard_user_traffic/);
  assert.match(query, /LIMIT 100$/);
  assert.doesNotMatch(query, /DROP TABLE/);
});

test("analytics ranking values preserve the original numeric response", () => {
  assert.deepEqual(__test.normalize("user-rank", [{ entity: "user:7", u: "10", d: "20", total: "30" }]), [
    { user_id: 7, u: 10, d: 20, total: 30, previous_total: 0 }
  ]);
});

test("runtime load keeps chart samples in chronological order", () => {
  const query = __test.queryFor("runtime-load", { entity_id: 3, start: 100, end: 1000, limit: 60 });
  assert.match(query, /GROUP BY recorded_at/);
  assert.match(query, /ORDER BY recorded_at DESC LIMIT 60$/);
  assert.deepEqual(__test.normalize("runtime-load", [
    { recorded_at: "900", cpu: "20" },
    { recorded_at: "600", cpu: "10" }
  ]), [
    { recorded_at: 600, cpu: 10 },
    { recorded_at: 900, cpu: 20 }
  ]);
});

test("missing analytics secret silently returns null for D1 fallback", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("unexpected fetch"); };
  try {
    assert.equal(await analyticsData({ CLOUDFLARE_ACCOUNT_ID: "account" }, "/internal/traffic/rank", { start: 1, end: 2 }), null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analytics HTTP and response failures silently return null", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 403, 429, 500]) {
      globalThis.fetch = async () => new Response("unavailable", { status });
      assert.equal(await analyticsData({ CLOUDFLARE_ACCOUNT_ID: "account", ANALYTICS_API_TOKEN: "test" }, "/internal/runtime/status", { start: status, end: status + 1 }), null);
    }

    globalThis.fetch = async () => Response.json({ data: { invalid: true } });
    assert.equal(await analyticsData({ CLOUDFLARE_ACCOUNT_ID: "account", ANALYTICS_API_TOKEN: "test" }, "/internal/runtime/status", { start: 30, end: 40 }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analytics timeout returns null instead of delaying the fallback indefinitely", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const started = Date.now();
    assert.equal(await analyticsData({ CLOUDFLARE_ACCOUNT_ID: "account", ANALYTICS_API_TOKEN: "test" }, "/internal/runtime/status", { start: 70, end: 80 }), null);
    assert.ok(Date.now() - started >= 1400);
    assert.ok(Date.now() - started < 3000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cache API failure does not block a successful analytics query", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  try {
    globalThis.caches = { default: { match: async () => { throw new Error("cache read failed"); }, put: async () => { throw new Error("cache write failed"); } } };
    globalThis.fetch = async () => Response.json({ data: [{ entity: "user:11", u: "1", d: "2", total: "3" }] });
    assert.deepEqual(await analyticsData({ CLOUDFLARE_ACCOUNT_ID: "account", ANALYTICS_API_TOKEN: "test" }, "/internal/traffic/rank", { start: 90, end: 100 }), [
      { user_id: 11, u: 1, d: 2, total: 3, previous_total: 0 }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("analytics success returns normalized rows without exposing the token", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.headers.authorization, "Bearer test-token");
      return Response.json({ data: [{ entity: "user:9", u: "4", d: "5", total: "9" }] });
    };
    assert.deepEqual(await analyticsData({ CLOUDFLARE_ACCOUNT_ID: "account", ANALYTICS_API_TOKEN: "test-token" }, "/internal/traffic/rank", { start: 50, end: 60 }), [
      { user_id: 9, u: 4, d: 5, total: 9, previous_total: 0 }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
