import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { internalAuthHeaders, internalSyncToken, invalidateInternalTokenCache } from "../src/internal/auth.ts";
import { resetStatusClientMemoryForTest, statusSnapshot } from "../src/internal/status-client.ts";
import { adminServerRows, nodeAvailableStatus, statusTimeout } from "../src/admin/servers.ts";
import { freshSettings, settings } from "../src/db.ts";
import { nodeSyncIntent, shouldNotifyNodeSync } from "../src/internal/sync-client.ts";

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

test("internal authentication carries a D1 fallback during partial Secret rollout", async () => {
  invalidateInternalTokenCache();
  const db = settingsDatabase({ server_token: "public-node-token", internal_sync_token: "database-internal-token" });
  const headers = await internalAuthHeaders({ XBOARD_DB: db, INTERNAL_SYNC_TOKEN: "worker-secret" });
  assert.equal(headers["x-xboard-internal-token"], "worker-secret");
  assert.equal(headers["x-xboard-internal-token-fallback"], "database-internal-token");
});

test("status snapshots retain the last successful value during a transient StatusHub failure", async () => {
  const originalCaches = globalThis.caches;
  const cacheEntries = new Map();
  globalThis.caches = { default: {
    async put(request, response) { cacheEntries.set(request.url, response.clone()); },
    async match(request) { return cacheEntries.get(request.url)?.clone(); }
  } };
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
  const loadAuthHeaders = async () => ({ "x-xboard-internal-token": "internal-token" });
  try {
    const first = await statusSnapshot(env, loadAuthHeaders);
    assert.equal(first.available, true);
    assert.equal(first.stale, false);
    assert.equal(first.machines["1"].last_seen_at, 100);
    resetStatusClientMemoryForTest();
    const fallback = await statusSnapshot(env, loadAuthHeaders);
    assert.equal(fallback.available, false);
    assert.equal(fallback.stale, true);
    assert.equal(fallback.machines["1"].last_seen_at, 100);
  } finally {
    globalThis.caches = originalCaches;
  }
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

test("node edits request a targeted cache-bypassing synchronization", async () => {
  const env = { XBOARD_DB: { prepare() { throw new Error("node edits must not need a pre-save D1 read"); } } };
  const save = new Request("https://edge.test/api/v2/admin/server/manage/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 4, name: "updated node" })
  });
  assert.deepEqual(await nodeSyncIntent(save, new URL(save.url).pathname, env), { scope: "node", node_id: 4 });

  const create = new Request("https://edge.test/api/v2/admin/server/manage/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "new node" })
  });
  assert.deepEqual(await nodeSyncIntent(create, new URL(create.url).pathname, env), { scope: "all" });
});

test("node management and user lists bypass a stale KV server version", async () => {
  let show = 1;
  let serverReads = 0;
  const env = {
    XBOARD_DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async all() {
            if (sql.includes("FROM v2_server ORDER BY")) {
              serverReads += 1;
              return {
                results: [{
                  id: 1,
                  type: "shadowsocks",
                  name: "Node",
                  host: "127.0.0.1",
                  port: "443",
                  show,
                  enabled: 1,
                  group_ids: "[1]",
                  route_ids: "[]",
                  tags: "[]",
                  protocol_settings: "{}",
                  custom_outbounds: "[]",
                  custom_routes: "[]",
                  sort: 0,
                  updated_at: 1
                }]
              };
            }
            if (sql.includes("FROM v2_server_machine")) return { results: [] };
            if (sql.includes("FROM v2_server_group")) return { results: [{ id: 1, name: "Default" }] };
            if (sql.includes("FROM v2_settings")) {
              return {
                results: [
                  { name: "server_pull_interval", value: "300" },
                  { name: "server_push_interval", value: "300" }
                ]
              };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
          }
        };
      }
    }
  };
  const deps = {
    optionalKvGet: async () => "stale-node-toggle-version",
    parseJsonArray: value => JSON.parse(value || "[]"),
    parseJsonObject: value => JSON.parse(value || "{}"),
    routeMatchArray: value => JSON.parse(value || "[]"),
    isNilLike: value => value === null || value === undefined || value === "",
    nullableNumber: value => value === null || value === undefined || value === "" ? null : Number(value),
    statusSnapshot: async () => ({ nodes: {}, machines: {}, online: {}, devices: {} }),
    machineHistory: async () => []
  };

  const firstNode = (await adminServerRows(env, deps))[0];
  assert.equal(firstNode.show, true);
  assert.deepEqual(firstNode.group_ids, ["1"]);
  assert.deepEqual(firstNode.groups, [{ id: 1, name: "Default" }]);
  show = 0;
  assert.equal((await adminServerRows(env, deps))[0].show, true);
  assert.equal((await adminServerRows(env, deps, { freshAll: true }))[0].show, false);
  assert.equal(serverReads, 2);
  assert.equal((await adminServerRows(env, { ...deps, optionalKvGet: async () => { throw new Error("KV must not be read"); } }, { freshAll: true }))[0].show, false);

  const edgeSource = fs.readFileSync("src/index.ts", "utf8");
  assert.match(edgeSource, /server\/manage\/getNodes"\) return ok\(await adminServerRows\(env, "all"\)\)/);
  assert.match(edgeSource, /server\/fetch"\)[\s\S]{0,300}adminServerRows\(env, "all"\)/);
});

test("frontend settings read primary D1 while node polling keeps its caches", () => {
  const edgeSource = fs.readFileSync("src/index.ts", "utf8");
  const planSource = fs.readFileSync("src/admin/plans.ts", "utf8");
  const serverSource = fs.readFileSync("../xboard-server/src/index.ts", "utf8");

  assert.match(edgeSource, /async function adminConfig[\s\S]{0,300}freshSettings\(env\.XBOARD_DB\)/);
  assert.match(edgeSource, /guest\/comm\/config[\s\S]{0,200}freshSettings\(env\.XBOARD_DB\)/);
  assert.match(edgeSource, /async function clientApi[\s\S]{0,300}freshSettings\(env\.XBOARD_DB\)/);
  assert.match(edgeSource, /route === "\/comm\/config"[\s\S]{0,150}freshSettings\(env\.XBOARD_DB\)/);
  assert.match(planSource, /publicPlanRows[\s\S]{0,300}freshSettings\(env\.XBOARD_DB\)/);
  assert.match(planSource, /adminPlanRows\(env, deps\)/);

  assert.match(serverSource, /node-config:\$\{node\.id\}[\s\S]{0,150}, 300,/);
  assert.match(serverSource, /node-users:\$\{node\.id\}[\s\S]{0,150}, 30,/);
  assert.match(serverSource, /setting\(env, "server_push_interval", "300"\)/);
});

test("fresh frontend settings observe consecutive D1 changes without KV", async () => {
  let value = "60";
  const db = {
    prepare(sql) {
      assert.equal(sql, "SELECT name, value FROM v2_settings");
      return {
        async all() {
          return { results: [{ name: "server_pull_interval", value }] };
        }
      };
    }
  };

  assert.equal((await freshSettings(db)).server_pull_interval, 60);
  value = "300";
  const unavailableKv = {
    async get() { throw new Error("frontend settings must not read KV"); },
    async put() { throw new Error("frontend settings must not write KV"); }
  };
  assert.equal((await settings(db, unavailableKv)).server_pull_interval, 300);
  value = "600";
  assert.equal((await settings(db, unavailableKv)).server_pull_interval, 600);
});
