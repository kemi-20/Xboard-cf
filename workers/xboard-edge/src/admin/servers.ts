import { cachedData } from "../cache.ts";
import { fail, now, ok } from "../compat.ts";
import { rows } from "../db.ts";
import type { StatusSnapshot } from "../internal/status-client.ts";
import type { D1Database } from "../types.ts";

type ServerEnv = { XBOARD_DB: D1Database };

export type ServerDeps<E extends ServerEnv> = {
  optionalKvGet: (env: E, key: string) => Promise<string | null>;
  parseJsonArray: (value: unknown) => any[];
  parseJsonObject: (value: unknown) => Record<string, any>;
  routeMatchArray: (value: unknown) => string[];
  isNilLike: (value: unknown) => boolean;
  nullableNumber: (value: unknown) => number | null;
  statusSnapshot: (env: E) => Promise<StatusSnapshot>;
  machineHistory: (env: E, machineId: number, limit: number, rangeHours: number | null) => Promise<Record<string, unknown>[] | null>;
};

export async function groupById(env: ServerEnv, id: unknown) {
  if (!id) return null;
  return env.XBOARD_DB.prepare("SELECT id, name FROM v2_server_group WHERE id = ?").bind(id).first();
}

export async function adminServerGroupRows<E extends ServerEnv>(env: E, deps: ServerDeps<E>) {
  const version = await deps.optionalKvGet(env, "servers_version") || "0";
  return cachedData(`admin-server-groups:${version}`, 60, async () => {
    const [groupsResult, usersResult, serversResult] = await Promise.all([
      env.XBOARD_DB.prepare("SELECT * FROM v2_server_group ORDER BY id DESC").all<Record<string, any>>(),
      env.XBOARD_DB.prepare("SELECT group_id, COUNT(*) AS count FROM v2_user WHERE group_id IS NOT NULL GROUP BY group_id").all<{ group_id: number; count: number }>(),
      env.XBOARD_DB.prepare("SELECT group_ids FROM v2_server").all<{ group_ids: string | null }>()
    ]);
    const userCounts = new Map((usersResult.results || []).map(row => [Number(row.group_id), Number(row.count || 0)]));
    const serverCounts = new Map<number, number>();
    for (const server of serversResult.results || []) {
      for (const groupId of new Set(deps.parseJsonArray(server.group_ids).map(Number).filter(Number.isFinite))) {
        serverCounts.set(groupId, (serverCounts.get(groupId) || 0) + 1);
      }
    }
    return (groupsResult.results || []).map(group => ({
      ...group,
      users_count: userCounts.get(Number(group.id)) || 0,
      server_count: serverCounts.get(Number(group.id)) || 0
    }));
  }, 180);
}

export async function adminRouteRows<E extends ServerEnv>(env: E, deps: ServerDeps<E>) {
  const version = await deps.optionalKvGet(env, "servers_version") || "0";
  return cachedData(`admin-routes:${version}`, 300, async () => {
    const routes = await rows(env.XBOARD_DB, "v2_server_route", 1000) as any[];
    return routes.map(route => ({ ...route, match: deps.routeMatchArray(route.match) }));
  }, 900);
}

export function statusTimeout(interval: unknown) {
  const seconds = Math.max(60, Math.min(3600, Number(interval) || 300));
  return Math.max(360, Math.ceil(seconds * 1.5), seconds + 60);
}

export function nodeAvailableStatus(lastCheckAt: number | null, lastPushAt: number | null, timestamp = now(), pullInterval: unknown = 300, pushInterval: unknown = 300) {
  if (!lastCheckAt || timestamp - statusTimeout(pullInterval) >= lastCheckAt) return 0;
  if (!lastPushAt || timestamp - statusTimeout(pushInterval) >= lastPushAt) return 1;
  return 2;
}

export function normalizePublicPort(value: unknown) {
  const port = String(value ?? "").trim();
  return /^\d+\.0+$/.test(port) ? port.slice(0, port.indexOf(".")) : port;
}

export async function adminServerRows<E extends ServerEnv>(env: E, deps: ServerDeps<E>): Promise<Record<string, any>[]> {
  const version = await deps.optionalKvGet(env, "servers_version") || "0";
  const [base, live] = await Promise.all([
    cachedData(`admin-server-base:${version}`, 300, async () => {
      const [serverResult, machineResult, groupResult, intervalResult] = await Promise.all([
        env.XBOARD_DB.prepare("SELECT * FROM v2_server ORDER BY sort ASC, id ASC LIMIT 1000").all<Record<string, any>>(),
        env.XBOARD_DB.prepare("SELECT * FROM v2_server_machine ORDER BY id ASC LIMIT 1000").all<Record<string, any>>(),
        env.XBOARD_DB.prepare("SELECT * FROM v2_server_group ORDER BY id ASC LIMIT 1000").all<Record<string, any>>(),
        env.XBOARD_DB.prepare("SELECT name, value FROM v2_settings WHERE name IN ('server_pull_interval', 'server_push_interval')").all<{ name: string; value: string }>()
      ]);
      const intervals = Object.fromEntries((intervalResult.results || []).map(row => [row.name, row.value]));
      return { servers: serverResult.results || [], machines: machineResult.results || [], groups: groupResult.results || [], intervals };
    }, 900),
    deps.statusSnapshot(env)
  ]);
  const { servers, machines, groups: groupRows, intervals } = base;
  const groupMap = new Map(groupRows.map(group => [Number(group.id), group]));
  const machineById = new Map(machines.map(machine => [Number(machine.id), machine]));
  const serverById = new Map(servers.map(server => [Number(server.id), server]));
  const out = [];
  for (const server of servers) {
    const stateId = Number(server.parent_id || server.id);
    const ownId = Number(server.id);
    const machine = Number(server.machine_id) > 0 ? machineById.get(Number(server.machine_id)) || null : null;
    const nodeState = live.nodes[String(stateId)] || (stateId !== ownId ? live.nodes[String(ownId)] : null) || {};
    const machineState = machine ? live.machines[String(machine.id)] || {} : {};
    const reportedAt = Number(machineState.last_seen_at || 0);
    const disconnectedAt = Number(machineState.disconnected_at || 0);
    const machineDisconnected = machineState.connected === false && disconnectedAt >= reportedAt;
    const machineSeenAt = machine && Number(machine.is_active ?? machine.enabled ?? 1) === 1 && !machineDisconnected ? reportedAt : 0;
    const machineOnline = machineSeenAt > 0 && now() - Math.max(statusTimeout(intervals.server_pull_interval), statusTimeout(intervals.server_push_interval)) < machineSeenAt;
    const lastCheckAt = Math.max(Number(nodeState.last_check_at || 0), machineOnline ? machineSeenAt : 0) || null;
    const lastPushAt = Math.max(Number(nodeState.last_push_at || 0), machineOnline ? machineSeenAt : 0) || null;
    const availableStatus = nodeAvailableStatus(lastCheckAt, lastPushAt, now(), intervals.server_pull_interval, intervals.server_push_interval);
    const rawLoadStatus = nodeState.load_status || machineState.load_status || null;
    const loadStatus = rawLoadStatus && typeof rawLoadStatus === "object" && !Array.isArray(rawLoadStatus)
      ? rawLoadStatus as Record<string, unknown>
      : null;
    const embeddedMetrics = loadStatus?.metrics;
    const rawMetrics = nodeState.metrics || (embeddedMetrics && typeof embeddedMetrics === "object" && !Array.isArray(embeddedMetrics) ? embeddedMetrics : null);
    const metrics = rawMetrics && typeof rawMetrics === "object" && !Array.isArray(rawMetrics)
      ? rawMetrics as Record<string, unknown>
      : null;
    const groupIds = deps.parseJsonArray(server.group_ids);
    const groups = groupIds.map(id => groupMap.get(Number(id))).filter(Boolean);
    out.push({
      ...server,
      port: normalizePublicPort(server.port),
      show: Boolean(Number(server.show ?? 1)),
      enabled: Boolean(Number(server.enabled ?? 1)),
      rate_time_enable: Boolean(Number(server.rate_time_enable || 0)),
      rate_time_ranges: deps.parseJsonArray(server.rate_time_ranges),
      group_ids: groupIds,
      route_ids: deps.parseJsonArray(server.route_ids),
      tags: deps.parseJsonArray(server.tags),
      protocol_settings: deps.parseJsonObject(server.protocol_settings),
      custom_outbounds: deps.parseJsonArray(server.custom_outbounds),
      custom_routes: deps.parseJsonArray(server.custom_routes),
      cert_config: deps.isNilLike(server.cert_config) ? null : deps.parseJsonObject(server.cert_config),
      groups,
      parent: server.parent_id ? serverById.get(Number(server.parent_id)) || null : null,
      machine: machine ? { ...machine, token: undefined, load_status: loadStatus } : null,
      last_check_at: lastCheckAt,
      last_push_at: lastPushAt,
      online: Number(nodeState.online || 0),
      is_online: availableStatus === 0 ? 0 : 1,
      available_status: availableStatus,
      cache_key: `${server.type}-${server.id}-${server.updated_at}-${availableStatus === 0 ? 0 : 1}`,
      load_status: loadStatus,
      metrics,
      online_conn: Number(metrics?.active_connections || 0)
    });
  }
  return out;
}

export async function adminMachineRows<E extends ServerEnv>(env: E, deps: ServerDeps<E>) {
  const version = await deps.optionalKvGet(env, "servers_version") || "0";
  const [base, live] = await Promise.all([
    cachedData(`admin-machine-base:${version}`, 300, async () => {
      const [machines, counts] = await Promise.all([
        env.XBOARD_DB.prepare("SELECT * FROM v2_server_machine ORDER BY id ASC LIMIT 1000").all<Record<string, any>>(),
        env.XBOARD_DB.prepare("SELECT machine_id, COUNT(*) AS count FROM v2_server WHERE machine_id IS NOT NULL GROUP BY machine_id").all<{ machine_id: number; count: number }>()
      ]);
      return { machines: machines.results || [], counts: Object.fromEntries((counts.results || []).map(row => [String(row.machine_id), Number(row.count || 0)])) };
    }, 900),
    deps.statusSnapshot(env)
  ]);
  const out = [];
  for (const machine of base.machines) {
    const { token: _token, ...safeMachine } = machine;
    const machineState = live.machines[String(machine.id)] || {};
    out.push({
      ...safeMachine,
      notes: machine.notes || "",
      is_active: Boolean(Number(machine.is_active ?? machine.enabled ?? 1)),
      last_seen_at: machineState.last_seen_at || null,
      load_status: machineState.load_status || null,
      servers_count: Number(base.counts[String(machine.id)] || 0)
    });
  }
  return out;
}

export async function adminMachineHistory<E extends ServerEnv>(env: E, url: URL, deps: ServerDeps<E>) {
  const machineIdValue = url.searchParams.get("machine_id") || url.searchParams.get("id");
  const limitValue = url.searchParams.get("limit");
  const rangeRaw = url.searchParams.get("range_hours") || url.searchParams.get("range");
  const rangeHoursValue = rangeRaw?.match(/^\d+h$/) ? rangeRaw.slice(0, -1) : rangeRaw;
  const machineId = deps.nullableNumber(machineIdValue);
  const limit = limitValue === null || limitValue === "" ? 60 : deps.nullableNumber(limitValue);
  const rangeHours = rangeHoursValue === null || rangeHoursValue === "" ? null : deps.nullableNumber(rangeHoursValue);
  if (!machineId || !Number.isInteger(machineId)) return fail("machine_id 字段是必须的", 422, 422);
  if (!limit || !Number.isInteger(limit) || limit < 10 || limit > 1440) return fail("limit 必须在 10 到 1440 之间", 422, 422);
  if (rangeHours !== null && (!Number.isInteger(rangeHours) || rangeHours < 1 || rangeHours > 24)) return fail("range_hours 必须在 1 到 24 之间", 422, 422);
  const machine = await env.XBOARD_DB.prepare("SELECT id FROM v2_server_machine WHERE id = ?").bind(machineId).first();
  if (!machine) return fail("服务器不存在", 422, 422);
  const statusRows = await deps.machineHistory(env, machineId, limit, rangeHours);
  if (!statusRows) return fail("获取服务器负载历史失败", 500, 500);
  return ok(statusRows
    .sort((left, right) => Number(left.recorded_at || 0) - Number(right.recorded_at || 0))
    .slice(-limit));
}
