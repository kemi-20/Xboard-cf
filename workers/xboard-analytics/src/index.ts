import type { Env, ExecutionContext } from "./types.ts";

type JsonRow = Record<string, unknown>;
type QueryKind = "user-rank" | "server-rank" | "traffic-trend" | "runtime-load" | "runtime-status";

const DATASETS = {
  user: "xboard_user_traffic",
  server: "xboard_server_traffic",
  runtime: "xboard_runtime"
} as const;
const memory = new Map<string, { expiresAt: number; staleAt: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function integer(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function requestShape(input: JsonRow) {
  const now = Math.floor(Date.now() / 1000);
  const start = integer(input.start, now - 86400, 0, now + 86400);
  const end = integer(input.end, now, start + 1, now + 86400);
  const previousStart = integer(input.previous_start, start, 0, start);
  const limit = integer(input.limit, 20, 1, 1000);
  const entityId = input.entity_id === undefined ? null : integer(input.entity_id, 0, 1, Number.MAX_SAFE_INTEGER);
  const interval = integer(input.interval, 300, 300, 86400);
  return { start, end, previousStart, limit, entityId, interval };
}

function queryFor(kind: QueryKind, input: JsonRow) {
  const { start, end, previousStart, limit, entityId, interval } = requestShape(input);
  if (kind === "user-rank") return `SELECT index1 AS entity, sumIf(double1, double5 >= ${start}) AS u, sumIf(double2, double5 >= ${start}) AS d, sumIf(double1 + double2, double5 >= ${start}) AS total, sumIf(double1 + double2, double5 >= ${previousStart} AND double5 < ${start}) AS previous_total FROM ${DATASETS.user} WHERE double5 >= ${previousStart} AND double5 < ${end} GROUP BY entity ORDER BY total DESC LIMIT ${Math.min(100, limit)}`;
  if (kind === "server-rank") return `SELECT blob2 AS server_id, blob1 AS server_type, sumIf(double1, double4 >= ${start}) AS u, sumIf(double2, double4 >= ${start}) AS d, sumIf(double1 + double2, double4 >= ${start}) AS total, sumIf(double1 + double2, double4 >= ${previousStart} AND double4 < ${start}) AS previous_total FROM ${DATASETS.server} WHERE double4 >= ${previousStart} AND double4 < ${end} GROUP BY server_id, server_type ORDER BY total DESC LIMIT ${Math.min(100, limit)}`;
  if (kind === "traffic-trend") {
    const dataset = input.entity_type === "server" ? DATASETS.server : DATASETS.user;
    const timeField = input.entity_type === "server" ? "double4" : "double5";
    const index = input.entity_type === "server" ? `server:${String(input.server_type || "unknown").replace(/[^a-zA-Z0-9_-]/g, "")}:${entityId}` : `user:${entityId}`;
    const filter = entityId ? ` AND index1 = '${index}'` : "";
    return `SELECT intDiv(toUInt32(${timeField}), ${interval}) * ${interval} AS bucket, SUM(double1) AS u, SUM(double2) AS d FROM ${dataset} WHERE ${timeField} >= ${start} AND ${timeField} < ${end}${filter} GROUP BY bucket ORDER BY bucket ASC`;
  }
  if (kind === "runtime-load") return `SELECT double9 AS recorded_at, max(double1) AS cpu, max(double10) AS mem_total, max(double2) AS mem_used, max(double11) AS disk_total, max(double3) AS disk_used, max(double4) AS net_in_speed, max(double5) AS net_out_speed, max(double6) AS connections, max(double7) AS online_users, max(double8) AS latency FROM ${DATASETS.runtime} WHERE index1 = 'machine:${entityId}' AND blob1 = 'load' AND double9 >= ${start} AND double9 < ${end} GROUP BY recorded_at ORDER BY recorded_at DESC LIMIT ${Math.min(1000, limit)}`;
  return `SELECT index1 AS entity, blob1 AS metric_type, double6 AS connections, double7 AS online_users, double8 AS latency, double9 AS recorded_at FROM ${DATASETS.runtime} WHERE double9 >= ${start} AND double9 < ${end} ORDER BY recorded_at DESC LIMIT ${limit}`;
}

async function sql(env: Env, query: string) {
  if (!env.ANALYTICS_API_TOKEN) throw new Error("ANALYTICS_NOT_CONFIGURED");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`, "content-type": "text/plain" },
      body: query,
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`ANALYTICS_HTTP_${response.status}`);
    const payload = await response.json() as { data?: JsonRow[] };
    if (!Array.isArray(payload.data)) throw new Error("ANALYTICS_INVALID_RESPONSE");
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

function cacheKey(kind: QueryKind, input: JsonRow) {
  return `${kind}:${JSON.stringify(requestShape(input))}:${String(input.entity_type || "")}:${String(input.server_type || "")}`;
}

async function cachedQuery(env: Env, kind: QueryKind, input: JsonRow, ttl: number, ctx: ExecutionContext) {
  const key = cacheKey(kind, input);
  const current = Date.now();
  const local = memory.get(key);
  if (local && local.expiresAt > current) return { data: local.value, cache: "memory" };
  const cache = (globalThis as any).caches?.default;
  const request = new Request(`https://xboard-analytics-cache.internal/${encodeURIComponent(key)}`);
  const staleRequest = new Request(`https://xboard-analytics-cache.internal/stale/${encodeURIComponent(key)}`);
  let staleValue: unknown = null;
  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) {
        const value = await hit.json();
        memory.set(key, { value, expiresAt: current + ttl * 1000, staleAt: current + 86400_000 });
        return { data: value, cache: "cache-api" };
      }
    } catch {}
    try {
      const stale = await cache.match(staleRequest);
      if (stale) staleValue = await stale.json();
    } catch {}
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = sql(env, queryFor(kind, input));
    inflight.set(key, pending);
  }
  try {
    const value = await pending;
    memory.set(key, { value, expiresAt: current + ttl * 1000, staleAt: current + 86400_000 });
    if (cache) ctx.waitUntil(Promise.all([
      cache.put(request, new Response(JSON.stringify(value), { headers: { "cache-control": `public, max-age=${ttl}` } })),
      cache.put(staleRequest, new Response(JSON.stringify(value), { headers: { "cache-control": "public, max-age=86400" } }))
    ]).then(() => undefined).catch(() => undefined));
    return { data: value, cache: "miss" };
  } catch (error) {
    if (local && local.staleAt > current) return { data: local.value, cache: "stale", warning: String((error as Error).message || error) };
    if (staleValue !== null) return { data: staleValue, cache: "stale-cache-api", warning: String((error as Error).message || error) };
    throw error;
  } finally {
    inflight.delete(key);
  }
}

function normalize(kind: QueryKind, rows: JsonRow[]) {
  if (kind === "user-rank") return rows.map(row => ({ user_id: Number(String(row.entity || "").replace(/^user:/, "")), u: Number(row.u || 0), d: Number(row.d || 0), total: Number(row.total || 0), previous_total: Number(row.previous_total || 0) }));
  if (kind === "server-rank") return rows.map(row => ({ server_id: Number(row.server_id || 0), server_type: String(row.server_type || ""), u: Number(row.u || 0), d: Number(row.d || 0), total: Number(row.total || 0), previous_total: Number(row.previous_total || 0) }));
  const normalized = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value])));
  return kind === "runtime-load"
    ? normalized.sort((left, right) => Number(left.recorded_at || 0) - Number(right.recorded_at || 0))
    : normalized;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/internal/health") return json({ data: { service: "xboard-analytics", configured: !!env.ANALYTICS_API_TOKEN } });
    const routes: Record<string, { kind: QueryKind; ttl: number }> = {
      "/internal/traffic/rank": { kind: "user-rank", ttl: 60 },
      "/internal/traffic/server-rank": { kind: "server-rank", ttl: 60 },
      "/internal/traffic/trend": { kind: "traffic-trend", ttl: 300 },
      "/internal/runtime/load": { kind: "runtime-load", ttl: 30 },
      "/internal/runtime/status": { kind: "runtime-status", ttl: 30 }
    };
    const route = routes[url.pathname];
    if (!route || request.method !== "POST") return json({ message: "Not Found" }, 404);
    let input: JsonRow;
    try { input = await request.json() as JsonRow; }
    catch { return json({ message: "Invalid JSON" }, 422); }
    try {
      const result = await cachedQuery(env, route.kind, input, route.ttl, ctx);
      return json({ data: normalize(route.kind, result.data as JsonRow[]), meta: { cache: result.cache, warning: result.warning || null } });
    } catch (error) {
      const message = String((error as Error).message || error);
      return json({ message, code: message === "ANALYTICS_NOT_CONFIGURED" ? "ANALYTICS_NOT_CONFIGURED" : "ANALYTICS_UNAVAILABLE" }, 503);
    }
  }
};

export const __test = { requestShape, queryFor, normalize };
