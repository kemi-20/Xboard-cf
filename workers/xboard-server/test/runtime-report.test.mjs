import assert from "node:assert/strict";
import test from "node:test";
import serverWorker, { NodeHub } from "../src/index.ts";

function runtimeFixture(machines, nodes) {
  const calls = [];
  const events = [];
  const userWrites = [];
  const env = {
    XBOARD_DB: {
      withSession() { return this; },
      async batch(statements) { userWrites.push(...statements); },
      prepare(sql) {
        return {
          bind(...args) {
            const [id, machineId] = args;
            const row = sql.includes("FROM v2_server_machine") ? machines[id]
              : sql.includes("AND machine_id") && nodes[id]?.machine_id !== machineId ? null
              : sql.includes("WHERE id = ?") ? nodes[id] : null;
            return { sql, args, async first() { return row ?? null; } };
          }
        };
      }
    },
    STATUS_HUB: {
      idFromName: name => name,
      get: () => ({
        async fetch(url, init) {
          const path = new URL(url).pathname;
          calls.push({ path, ...JSON.parse(init.body) });
          return Response.json({ data: path === "/devices/report" ? { counts: {} } : true });
        }
      })
    },
    TRAFFIC_EVENTS: { async send(event) { events.push(event); } }
  };
  return { env, calls, events, userWrites };
}

test("WebSocket node monitoring is sampled per node across hibernation, without delaying device reports", async t => {
  const start = 2_000_000_000_000;
  let current = start;
  t.mock.method(Date, "now", () => current);
  const { env, calls } = runtimeFixture({}, { 1101: { id: 1101, machine_id: 110 }, 1102: { id: 1102, machine_id: 110 } });
  let identity = { mode: "machine", machine_id: 110, node_ids: [1101, 1102] };
  const messages = [];
  const socket = {
    deserializeAttachment: () => structuredClone(identity),
    serializeAttachment: next => { identity = structuredClone(next); },
    send: message => messages.push(JSON.parse(message))
  };
  const send = (event, node_id, data = {}) => new NodeHub({}, env).webSocketMessage(socket,
    JSON.stringify({ event, data: { ...data, node_id } }));

  await send("node.status", 1103, { active_connections: 9 });
  assert.equal(calls.length, 0);
  await send("node.status", 1101, { active_connections: 1 });
  for (let seconds = 10; seconds < 60; seconds += 10) {
    current = start + seconds * 1000;
    await send("node.status", 1101, { active_connections: 2 });
  }
  await send("node.status", 1102, { active_connections: 3 });
  await send("report.devices", 1101, { devices: {} });
  assert.equal(messages[0].event, "sync.devices");
  current = start + 60_000;
  await send("node.status", 1101, { active_connections: 4 });
  assert.deepEqual(calls.map(call => [call.path, call.id ?? call.node_id, call.state?.metrics.active_connections]), [
    ["/report", 1101, 1], ["/report", 1102, 3], ["/devices/report", 1101, undefined], ["/report", 1101, 4]
  ]);
  assert.equal(calls.at(-1).state.last_check_at, current / 1000);
});

test("HTTP V2 report sends one node-status update and preserves authorization and traffic failures", async t => {
  t.mock.method(Date, "now", () => 2_000_000_000_000);
  const credential = crypto.randomUUID();
  const { env, calls, events, userWrites } = runtimeFixture(
    { 120: { id: 120, is_active: 1, token: credential } },
    { 1201: { id: 1201, machine_id: 120, type: "vless", rate: 1 } }
  );
  const report = (nodeId = 1201, token = credential, online) => serverWorker.fetch(new Request("https://example.invalid/api/v2/server/report", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      machine_id: 120, node_id: nodeId, token, traffic: { 7: [1024, 2048] },
      status: { cpu: 10, mem: {}, disk: {} }, metrics: { active_connections: 2 }, online
    })
  }), env);

  assert.equal((await report(1201, crypto.randomUUID())).status, 401);
  assert.equal((await report(1202)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(events.length, 0);

  assert.deepEqual(await (await report()).json(), { data: true });
  assert.deepEqual(calls.map(call => call.kind), ["machine", "node"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, [{ user_id: 7, u: 1024, d: 2048 }]);
  assert.equal(calls[1].state.last_check_at, calls[1].state.last_push_at);
  assert.equal(calls[1].state.metrics.active_connections, 2);
  assert.equal(calls[1].state.load_status.cpu, 10);
  assert.deepEqual(calls[1].state.connections, { 7: 1 });
  assert.equal(userWrites.length, 0);

  await report(1201, credential, { 8: 2, 9: 0 });
  assert.deepEqual(calls.at(-1).state.connections, { 8: 2 });
  assert.equal(userWrites.length, 1);
  assert.match(userWrites[0].sql, /UPDATE v2_user/);
  assert.equal(userWrites[0].args[3], 8);
  await report(1201, credential, {});
  assert.deepEqual(calls.at(-1).state.connections, {});
  assert.equal(userWrites.length, 1);

  calls.length = 0;
  env.TRAFFIC_EVENTS.send = async () => { throw new Error("Queue unavailable"); };
  await assert.rejects(report(), /Queue unavailable/);
  assert.deepEqual(calls.map(call => call.kind), ["machine", "node"]);
  assert.deepEqual(Object.keys(calls[1].state).sort(), ["last_check_at", "machine_id"]);
});
