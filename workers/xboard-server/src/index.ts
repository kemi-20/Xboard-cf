import type { D1Database, KVNamespace, Queue, DurableObjectState, ExecutionContext } from "./types.ts";
import { now } from "./compat.ts";
import { invalidateSettingsCache, settings as loadSettings } from "./db.ts";
import {
  availableUser, buildNodeConfig, isValidNodeType, normalizeNodeType,
  parseJson, parseTraffic, responseEtag, type Row
} from "./protocol.ts";

export interface Env {
  XBOARD_DB: D1Database;
  XBOARD_KV: KVNamespace;
  TRAFFIC_EVENTS: Queue;
  NODE_HUB: any;
  STATUS_HUB: any;
}

type AuthContext = { input: Row; node?: Row; machine?: Row };

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function operationSuccess(data: unknown = true) {
  return json({ status: "success", message: "操作成功", data, error: null });
}

function apiFailure(message: string, status = 400, error: unknown = null) {
  return json({ status: "fail", message, data: null, error }, status);
}

function validationFailure(field: string, message?: string) {
  const text = message || `The ${field.replaceAll("_", " ")} field is required.`;
  return json({ message: text, errors: { [field]: [text] } }, 422);
}

async function readInput(request: Request): Promise<Row> {
  const url = new URL(request.url);
  const input: Row = {};
  url.searchParams.forEach((value, key) => { input[key] = value; });
  if (["GET", "HEAD"].includes(request.method)) return input;
  const type = request.headers.get("content-type") || "";
  try {
    if (type.includes("application/json")) {
      const value = await request.json();
      input.__raw = value;
      if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(input, value);
      else if (!Array.isArray(value)) input.__invalid_json = true;
    } else {
      const form = await request.formData();
      form.forEach((value, key) => { input[key] = value; });
      input.__invalid_json = true;
    }
  } catch {
    input.__invalid_json = true;
  }
  return input;
}

async function setting(env: Env, name: string, fallback = "") {
  const values = await loadSettings(env.XBOARD_DB);
  return values[name] ?? fallback;
}

function booleanSetting(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

const STATUS_HUB_ID = "global";

function statusHub(env: Env) {
  return env.STATUS_HUB.get(env.STATUS_HUB.idFromName(STATUS_HUB_ID));
}

async function reportStatus(env: Env, kind: "machine" | "node", id: number, state: Row, history = false) {
  try {
    await statusHub(env).fetch("https://status-hub.internal/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, id, state, history })
    });
  } catch {
    // Runtime status is best effort; formal configuration and traffic remain durable elsewhere.
  }
}

async function getNode(env: Env, identifier: unknown, type?: string | null): Promise<Row | null> {
  if (identifier === null || identifier === undefined || identifier === "") return null;
  const normalized = normalizeNodeType(type);
  if (normalized) {
    return await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE (CAST(code AS TEXT) = ? OR id = ?) AND type = ? ORDER BY CASE WHEN CAST(code AS TEXT) = ? THEN 0 ELSE 1 END LIMIT 1")
      .bind(String(identifier), Number(identifier), normalized, String(identifier)).first<Row>();
  }
  return await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE CAST(code AS TEXT) = ? OR id = ? ORDER BY CASE WHEN CAST(code AS TEXT) = ? THEN 0 ELSE 1 END LIMIT 1")
    .bind(String(identifier), Number(identifier), String(identifier)).first<Row>();
}

async function getMachine(env: Env, id: unknown, token: unknown): Promise<Row | null> {
  if (!Number.isInteger(Number(id)) || !token) return null;
  const machine = await env.XBOARD_DB.prepare("SELECT * FROM v2_server_machine WHERE id = ?").bind(Number(id)).first<Row>();
  return machine && equalText(String(machine.token || ""), String(token)) ? machine : null;
}

function equalText(actual: string, expected: string) {
  const a = new TextEncoder().encode(actual), b = new TextEncoder().encode(expected);
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) different |= (a[index] || 0) ^ (b[index] || 0);
  return different === 0;
}

async function authenticateV1(env: Env, input: Row, forcedType?: string): Promise<AuthContext | Response> {
  if (!input.token) return validationFailure("token");
  if (!input.node_id) return validationFailure("node_id");
  const configured = await setting(env, "server_token");
  if (!equalText(String(input.token), configured)) return validationFailure("token", "Invalid token");
  const requestedType = normalizeNodeType(forcedType ?? input.node_type);
  if (!isValidNodeType(requestedType)) return validationFailure("node_type", "Invalid node type specified");
  const node = await getNode(env, input.node_id, requestedType);
  if (!node) return apiFailure("Server does not exist");
  return { input, node };
}

async function authenticateV2(env: Env, input: Row, handshake = false): Promise<AuthContext | Response> {
  if (input.machine_id !== undefined && input.machine_id !== null && input.machine_id !== "") {
    if (!Number.isInteger(Number(input.machine_id))) return validationFailure("machine_id", "The machine id must be an integer.");
    if (!input.token) return validationFailure("token");
    if (!handshake && !Number.isInteger(Number(input.node_id))) return validationFailure("node_id", "The node id field is required.");
    const machine = await getMachine(env, input.machine_id, input.token);
    if (!machine) return apiFailure("Machine not found or invalid token", 401);
    if (!Number(machine.is_active ?? machine.enabled ?? 1)) return apiFailure("Machine is disabled", 403);
    let node: Row | undefined;
    if (Number(input.node_id) > 0) {
      const found = await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE id = ? AND machine_id = ? AND enabled = 1").bind(Number(input.node_id), Number(machine.id)).first<Row>();
      if (!found) return apiFailure("Node not found on this machine");
      node = found;
    }
    await reportStatus(env, "machine", Number(machine.id), { last_seen_at: now() });
    return { input, machine, node };
  }
  if (!input.token) return validationFailure("token");
  const configured = await setting(env, "server_token");
  if (!equalText(String(input.token), configured)) return validationFailure("token", "Invalid token");
  if (!handshake && !input.node_id) return validationFailure("node_id");
  if (!input.node_id) return { input };
  const node = await getNode(env, input.node_id);
  if (!node) return apiFailure("Server does not exist");
  return { input, node };
}

async function authenticateMachineEndpoint(env: Env, input: Row): Promise<AuthContext | Response> {
  if (!Number.isInteger(Number(input.machine_id))) return validationFailure("machine_id", "The machine id field is required.");
  if (!input.token) return validationFailure("token");
  const machine = await getMachine(env, input.machine_id, input.token);
  if (!machine || !Number(machine.is_active ?? machine.enabled ?? 1)) return json({ message: "Machine not found or disabled" }, 403);
  return { input, machine };
}

async function routeRows(env: Env, node: Row): Promise<Row[]> {
  const ids = parseJson<any[]>(node.route_ids, []).map(Number).filter(Number.isFinite);
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  const result = await env.XBOARD_DB.prepare(`SELECT id, match, action, action_value FROM v2_server_route WHERE id IN (${marks})`).bind(...ids).all<Row>();
  return result.results || [];
}

async function nodeConfig(env: Env, node: Row) {
  const config = buildNodeConfig(node, await routeRows(env, node));
  config.base_config = {
    push_interval: Number(await setting(env, "server_push_interval", "300")),
    pull_interval: Number(await setting(env, "server_pull_interval", "300"))
  };
  return config;
}

async function nodeUsers(env: Env, node: Row): Promise<Row[]> {
  const groupIds = parseJson<any[]>(node.group_ids, []).map(Number).filter(Number.isFinite);
  if (!groupIds.length) return [];
  const marks = groupIds.map(() => "?").join(",");
  const result = await env.XBOARD_DB.prepare(`SELECT id, uuid, speed_limit, device_limit FROM v2_user WHERE group_id IN (${marks}) AND (u + d) < transfer_enable AND (expired_at >= ? OR expired_at IS NULL) AND banned = 0`)
    .bind(...groupIds, now()).all<Row>();
  return (result.results || []).map(availableUser);
}

async function etagResponse(request: Request, data: unknown) {
  const etag = await responseEtag(data);
  if ((request.headers.get("if-none-match") || "").includes(etag.replaceAll('"', ""))) return new Response(null, { status: 304 });
  return json(data, 200, { ETag: etag });
}

async function touchNode(env: Env, node: Row) {
  const ts = now();
  await reportStatus(env, "node", Number(node.id), { machine_id: Number(node.machine_id || 0) || null, last_check_at: ts });
}

async function optionalKvPut(env: Env, key: string, value: string, options?: { expirationTtl?: number }) {
  try { await env.XBOARD_KV.put(key, value, options); } catch { /* D1 and live reports remain authoritative. */ }
}

async function optionalKvGet(env: Env, key: string) {
  try { return await env.XBOARD_KV.get(key); } catch { return null; }
}

async function optionalKvDelete(env: Env, key: string) {
  try { await env.XBOARD_KV.delete(key); } catch { /* KV device state is ephemeral. */ }
}

function currentRate(node: Row) {
  const parsedFallback = Number(node.rate);
  const fallback = Number.isFinite(parsedFallback) ? parsedFallback : 1;
  if (!Number(node.rate_time_enable)) return fallback;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const hour = parts.find(part => part.type === "hour")?.value || "00";
  const minute = parts.find(part => part.type === "minute")?.value || "00";
  const time = `${hour}:${minute}`;
  const range = parseJson<Row[]>(node.rate_time_ranges, []).find(item => time >= String(item.start || "") && time <= String(item.end || ""));
  if (!range) return fallback;
  const parsed = Number(range.rate);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function enqueueTraffic(env: Env, node: Row, raw: unknown) {
  const payload = parseTraffic(raw);
  if (!payload.length) return;
  const ts = now();
  await env.TRAFFIC_EVENTS.send({ event_id: crypto.randomUUID(), type: "traffic", server_id: Number(node.id), server_type: String(node.type), rate: currentRate(node), payload, created_at: ts });
  await reportStatus(env, "node", Number(node.id), {
    machine_id: Number(node.machine_id || 0) || null,
    last_push_at: ts,
    online: payload.length
  });
}

async function updateUserDeviceIndex(env: Env, nodeId: number, previous: Row, next: Row) {
  const userIds = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const userId of userIds) {
    const key = `user:devices:${userId}`;
    const aggregate = parseJson<Row>(await optionalKvGet(env, key), {});
    if (next[userId] && typeof next[userId] === "object") aggregate[String(nodeId)] = next[userId];
    else delete aggregate[String(nodeId)];
    if (Object.keys(aggregate).length) await optionalKvPut(env, key, JSON.stringify(aggregate), { expirationTtl: 600 });
    else await optionalKvDelete(env, key);
  }
}

function normalizeDeviceIp(value: unknown) {
  const ip = String(value || "");
  const ipv6 = ip.match(/^\[(.+)\]:\d+$/);
  if (ipv6) return ipv6[1];
  const ipv4 = ip.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
  return ipv4 ? ipv4[1] : ip;
}

async function processAlive(env: Env, nodeId: number, data: unknown) {
  if (!data || typeof data !== "object") return false;
  const key = `node:devices:${nodeId}`;
  const previous = parseJson<Row>(await optionalKvGet(env, key), {});
  const next: Row = {};
  const timestamp = now();
  for (const [userId, ips] of Object.entries(data as Row)) {
    if (/^\d+$/.test(userId) && Array.isArray(ips)) {
      next[userId] = Object.fromEntries(Array.from(new Set(ips.map(normalizeDeviceIp).filter(Boolean))).map(ip => [ip, timestamp]));
    }
  }
  await updateUserDeviceIndex(env, nodeId, previous, next);
  await optionalKvPut(env, key, JSON.stringify(next), { expirationTtl: 300 });
  const affected = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const statements = [];
  for (const userId of affected) {
    const nodes = parseJson<Row>(await optionalKvGet(env, `user:devices:${userId}`), {});
    const ips = new Set<string>();
    for (const value of Object.values(nodes)) {
      if (Array.isArray(value)) for (const ip of value) ips.add(normalizeDeviceIp(ip));
      else if (value && typeof value === "object") for (const [ip, seenAt] of Object.entries(value)) if (Number(seenAt) >= timestamp - 300) ips.add(normalizeDeviceIp(ip));
    }
    statements.push(env.XBOARD_DB.prepare("UPDATE v2_user SET online_count = ?, last_online_at = ?, updated_at = ? WHERE id = ?").bind(ips.size, ips.size ? timestamp : null, timestamp, Number(userId)));
  }
  if (statements.length) await env.XBOARD_DB.batch(statements);
  return true;
}

async function aggregateDevices(env: Env, users: Row[]) {
  const output: Row = {};
  const cutoff = now() - 300;
  for (const user of users) {
    if (Number(user.device_limit || 0) <= 0) continue;
    const nodes = parseJson<Row>(await optionalKvGet(env, `user:devices:${user.id}`), {});
    const ips = new Set<string>();
    for (const value of Object.values(nodes)) {
      if (Array.isArray(value)) for (const ip of value) ips.add(normalizeDeviceIp(ip));
      else if (value && typeof value === "object") for (const [ip, seenAt] of Object.entries(value)) if (Number(seenAt) >= cutoff) ips.add(normalizeDeviceIp(ip));
    }
    if (ips.size > 0) output[String(user.id)] = [...ips];
  }
  return output;
}

async function clearNodeDevices(env: Env, nodeId: number) {
  const key = `node:devices:${nodeId}`;
  const previous = parseJson<Row>(await optionalKvGet(env, key), {});
  if (Object.keys(previous).length) await updateUserDeviceIndex(env, nodeId, previous, {});
  await optionalKvDelete(env, key);
  if (Object.keys(previous).length) {
    const timestamp = now();
    const statements = [];
    for (const userId of Object.keys(previous)) {
      const devices = await aggregateDevices(env, [{ id: Number(userId), device_limit: 1 }]);
      statements.push(env.XBOARD_DB.prepare("UPDATE v2_user SET online_count = ?, last_online_at = ?, updated_at = ? WHERE id = ?").bind(Array.isArray(devices[userId]) ? devices[userId].length : 0, Array.isArray(devices[userId]) && devices[userId].length ? timestamp : null, timestamp, Number(userId)));
    }
    if (statements.length) await env.XBOARD_DB.batch(statements);
  }
}

async function processStatus(env: Env, node: Row, status: unknown) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return;
  const value = status as Row;
  const load = {
    cpu: Number(value.cpu || 0),
    mem: { total: Number(value.mem?.total || 0), used: Number(value.mem?.used || 0) },
    swap: { total: Number(value.swap?.total || 0), used: Number(value.swap?.used || 0) },
    disk: { total: Number(value.disk?.total || 0), used: Number(value.disk?.used || 0) },
    updated_at: now(),
    kernel_status: value.kernel_status ?? null
  } as Row;
  if (value.net?.in_speed !== undefined && value.net?.out_speed !== undefined) {
    load.net = { in_speed: Number(value.net.in_speed), out_speed: Number(value.net.out_speed) };
  }
  await reportStatus(env, "node", Number(node.id), { machine_id: Number(node.machine_id || 0) || null, load_status: load });
}

async function processMetrics(env: Env, node: Row, metrics: unknown) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return;
  const timestamp = now();
  const value = { ...(metrics as Row), updated_at: timestamp };
  await reportStatus(env, "node", Number(node.id), {
    machine_id: Number(node.machine_id || 0) || null,
    metrics: value,
    last_push_at: timestamp
  });
}

function validateStatus(input: Row, optional = false): Response | null {
  const required = ["cpu", "mem.total", "mem.used"];
  if (!optional) required.push("swap.total", "swap.used", "disk.total", "disk.used");
  for (const path of required) {
    const value = path.split(".").reduce<any>((cursor, part) => cursor?.[part], input);
    if (value === undefined || value === null || !Number.isFinite(Number(value)) || Number(value) < 0) return validationFailure(path, `The ${path} field is required.`);
  }
  if (Number(input.cpu) > 100) return validationFailure("cpu", "The cpu must not be greater than 100.");
  return null;
}

async function handleConfig(request: Request, env: Env, auth: AuthContext) {
  return etagResponse(request, await nodeConfig(env, auth.node!));
}

async function handleUsers(request: Request, env: Env, auth: AuthContext) {
  await touchNode(env, auth.node!);
  return etagResponse(request, { users: await nodeUsers(env, auth.node!) });
}

async function handleUniProxy(request: Request, env: Env, action: string, auth: AuthContext) {
  const node = auth.node!;
  if (action === "config") return handleConfig(request, env, auth);
  if (action === "user") return handleUsers(request, env, auth);
  if (action === "push") {
    if (auth.input.__invalid_json || !auth.input.__raw || typeof auth.input.__raw !== "object") return apiFailure("Invalid data format", 422);
    await enqueueTraffic(env, node, auth.input.__raw);
    return operationSuccess(true);
  }
  if (action === "alive") {
    if (auth.input.__invalid_json || !(await processAlive(env, Number(node.id), auth.input.__raw))) return json({ error: "Invalid online data" }, 400);
    return json({ data: true });
  }
  if (action === "alivelist") return json({ alive: await aggregateDevices(env, await nodeUsers(env, node)) });
  if (action === "status") {
    const failure = validateStatus(auth.input);
    if (failure) return failure;
    await processStatus(env, node, auth.input);
    return json({ data: true, code: 0, message: "success" });
  }
  return json({ message: "Not Found" }, 404);
}

async function handleTidalab(request: Request, env: Env, family: string, action: string, auth: AuthContext) {
  const node = auth.node!;
  const users = await nodeUsers(env, node);
  const protocol = parseJson<Row>(node.protocol_settings, {});
  if (family === "ShadowsocksTidalab") {
    if (action === "user") {
      await touchNode(env, node);
      const data = users.map(user => ({ id: user.id, port: Number(node.server_port), cipher: protocol.cipher ?? null, secret: user.uuid }));
      const etag = await responseEtag(data);
      if ((request.headers.get("if-none-match") || "").includes(etag.replaceAll('"', ""))) return new Response(null, { status: 304 });
      return json({ data }, 200, { ETag: etag });
    }
    if (action === "submit") {
      const raw = Array.isArray(auth.input.__raw) ? auth.input.__raw : [];
      const traffic: Row = {};
      for (const item of raw as any[]) if (item?.user_id !== undefined) traffic[String(item.user_id)] = [item.u, item.d];
      await enqueueTraffic(env, node, traffic);
      return json({ ret: 1, msg: "ok" });
    }
  }
  if (family === "TrojanTidalab") {
    if (action === "user") {
      await touchNode(env, node);
      const data = users.map(({ uuid, ...user }) => ({ ...user, trojan_user: { password: uuid } }));
      const etag = await responseEtag(data);
      if ((request.headers.get("if-none-match") || "").includes(etag.replaceAll('"', ""))) return new Response(null, { status: 304 });
      return json({ msg: "ok", data }, 200, { ETag: etag });
    }
    if (action === "submit") {
      const raw = Array.isArray(auth.input.__raw) ? auth.input.__raw : [];
      const traffic: Row = {};
      for (const item of raw as any[]) if (item?.user_id !== undefined) traffic[String(item.user_id)] = [item.u, item.d];
      await enqueueTraffic(env, node, traffic);
      return json({ ret: 1, msg: "ok" });
    }
    if (action === "config") {
      if (!auth.input.local_port) return validationFailure("local_port", "本地端口不能为空");
      const config = { run_type: "server", local_addr: "0.0.0.0", local_port: Number(node.server_port), remote_addr: "www.taobao.com", remote_port: 80, password: [], ssl: { cert: "/root/.cert/server.crt", key: "/root/.cert/server.key", sni: protocol.server_name || node.host }, api: { enabled: true, api_addr: "127.0.0.1", api_port: Number(auth.input.local_port) } };
      return new Response(JSON.stringify(config), { headers: { "content-type": "text/plain; charset=UTF-8" } });
    }
  }
  return json({ message: "Not Found" }, 404);
}

async function machineNodes(env: Env, machine: Row) {
  const result = await env.XBOARD_DB.prepare("SELECT id, type, name FROM v2_server WHERE machine_id = ? AND enabled = 1 ORDER BY sort ASC").bind(machine.id).all<Row>();
  return {
    nodes: result.results || [],
    base_config: { push_interval: Number(await setting(env, "server_push_interval", "300")), pull_interval: Number(await setting(env, "server_pull_interval", "300")) }
  };
}

async function saveMachineStatus(env: Env, machine: Row, input: Row) {
  const recordedAt = now();
  const load: Row = {
    cpu: Number(input.cpu), mem: { total: Number(input.mem.total), used: Number(input.mem.used) },
    swap: { total: Number(input.swap?.total || 0), used: Number(input.swap?.used || 0) },
    disk: { total: Number(input.disk?.total || 0), used: Number(input.disk?.used || 0) }, updated_at: recordedAt
  };
  if (input.net?.in_speed !== undefined && input.net?.out_speed !== undefined) load.net = { in_speed: Number(input.net.in_speed), out_speed: Number(input.net.out_speed) };
  await reportStatus(env, "machine", Number(machine.id), { last_seen_at: recordedAt, load_status: load }, true);
}

async function internalToken(env: Env) {
  const value = await setting(env, "internal_sync_token", await setting(env, "server_token"));
  return String(value || "").trim() || null;
}

async function pushDo(env: Env, name: string, event: string, data: Row) {
  const id = env.NODE_HUB.idFromName(name);
  const response = await env.NODE_HUB.get(id).fetch("https://node-hub.internal/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event, data }) });
  return await response.json() as Row;
}

async function disconnectDo(env: Env, name: string) {
  const id = env.NODE_HUB.idFromName(name);
  await env.NODE_HUB.get(id).fetch("https://node-hub.internal/disconnect", { method: "POST" });
}

async function nodePushTarget(env: Env, node: Row) {
  return await optionalKvGet(env, `node:ws:target:${node.id}`)
    || (Number(node.machine_id) > 0 ? `machine:${node.machine_id}` : `node:${node.id}`);
}

function websocketError(message: string) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  (server as any).accept();
  server.send(wsMessage("error", { message }));
  server.close(1008, message);
  return new Response(null, { status: 101, webSocket: client } as any);
}

async function syncNode(env: Env, node: Row) {
  if (!Number(node.enabled ?? 1)) return;
  const target = await nodePushTarget(env, node);
  const suffix = target.startsWith("machine:") ? { node_id: Number(node.id) } : {};
  await pushDo(env, target, "sync.config", { config: await nodeConfig(env, node), ...suffix });
  await pushDo(env, target, "sync.users", { users: await nodeUsers(env, node), ...suffix });
}

function userIsAvailable(user: Row | null): user is Row {
  if (!user || !Number(user.group_id) || Number(user.banned || 0) === 1) return false;
  if (Number(user.u || 0) + Number(user.d || 0) >= Number(user.transfer_enable || 0)) return false;
  return user.expired_at === null || user.expired_at === undefined || Number(user.expired_at) >= now();
}

async function nodesForGroups(env: Env, groupIds: Set<number>) {
  if (!groupIds.size) return [];
  const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE enabled = 1").all<Row>();
  return (result.results || []).filter(node =>
    parseJson<unknown[]>(node.group_ids, []).some(groupId => groupIds.has(Number(groupId)))
  );
}

async function syncUserChange(env: Env, userId: number, oldGroupId?: number) {
  const user = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id = ?").bind(userId).first<Row>();
  const currentGroupId = Number(user?.group_id || 0);
  const groups = new Set<number>([Number(oldGroupId || 0), currentGroupId].filter(Boolean));
  const canAdd = userIsAvailable(user);
  let sent = 0;
  for (const node of await nodesForGroups(env, groups)) {
    const nodeGroups = new Set(parseJson<unknown[]>(node.group_ids, []).map(Number));
    const action = canAdd && nodeGroups.has(currentGroupId) ? "add" : "remove";
    const users = action === "add" && user ? [availableUser(user)] : [{ id: userId }];
    const target = await nodePushTarget(env, node);
    const suffix = target.startsWith("machine:") ? { node_id: Number(node.id) } : {};
    const result = await pushDo(env, target, "sync.user.delta", { action, users, ...suffix });
    sent += Number(result.sent || 0);
  }
  return sent;
}

async function syncUsersChange(env: Env, userIds: number[]) {
  const ids = [...new Set(userIds.map(Number).filter(id => id > 0))].slice(0, 1000);
  if (!ids.length) return 0;
  const users = await env.XBOARD_DB.prepare(`SELECT id, group_id FROM v2_user WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<Row>();
  const groupByUser = new Map((users.results || []).map(user => [Number(user.id), Number(user.group_id || 0)]));
  const groups = new Set([...groupByUser.values()].filter(Boolean));
  let sent = 0;
  for (const node of await nodesForGroups(env, groups)) {
    const nodeGroups = new Set(parseJson<unknown[]>(node.group_ids, []).map(Number));
    const affected = ids.filter(id => nodeGroups.has(groupByUser.get(id) || 0)).map(id => ({ id }));
    if (!affected.length) continue;
    const target = await nodePushTarget(env, node);
    const suffix = target.startsWith("machine:") ? { node_id: Number(node.id) } : {};
    const result = await pushDo(env, target, "sync.user.delta", { action: "remove", users: affected, ...suffix });
    sent += Number(result.sent || 0);
  }
  return sent;
}

async function syncAll(env: Env) {
  const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE enabled = 1").all<Row>();
  for (const node of result.results || []) {
    await syncNode(env, node);
  }
  const machines = await env.XBOARD_DB.prepare("SELECT * FROM v2_server_machine").all<Row>();
  for (const machine of machines.results || []) {
    await pushDo(env, `machine:${machine.id}`, "sync.nodes", { nodes: (await machineNodes(env, machine)).nodes });
  }
}

function wsMessage(event: string, data: Row = {}) {
  return JSON.stringify({ event, data, timestamp: now() });
}

export class StatusHub {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async snapshot() {
    const [machines, nodes] = await Promise.all([
      this.state.storage.list<Row>({ prefix: "machine:" }),
      this.state.storage.list<Row>({ prefix: "node:" })
    ]);
    return {
      machines: Object.fromEntries([...machines].map(([key, value]) => [key.slice("machine:".length), value])),
      nodes: Object.fromEntries([...nodes].map(([key, value]) => [key.slice("node:".length), value]))
    };
  }

  private historyPoint(load: Row, recordedAt: number) {
    return {
      cpu: Number(load.cpu || 0),
      mem_total: Number(load.mem?.total || 0),
      mem_used: Number(load.mem?.used || 0),
      disk_total: Number(load.disk?.total || 0),
      disk_used: Number(load.disk?.used || 0),
      net_in_speed: load.net?.in_speed === undefined ? null : Number(load.net.in_speed),
      net_out_speed: load.net?.out_speed === undefined ? null : Number(load.net.out_speed),
      recorded_at: recordedAt
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/report" && request.method === "POST") {
      const input = await request.json() as { kind?: string; id?: number; state?: Row; history?: boolean };
      const kind = input.kind === "machine" ? "machine" : input.kind === "node" ? "node" : null;
      const id = Number(input.id || 0);
      if (!kind || !id || !input.state || typeof input.state !== "object") return json({ message: "Invalid status report" }, 422);
      const key = `${kind}:${id}`;
      const previous = await this.state.storage.get<Row>(key) || {};
      const updatedAt = now();
      const next = { ...previous, ...input.state, id, updated_at: updatedAt };
      const writes: Record<string, unknown> = { [key]: next };
      if (kind === "machine" && input.history && input.state.load_status && typeof input.state.load_status === "object") {
        const historyKey = `history:${id}`;
        const cutoff = updatedAt - 86400;
        const history = (await this.state.storage.get<Row[]>(historyKey) || []).filter(item => Number(item.recorded_at || 0) >= cutoff);
        const point = this.historyPoint(input.state.load_status as Row, updatedAt);
        if (history.length && updatedAt - Number(history[history.length - 1].recorded_at || 0) < 300) history[history.length - 1] = point;
        else history.push(point);
        writes[historyKey] = history.slice(-288);
      }
      await this.state.storage.put(writes);
      return json({ data: true });
    }
    if (url.pathname === "/snapshot" && request.method === "GET") return json({ data: await this.snapshot() });
    if (url.pathname === "/history" && request.method === "GET") {
      const machineId = Number(url.searchParams.get("machine_id") || 0);
      const limit = Math.min(1440, Math.max(10, Number(url.searchParams.get("limit") || 60)));
      const rangeHours = Number(url.searchParams.get("range_hours") || 0);
      const cutoff = rangeHours > 0 ? now() - Math.min(24, Math.max(1, rangeHours)) * 3600 : 0;
      const history = (await this.state.storage.get<Row[]>(`history:${machineId}`) || [])
        .filter(item => !cutoff || Number(item.recorded_at || 0) >= cutoff)
        .slice(-limit);
      return json({ data: history });
    }
    if (url.pathname === "/clear" && request.method === "POST") {
      const input = await request.json() as { kind?: string; id?: number };
      const id = Number(input.id || 0);
      if (input.kind === "machine" && id) {
        await Promise.all([this.state.storage.delete(`machine:${id}`), this.state.storage.delete(`history:${id}`)]);
      } else if (input.kind === "node" && id) await this.state.storage.delete(`node:${id}`);
      return json({ data: true });
    }
    if (url.pathname === "/reset" && request.method === "POST") {
      const entries = await this.state.storage.list({});
      for (const key of entries.keys()) await this.state.storage.delete(key);
      return json({ data: true, cleared: entries.size });
    }
    return json({ service: "StatusHub" });
  }
}

export class NodeHub {
  private localSockets = new Set<WebSocket>();
  private state: DurableObjectState;
  private env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private sockets(tag?: string): WebSocket[] {
    if (this.state.getWebSockets) return tag ? this.state.getWebSockets(tag) : this.state.getWebSockets();
    return [...this.localSockets];
  }

  private accept(socket: WebSocket, tags: string[]) {
    if (this.state.acceptWebSocket) this.state.acceptWebSocket(socket, tags);
    else (socket as any).accept();
    this.localSockets.add(socket);
  }

  private replaceConnections() {
    for (const socket of this.sockets()) {
      try { socket.close(1000, "replaced by a newer connection"); } catch { /* Already closed. */ }
    }
  }

  private attachment(socket: WebSocket): Row {
    try { return (socket as any).deserializeAttachment?.() || {}; } catch { return {}; }
  }

  private async fullSync(socket: WebSocket, node: Row, machineMode = false) {
    const suffix = machineMode ? { node_id: Number(node.id) } : {};
    socket.send(wsMessage("sync.config", { config: await nodeConfig(this.env, node), ...suffix }));
    socket.send(wsMessage("sync.users", { users: await nodeUsers(this.env, node), ...suffix }));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/disconnect" && request.method === "POST") {
      for (const socket of this.sockets()) {
        try { socket.close(1000, "replaced by a newer connection"); } catch { /* Already closed. */ }
      }
      return json({ data: true });
    }
    if (url.pathname === "/push") {
      const input = await readInput(request);
      const event = String(input.event || "");
      const data = input.data && typeof input.data === "object" ? input.data as Row : {};
      let sent = 0;
      for (const socket of this.sockets()) {
        if (event === "sync.nodes") {
          const identity = this.attachment(socket);
          const previousNodeIds = Array.isArray(identity.node_ids) ? identity.node_ids.map(Number) : [];
          const nodeIds = Array.isArray(data.nodes) ? data.nodes.map((node: Row) => Number(node.id)).filter(Boolean) : [];
          const updated = { ...identity, node_ids: nodeIds };
          (socket as any).serializeAttachment?.(updated);
          for (const removedId of previousNodeIds.filter(nodeId => !nodeIds.includes(nodeId))) {
            if (await this.env.XBOARD_KV.get(`node:ws:target:${removedId}`) === `machine:${identity.machine_id}`) {
              await this.env.XBOARD_KV.delete(`node:ws:target:${removedId}`);
            }
            await this.env.XBOARD_KV.delete(`node:ws:alive:${removedId}`);
            const previous = parseJson<Row>(await this.env.XBOARD_KV.get(`node:devices:${removedId}`), {});
            await updateUserDeviceIndex(this.env, removedId, previous, {});
            await this.env.XBOARD_KV.delete(`node:devices:${removedId}`);
          }
          for (const nodeId of nodeIds) {
            await this.env.XBOARD_KV.put(`node:ws:target:${nodeId}`, `machine:${identity.machine_id}`, { expirationTtl: 86400 });
            await this.env.XBOARD_KV.put(`node:ws:alive:${nodeId}`, "1", { expirationTtl: 86400 });
          }
        }
        socket.send(wsMessage(event, data));
        sent++;
      }
      return json({ data: true, sent });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ service: "NodeHub" });
    const input: Row = {};
    url.searchParams.forEach((value, key) => { input[key] = value; });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    let identity: Row;
    if (input.machine_id) {
      const machine = await getMachine(this.env, input.machine_id, input.token);
      if (!machine || !Number(machine.is_active ?? machine.enabled ?? 1)) {
        this.accept(server, ["invalid"]); server.send(wsMessage("error", { message: "invalid machine credentials" })); server.close(1008, "invalid machine credentials");
        return new Response(null, { status: 101, webSocket: client } as any);
      }
      const nodesResult = await this.env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE machine_id = ? AND enabled = 1 ORDER BY sort ASC").bind(machine.id).all<Row>();
      const nodes = nodesResult.results || [];
      identity = { mode: "machine", machine_id: Number(machine.id), node_ids: nodes.map(node => Number(node.id)) };
      this.replaceConnections();
      this.accept(server, [`machine:${machine.id}`]);
      (server as any).serializeAttachment?.(identity);
      server.send(wsMessage("auth.success", { machine_id: Number(machine.id), node_ids: identity.node_ids }));
      await reportStatus(this.env, "machine", Number(machine.id), { last_seen_at: now(), connected: true });
      for (const node of nodes) {
        await clearNodeDevices(this.env, Number(node.id));
        await this.env.XBOARD_KV.put(`node:ws:target:${node.id}`, `machine:${machine.id}`, { expirationTtl: 86400 });
        await this.env.XBOARD_KV.put(`node:ws:alive:${node.id}`, "1", { expirationTtl: 86400 });
        await this.fullSync(server, node, true);
      }
    } else {
      const configured = await setting(this.env, "server_token");
      const tokenValid = equalText(String(input.token || ""), configured);
      const node = tokenValid ? await getNode(this.env, input.node_id) : null;
      if (!node) {
        this.accept(server, ["invalid"]); server.send(wsMessage("error", { message: tokenValid ? "node not found" : "invalid token" })); server.close(1008, "authentication failed");
        return new Response(null, { status: 101, webSocket: client } as any);
      }
      identity = { mode: "node", node_id: Number(node.id), node_ids: [Number(node.id)] };
      this.replaceConnections();
      this.accept(server, [`node:${node.id}`]);
      (server as any).serializeAttachment?.(identity);
      server.send(wsMessage("auth.success", { node_id: Number(node.id) }));
      await clearNodeDevices(this.env, Number(node.id));
      await this.env.XBOARD_KV.put(`node:ws:target:${node.id}`, `node:${node.id}`, { expirationTtl: 86400 });
      await this.env.XBOARD_KV.put(`node:ws:alive:${node.id}`, "1", { expirationTtl: 86400 });
      await this.fullSync(server, node, false);
    }
    await this.state.storage.setAlarm(Date.now() + 55000);
    return new Response(null, { status: 101, webSocket: client } as any);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    let input: Row;
    try { input = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); } catch { return; }
    const identity = this.attachment(socket);
    const event = String(input.event || "");
    const data = input.data && typeof input.data === "object" ? input.data as Row : {};
    const nodeIds: number[] = Array.isArray(identity.node_ids) ? identity.node_ids.map(Number) : [];
    if (event === "pong") {
      for (const nodeId of nodeIds) {
        const target = identity.mode === "machine" ? `machine:${identity.machine_id}` : `node:${nodeId}`;
        await optionalKvPut(this.env, `node:ws:alive:${nodeId}`, "1", { expirationTtl: 86400 });
        await optionalKvPut(this.env, `node:ws:target:${nodeId}`, target, { expirationTtl: 86400 });
      }
      return;
    }
    const nodeId = identity.mode === "machine" ? Number(data.node_id) : Number(identity.node_id);
    if (!nodeId || !nodeIds.includes(nodeId)) return;
    const node = await getNode(this.env, nodeId);
    if (!node) return;
    if (event === "node.status") {
      await touchNode(this.env, node);
      const status = data.status ?? (data.mem && data.disk ? data : null);
      const metrics = data.metrics ?? data;
      if (status) await processStatus(this.env, node, status);
      await processMetrics(this.env, node, metrics);
    }
    if (event === "report.devices") await processAlive(this.env, nodeId, data.devices ?? data);
    if (event === "request.devices") socket.send(wsMessage("sync.devices", { users: await aggregateDevices(this.env, await nodeUsers(this.env, node)), ...(identity.mode === "machine" ? { node_id: nodeId } : {}) }));
  }

  async webSocketClose(socket: WebSocket) {
    this.localSockets.delete(socket);
    const identity = this.attachment(socket);
    if (this.sockets().some(candidate => candidate !== socket)) return;
    const nodeIds: number[] = Array.isArray(identity.node_ids) ? identity.node_ids.map(Number) : [];
    for (const nodeId of nodeIds) {
      const expectedTarget = identity.mode === "machine" ? `machine:${identity.machine_id}` : `node:${nodeId}`;
      if (await optionalKvGet(this.env, `node:ws:target:${nodeId}`) !== expectedTarget) continue;
      await optionalKvDelete(this.env, `node:ws:target:${nodeId}`);
      await optionalKvDelete(this.env, `node:ws:alive:${nodeId}`);
      await clearNodeDevices(this.env, nodeId);
      await reportStatus(this.env, "node", nodeId, { connected: false, disconnected_at: now() });
    }
    if (identity.mode === "machine" && Number(identity.machine_id) > 0) {
      await reportStatus(this.env, "machine", Number(identity.machine_id), { connected: false, disconnected_at: now() });
    }
  }

  async alarm() {
    const sockets = this.sockets();
    for (const socket of sockets) socket.send(JSON.stringify({ event: "ping" }));
    if (sockets.length) await this.state.storage.setAlarm(Date.now() + 55000);
  }
}

type RouteHandler = (request: Request, env: Env, input: Row) => Promise<Response>;

const routes = new Map<string, RouteHandler>();

for (const action of ["config", "user", "push", "alive", "alivelist", "status"]) {
  const method = ["config", "user", "alivelist"].includes(action) ? "GET" : "POST";
  routes.set(`${method} /api/v1/server/UniProxy/${action}`, async (request, env, input) => {
    const auth = await authenticateV1(env, input);
    return auth instanceof Response ? auth : handleUniProxy(request, env, action, auth);
  });
  routes.set(`${method} /api/v2/server/${action}`, async (request, env, input) => {
    const auth = await authenticateV2(env, input);
    return auth instanceof Response ? auth : handleUniProxy(request, env, action, auth);
  });
}

for (const [family, type, actions] of [
  ["ShadowsocksTidalab", "shadowsocks", ["user", "submit"]],
  ["TrojanTidalab", "trojan", ["config", "user", "submit"]]
] as const) {
  for (const action of actions) {
    const method = action === "user" || action === "config" ? "GET" : "POST";
    routes.set(`${method} /api/v1/server/${family}/${action}`, async (request, env, input) => {
      const auth = await authenticateV1(env, input, type);
      return auth instanceof Response ? auth : handleTidalab(request, env, family, action, auth);
    });
  }
}

routes.set("GET /api/v2/server/handshake", async (request, env, input) => {
  const auth = await authenticateV2(env, input, true);
  if (auth instanceof Response) return auth;
  const enabled = booleanSetting(await setting(env, "server_ws_enable", "1"), true);
  if (!enabled) return json({ websocket: { enabled: false } });
  const custom = (await setting(env, "server_ws_url", "")).trim();
  const url = new URL(request.url);
  return json({ websocket: { enabled: true, ws_url: custom ? custom.replace(/\/$/, "") : `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/ws` } });
});
routes.set("POST /api/v2/server/handshake", routes.get("GET /api/v2/server/handshake")!);

routes.set("POST /api/v2/server/report", async (_request, env, input) => {
  const auth = await authenticateV2(env, input);
  if (auth instanceof Response) return auth;
  const node = auth.node!;
  await touchNode(env, node);
  if (input.traffic && typeof input.traffic === "object") await enqueueTraffic(env, node, input.traffic);
  if (input.alive && typeof input.alive === "object") await processAlive(env, Number(node.id), input.alive);
  if (input.online && typeof input.online === "object") await reportStatus(env, "node", Number(node.id), {
    machine_id: Number(node.machine_id || 0) || null,
    connections: input.online
  });
  if (input.status && typeof input.status === "object") await processStatus(env, node, input.status);
  if (input.metrics && typeof input.metrics === "object") await processMetrics(env, node, input.metrics);
  return json({ data: true });
});

routes.set("POST /api/v2/server/machine/nodes", async (_request, env, input) => {
  const auth = await authenticateMachineEndpoint(env, input);
  if (auth instanceof Response) return auth;
  await reportStatus(env, "machine", Number(auth.machine!.id), { last_seen_at: now() });
  return json(await machineNodes(env, auth.machine!));
});

routes.set("POST /api/v2/server/machine/status", async (_request, env, input) => {
  const failure = validateStatus(input, true);
  if (failure) return failure;
  const auth = await authenticateMachineEndpoint(env, input);
  if (auth instanceof Response) return auth;
  await saveMachineStatus(env, auth.machine!, input);
  return json({ data: true });
});

export const REGISTERED_HTTP_ROUTES = [...routes.keys()];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ data: { service: "xboard-server", time: now() } });
    if (url.pathname === "/internal/settings/invalidate" && request.method === "POST") {
      const rows = await env.XBOARD_DB.prepare("SELECT name, value FROM v2_settings WHERE name IN ('internal_sync_token', 'server_token')").all<{ name: string; value: string }>();
      const values = Object.fromEntries((rows.results || []).map(row => [row.name, row.value]));
      const configuredToken = String(values.internal_sync_token || values.server_token || "").trim();
      if (!configuredToken || request.headers.get("x-xboard-internal-token") !== configuredToken) return json({ message: "Unauthorized" }, 401);
      invalidateSettingsCache();
      return json({ data: true });
    }
    if (url.pathname.startsWith("/internal/status/")) {
      const configuredToken = await internalToken(env);
      if (!configuredToken || request.headers.get("x-xboard-internal-token") !== configuredToken) return json({ message: "Unauthorized" }, 401);
      const target = new URL(request.url);
      target.hostname = "status-hub.internal";
      target.pathname = `/${url.pathname.slice("/internal/status/".length)}`;
      return statusHub(env).fetch(new Request(target.toString(), request));
    }
    if (url.pathname === "/ws") {
      if (!booleanSetting(await setting(env, "server_ws_enable", "1"), true)) return websocketError("websocket disabled");
      const input: Row = {};
      url.searchParams.forEach((value, key) => { input[key] = value; });
      let name: string;
      if (input.machine_id) {
        const machine = await getMachine(env, input.machine_id, input.token);
        if (!machine || !Number(machine.is_active ?? machine.enabled ?? 1)) return websocketError("invalid machine credentials");
        const nodes = await env.XBOARD_DB.prepare("SELECT id FROM v2_server WHERE machine_id = ? AND enabled = 1").bind(machine.id).all<Row>();
        for (const node of nodes.results || []) await disconnectDo(env, `node:${node.id}`);
        name = `machine:${machine.id}`;
      } else {
        const configured = await setting(env, "server_token");
        if (!input.token || !equalText(String(input.token), configured)) return websocketError("invalid token");
        const node = await getNode(env, input.node_id);
        if (!node) return websocketError("node not found");
        if (Number(node.machine_id) > 0) await disconnectDo(env, `machine:${node.machine_id}`);
        name = `node:${node.id}`;
      }
      return env.NODE_HUB.get(env.NODE_HUB.idFromName(name)).fetch(request);
    }
    if (url.pathname === "/internal/sync" && request.method === "POST") {
      const configuredToken = await internalToken(env);
      if (!configuredToken) return json({ message: "Internal sync token is not configured" }, 500);
      if (request.headers.get("x-xboard-internal-token") !== configuredToken) return json({ message: "Unauthorized" }, 401);
      const input = await readInput(request);
      if (input.scope === "user" && Number(input.user_id) > 0) {
        const sent = await syncUserChange(env, Number(input.user_id), Number(input.old_group_id || 0));
        return json({ data: true, sent });
      } else if (input.scope === "users" && Array.isArray(input.user_ids)) {
        const sent = await syncUsersChange(env, input.user_ids.map(Number));
        return json({ data: true, sent });
      } else if (input.node_id) {
        const node = await getNode(env, input.node_id);
        if (node) await syncNode(env, node);
      } else {
        ctx.waitUntil(syncAll(env));
      }
      return json({ data: true });
    }
    const handler = routes.get(`${request.method} ${url.pathname}`);
    if (!handler) return json({ message: "Not Found" }, 404);
    return handler(request, env, await readInput(request));
  }
};
