import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { internalSyncToken, invalidateInternalTokenCache } from "../src/internal/auth.ts";
import { clearStatus, statusSnapshot } from "../src/internal/status-client.ts";
import { nodeAvailableStatus, statusTimeout } from "../src/admin/servers.ts";
import { shouldNotifyNodeSync } from "../src/internal/sync-client.ts";

function settingsDatabase(initial) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    prepare(sql) {
      let params = [];
      return {
        bind(...input) { params = input; return this; },
        async all() {
          return { results: [...values.entries()].filter(([name]) => ["internal_sync_token", "server_token"].includes(name)).map(([name, value]) => ({ name, value })) };
        },
        async first() {
          return sql.includes("WHERE name = 'internal_sync_token'") ? { value: values.get("internal_sync_token") } : null;
        },
        async run() {
          if (sql.startsWith("UPDATE v2_settings") && values.get("internal_sync_token") === params[2]) values.set("internal_sync_token", params[0]);
          if (sql.startsWith("INSERT INTO v2_settings") && !values.has("internal_sync_token")) values.set("internal_sync_token", params[0]);
          return { success: true, meta: { changes: 1 } };
        }
      };
    }
  };
}

test("internal authentication rotates a legacy token that equals the public node token", async () => {
  invalidateInternalTokenCache();
  const db = settingsDatabase({ server_token: "public-node-token", internal_sync_token: "public-node-token" });
  const token = await internalSyncToken({ XBOARD_DB: db });
  assert.notEqual(token, "public-node-token");
  assert.equal(token, db.values.get("internal_sync_token"));
  assert.match(token, /^[a-f0-9]{64}$/);
});

test("Worker Secret is preferred without reading D1", async () => {
  invalidateInternalTokenCache();
  const token = await internalSyncToken({
    INTERNAL_SYNC_TOKEN: "worker-secret",
    XBOARD_DB: { prepare() { throw new Error("D1 should not be read"); } }
  });
  assert.equal(token, "worker-secret");
});

test("status snapshots retain the last successful value during a transient StatusHub failure", async () => {
  let snapshotRequests = 0;
  const env = {
    XBOARD_SERVER: {
      async fetch(request) {
        const path = new URL(typeof request === "string" ? request : request.url).pathname;
        if (path.endsWith("/clear")) return new Response("{}", { status: 200 });
        snapshotRequests += 1;
        if (snapshotRequests === 1) {
          return new Response(JSON.stringify({ data: { machines: { 1: { last_seen_at: 100 } }, nodes: {} } }), {
            headers: { "content-type": "application/json" }
          });
        }
        throw new Error("temporary service binding failure");
      }
    }
  };
  const loadToken = async () => "internal-token";
  const first = await statusSnapshot(env, loadToken);
  assert.equal(first.available, true);
  assert.equal(first.stale, false);
  assert.equal(first.machines["1"].last_seen_at, 100);
  await clearStatus(env, loadToken, "machine", 99);
  const fallback = await statusSnapshot(env, loadToken);
  assert.equal(fallback.available, false);
  assert.equal(fallback.stale, true);
  assert.equal(fallback.machines["1"].last_seen_at, 100);
});

test("status timeout leaves scheduling tolerance above the configured polling interval", () => {
  assert.equal(statusTimeout(300), 450);
  assert.equal(nodeAvailableStatus(650, 650, 1000, 300, 300), 2);
  assert.equal(nodeAvailableStatus(549, 650, 1000, 300, 300), 0);
  assert.equal(nodeAvailableStatus(null, null, 1000, 300, 300), 0);
});

test("Edge and Jobs keep the writable internal authentication implementation in sync", () => {
  const normalize = source => source
    .replace('from "../types"', 'from "./types.ts"')
    .replace(/\r\n/g, "\n")
    .trim();
  const edge = normalize(fs.readFileSync("src/internal/auth.ts", "utf8"));
  const jobs = normalize(fs.readFileSync("../xboard-jobs/src/internal-auth.ts", "utf8"));
  assert.equal(edge, jobs);
});

test("node synchronization only follows the audited exact route suffixes", () => {
  assert.equal(shouldNotifyNodeSync("/api/v1/admin/server/manage/save", "POST"), true);
  assert.equal(shouldNotifyNodeSync("/api/v1/admin/server/manage/save-extra", "POST"), false);
  assert.equal(shouldNotifyNodeSync("/api/v1/admin/user/update", "GET"), false);
  assert.equal(shouldNotifyNodeSync("/api/v1/admin/unrelated/user/update-preview", "POST"), false);
});
