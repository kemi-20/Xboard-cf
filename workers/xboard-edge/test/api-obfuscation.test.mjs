import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { decodeObfuscatedApiRequest, decorateObfuscatedApiResponse } from "../src/api-obfuscation.ts";

function encoded(value) {
  return Buffer.from(value).toString("base64url");
}

function route(path, init, now = 1_800_000_000) {
  return decodeObfuscatedApiRequest(new Request(`https://edge.example${path}`, init), now);
}

test("obfuscated API routes decode into the existing v1 router", async () => {
  const timestamp = encoded("1800000000");
  const apiPath = encoded("passport/auth/login");
  const result = route(`/${timestamp}/${apiPath}/session?source=client`, {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: '{"email":"user@example.com"}'
  });
  assert.ok(!(result instanceof Response) && result);
  assert.equal(new URL(result.request.url).pathname, "/api/v1/passport/auth/login/session");
  assert.equal(new URL(result.request.url).search, "?source=client");
  assert.equal(result.request.headers.get("authorization"), "Bearer test");
  assert.equal(await result.request.text(), '{"email":"user@example.com"}');
  assert.equal(result.originalPath, "/api/v1/passport/auth/login/session");
  assert.equal(result.parameterMode, "append");
});

test("an encoded query takes precedence over the outer query like the original module", () => {
  const result = route(`/${encoded("1800000000")}/${encoded("client/subscribe?token=inside")}?token=outside`);
  assert.ok(!(result instanceof Response) && result);
  const url = new URL(result.request.url);
  assert.equal(url.pathname, "/api/v1/client/subscribe");
  assert.equal(url.search, "?token=inside");
  assert.equal(result.parameterMode, "skip");
});

test("obfuscated routing rejects stale timestamps and path traversal", async () => {
  const stale = route(`/${encoded("1799999000")}/${encoded("client/subscribe")}`);
  assert.ok(stale instanceof Response);
  assert.equal(stale.status, 401);

  const traversal = route(`/${encoded("1800000000")}/${encoded("../../api/v2/admin/config/fetch")}`);
  assert.ok(traversal instanceof Response);
  assert.equal(traversal.status, 400);
  assert.deepEqual(await traversal.json(), { error: "Invalid API path" });

  const encodedTraversal = route(`/${encoded("1800000000")}/${encoded("%2e%2e/%2e%2e/api/v2/admin/config/fetch")}`);
  assert.ok(encodedTraversal instanceof Response);
  assert.equal(encodedTraversal.status, 400);
});

test("unrelated routes stay untouched and obfuscated preflights remain available", () => {
  assert.equal(route("/assets/index.js"), null);
  assert.equal(route("/s/subscription-token"), null);
  assert.equal(route("/s/subscription-token", { method: "OPTIONS" }), null);
  const preflight = route(`/${encoded("1800000000")}/${encoded("passport/auth/login")}`, { method: "OPTIONS" });
  assert.ok(preflight instanceof Response);
  assert.equal(preflight.status, 204);
});

test("obfuscated responses preserve business headers and add proxy metadata", () => {
  const routeInfo = route(`/${encoded("1800000000")}/${encoded("client/subscribe")}`);
  assert.ok(!(routeInfo instanceof Response) && routeInfo);
  const response = decorateObfuscatedApiResponse(new Response("ok", { headers: { etag: '"value"' } }), routeInfo);
  assert.equal(response.headers.get("etag"), '"value"');
  assert.equal(response.headers.get("x-original-path"), "/api/v1/client/subscribe");
  assert.equal(response.headers.get("x-proxy-server"), "xboard-edge");
  assert.equal(response.headers.get("x-param-handler"), "append");
});

test("Edge routes obfuscated paths before API dispatch without changing existing handlers", () => {
  const edge = fs.readFileSync("src/index.ts", "utf8");
  const wrangler = fs.readFileSync("wrangler.toml", "utf8");
  assert.match(edge, /const decodedRoute = decodeObfuscatedApiRequest\(request\)/);
  assert.match(edge, /if \(obfuscatedRoute\) request = obfuscatedRoute\.request/);
  assert.match(edge, /decorateObfuscatedApiResponse\(response, obfuscatedRoute\)/);
  assert.match(wrangler, /run_worker_first = \[[^\n]*"\/\*\/\*"/);
});
