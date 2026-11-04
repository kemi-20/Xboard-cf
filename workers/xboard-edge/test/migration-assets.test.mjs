import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const start = source.indexOf("async function edgeFetch(");
const end = source.indexOf("\nfunction corsResponse(", start);
assert.ok(start >= 0 && end > start, "Edge request handler must exist");
const handler = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;

function isolatedRouter() {
  return vm.runInNewContext(`${handler}\nedgeFetch`, {
    URL,
    Request,
    Response,
    isNodeProtocolPath: () => false,
    ensureBootstrap() { throw new Error("Business routing reached"); },
    currentSubscribePath() { throw new Error("Static assets must not read settings"); },
    currentSecurePath() { throw new Error("Static assets must not read settings"); }
  });
}

test("migration assets reach ASSETS without bootstrap, D1, KV or subscription settings", async () => {
  const route = isolatedRouter();
  const files = fs.readdirSync(new URL("../public/migration/", import.meta.url));
  for (const name of files) {
    for (const method of ["GET", "HEAD"]) {
      const request = new Request(`https://panel.example/migration/${name}?v=1`, { method });
      const assetResponse = new Response(method === "HEAD" ? null : name);
      const response = await route(request, {
        ASSETS: { async fetch(input) {
          assert.equal(input, request, "Asset requests and cache headers must pass through unchanged");
          return assetResponse;
        } }
      }, {});
      assert.equal(response, assetResponse);
    }
  }
});

test("migration asset routing does not bypass the business router for API or unrelated paths", async () => {
  const route = isolatedRouter();
  for (const path of [
    "/api/v2/admin/migration/status", "/api/v2/admin/migration/export/manifest",
    "/api/v2/admin/migration/prepare", "/api/v1/user/order/fetch",
    "/admin/migration", "/custom-admin/migration/", "/migration-private/file.css"
  ]) {
    await assert.rejects(() => route(new Request(`https://panel.example${path}`), {}, {}), /Business routing reached/);
  }
});
