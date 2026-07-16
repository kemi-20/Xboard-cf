import type { AnalyticsEngineDataset, D1Database, DurableObjectState, DurableObjectStorage } from "./types.ts";
import { now } from "./compat.ts";
import { primaryDatabase } from "./db.ts";

type UserAggregate = { userId: number; serverId: number; serverType: string; u: number; d: number; rate: number };
type ServerAggregate = { serverId: number; serverType: string; u: number; d: number };
type UserShard = Record<string, UserAggregate>;
type ServerState = Record<string, ServerAggregate>;
type BucketState = { users: Record<string, UserAggregate & { events: number }>; servers: Record<string, ServerAggregate & { events: number }> };
type BatchPayload = { batch_id: string; user_aggregates: UserAggregate[]; server_aggregates: ServerAggregate[]; transfer_used: number; record_at: number; created_at: number };

export interface TrafficStatsEnv {
  XBOARD_DB: D1Database;
  USER_TRAFFIC_ANALYTICS: AnalyticsEngineDataset;
  SERVER_TRAFFIC_ANALYTICS: AnalyticsEngineDataset;
}

const FIVE_MINUTES = 300;
const DAY = 86400;
const USER_SHARDS = 16;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function userKey(value: Pick<UserAggregate, "userId" | "serverId" | "serverType">) {
  return `${value.userId}:${value.serverId}:${value.serverType}`;
}

function serverKey(value: Pick<ServerAggregate, "serverId" | "serverType">) {
  return `${value.serverId}:${value.serverType}`;
}

function userShard(userId: number) {
  return Math.abs(Math.trunc(userId)) % USER_SHARDS;
}

function mergeUser(target: UserShard, value: UserAggregate) {
  const key = userKey(value);
  const current = target[key] || { ...value, u: 0, d: 0 };
  current.u += Number(value.u || 0); current.d += Number(value.d || 0); current.rate = Number(value.rate || 1);
  target[key] = current;
}

function mergeServer(target: ServerState, value: ServerAggregate) {
  const key = serverKey(value);
  const current = target[key] || { ...value, u: 0, d: 0 };
  current.u += Number(value.u || 0); current.d += Number(value.d || 0);
  target[key] = current;
}

async function runAtomic<T>(storage: DurableObjectStorage, closure: (txn: DurableObjectStorage) => Promise<T>) {
  return storage.transaction ? storage.transaction(closure) : closure(storage);
}

export class TrafficStatsHub {
  private state: DurableObjectState;
  private env: TrafficStatsEnv;
  private dayPromises = new Map<number, Promise<void>>();
  private flushChain: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: TrafficStatsEnv) {
    this.state = state;
    this.env = env;
  }

  private async ensureDay(recordAt: number) {
    if (await this.state.storage.get(`initialized:${recordAt}`)) return;
    let pending = this.dayPromises.get(recordAt);
    if (!pending) {
      pending = this.initializeDay(recordAt).finally(() => this.dayPromises.delete(recordAt));
      this.dayPromises.set(recordAt, pending);
    }
    await pending;
  }

  private async initializeDay(recordAt: number) {
    if (await this.state.storage.get(`initialized:${recordAt}`)) return;
    const db = primaryDatabase(this.env.XBOARD_DB);
    const [userRows, serverRows, stat] = await Promise.all([
      db.prepare("SELECT user_id, server_id, server_type, u, d, COALESCE(server_rate, rate, 1) AS rate FROM v2_stat_user WHERE record_at = ? AND COALESCE(record_type, 'd') = 'd'").bind(recordAt).all<Record<string, unknown>>(),
      db.prepare("SELECT server_id, server_type, u, d FROM v2_stat_server WHERE record_at = ? AND COALESCE(record_type, 'd') = 'd'").bind(recordAt).all<Record<string, unknown>>(),
      db.prepare("SELECT transfer_used FROM v2_stat WHERE record_at = ? AND COALESCE(record_type, 'd') = 'd'").bind(recordAt).first<{ transfer_used: number }>()
    ]);
    const shards = Array.from({ length: USER_SHARDS }, () => ({} as UserShard));
    const servers: ServerState = {};
    for (const row of userRows.results || []) {
      const value = { userId: Number(row.user_id), serverId: Number(row.server_id), serverType: String(row.server_type || "unknown"), u: Number(row.u || 0), d: Number(row.d || 0), rate: Number(row.rate || 1) };
      mergeUser(shards[userShard(value.userId)], value);
    }
    for (const row of serverRows.results || []) mergeServer(servers, { serverId: Number(row.server_id), serverType: String(row.server_type || "unknown"), u: Number(row.u || 0), d: Number(row.d || 0) });
    const entries: Record<string, unknown> = { [`daily:server:${recordAt}`]: servers, [`daily:total:${recordAt}`]: Number(stat?.transfer_used || 0), [`initialized:${recordAt}`]: now() };
    shards.forEach((shard, index) => { if (Object.keys(shard).length) entries[`daily:user:${recordAt}:${index}`] = shard; });
    await this.state.storage.put(entries);
  }

  private async process(payload: BatchPayload) {
    if (!payload.batch_id || !Number(payload.record_at)) return json({ message: "Invalid traffic batch" }, 422);
    await this.ensureDay(Number(payload.record_at));
    const bucketStart = Math.floor(Number(payload.created_at || now()) / FIVE_MINUTES) * FIVE_MINUTES;
    const duplicate = await runAtomic(this.state.storage, async storage => {
      if (await storage.get(`processed:${payload.batch_id}`)) return true;
      const involved = [...new Set((payload.user_aggregates || []).map(value => userShard(value.userId)))];
      const shards = new Map<number, UserShard>();
      for (const shard of involved) shards.set(shard, await storage.get<UserShard>(`daily:user:${payload.record_at}:${shard}`) || {});
      const servers = await storage.get<ServerState>(`daily:server:${payload.record_at}`) || {};
      const bucketKey = `bucket:${bucketStart}`;
      const bucket = await storage.get<BucketState>(bucketKey) || { users: {}, servers: {} };
      for (const value of payload.user_aggregates || []) {
        mergeUser(shards.get(userShard(value.userId))!, value);
        const key = userKey(value); const current = bucket.users[key] || { ...value, u: 0, d: 0, events: 0 };
        current.u += Number(value.u || 0); current.d += Number(value.d || 0); current.events++; bucket.users[key] = current;
      }
      for (const value of payload.server_aggregates || []) {
        mergeServer(servers, value);
        const key = serverKey(value); const current = bucket.servers[key] || { ...value, u: 0, d: 0, events: 0 };
        current.u += Number(value.u || 0); current.d += Number(value.d || 0); current.events++; bucket.servers[key] = current;
      }
      const entries: Record<string, unknown> = {
        [`daily:server:${payload.record_at}`]: servers,
        [`daily:total:${payload.record_at}`]: Number(await storage.get<number>(`daily:total:${payload.record_at}`) || 0) + Number(payload.transfer_used || 0),
        [bucketKey]: bucket,
        [`processed:${payload.batch_id}`]: Number(payload.created_at || now())
      };
      for (const [shard, value] of shards) entries[`daily:user:${payload.record_at}:${shard}`] = value;
      await storage.put(entries);
      return false;
    });
    await this.state.storage.setAlarm(Date.now() + FIVE_MINUTES * 1000);
    return json({ data: { accepted: true, duplicate } });
  }

  private async flushBuckets(force = false) {
    const run = this.flushChain.then(() => this.flushBucketsNow(force));
    this.flushChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async flushBucketsNow(force = false) {
    const cutoff = force ? Number.MAX_SAFE_INTEGER : Math.floor(now() / FIVE_MINUTES) * FIVE_MINUTES;
    const buckets = await this.state.storage.list<BucketState>({ prefix: "bucket:" });
    let flushed = 0;
    for (const [key, bucket] of buckets) {
      const bucketStart = Number(key.slice("bucket:".length));
      if (!Number.isFinite(bucketStart) || bucketStart >= cutoff) continue;
      const recordDay = new Date(bucketStart * 1000).toISOString().slice(0, 10);
      for (const value of Object.values(bucket.users || {})) this.env.USER_TRAFFIC_ANALYTICS.writeDataPoint({ indexes: [`user:${value.userId}`], blobs: [value.serverType, String(value.serverId), recordDay, "traffic_queue", "1"], doubles: [value.u, value.d, value.rate, value.events, bucketStart] });
      for (const value of Object.values(bucket.servers || {})) this.env.SERVER_TRAFFIC_ANALYTICS.writeDataPoint({ indexes: [`server:${value.serverType}:${value.serverId}`], blobs: [value.serverType, String(value.serverId), recordDay, "1"], doubles: [value.u, value.d, value.events, bucketStart] });
      await this.state.storage.delete(key);
      flushed++;
    }
    return flushed;
  }

  private async materialize(recordAt?: number, force = false) {
    const last = Number(await this.state.storage.get<number>("materialization:last") || 0);
    if (!force && now() - last < FIVE_MINUTES) return 0;
    let initialized = await this.state.storage.list<number>({ prefix: "initialized:" });
    if (recordAt && !initialized.has(`initialized:${recordAt}`)) {
      await this.ensureDay(recordAt);
      initialized = await this.state.storage.list<number>({ prefix: "initialized:" });
    }
    const days = recordAt ? [recordAt] : [...initialized.keys()].map(key => Number(key.slice("initialized:".length))).filter(Boolean);
    const db = primaryDatabase(this.env.XBOARD_DB);
    let rows = 0;
    for (const day of days) {
      const [userEntries, servers, transferUsed] = await Promise.all([
        this.state.storage.list<UserShard>({ prefix: `daily:user:${day}:` }),
        this.state.storage.get<ServerState>(`daily:server:${day}`),
        this.state.storage.get<number>(`daily:total:${day}`)
      ]);
      const users = [...userEntries.values()].flatMap(shard => Object.values(shard));
      const statements = [
        ...users.map(value => db.prepare(`INSERT INTO v2_stat_user(user_id, server_id, server_type, u, d, rate, server_rate, record_type, record_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'd', ?, ?, ?) ON CONFLICT(user_id, server_id, server_type, record_at) DO UPDATE SET u = excluded.u, d = excluded.d, rate = excluded.rate, server_rate = excluded.server_rate, record_type = 'd', updated_at = excluded.updated_at`).bind(value.userId, value.serverId, value.serverType, value.u, value.d, value.rate, value.rate, day, now(), now())),
        ...Object.values(servers || {}).map(value => db.prepare(`INSERT INTO v2_stat_server(server_id, server_type, u, d, record_type, record_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'd', ?, ?, ?) ON CONFLICT(server_id, server_type, record_at) DO UPDATE SET u = excluded.u, d = excluded.d, record_type = 'd', updated_at = excluded.updated_at`).bind(value.serverId, value.serverType, value.u, value.d, day, now(), now())),
        db.prepare(`INSERT INTO v2_stat(record_at, record_type, user_count, order_count, transfer_used, created_at, updated_at) VALUES (?, 'd', 0, 0, ?, ?, ?) ON CONFLICT(record_at, record_type) DO UPDATE SET transfer_used = excluded.transfer_used, updated_at = excluded.updated_at`).bind(day, Number(transferUsed || 0), now(), now())
      ];
      for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
      await this.state.storage.put(`materialized:${day}`, now());
      rows += statements.length;
    }
    await this.state.storage.put("materialization:last", now());
    return rows;
  }

  private async cleanup() {
    const processed = await this.state.storage.list<number>({ prefix: "processed:" });
    for (const [key, createdAt] of processed) if (Number(createdAt || 0) < now() - 7 * DAY) await this.state.storage.delete(key);
    const initialized = await this.state.storage.list<number>({ prefix: "initialized:" });
    for (const key of initialized.keys()) {
      const day = Number(key.slice("initialized:".length));
      if (day >= now() - 3 * DAY) continue;
      const users = await this.state.storage.list({ prefix: `daily:user:${day}:` });
      for (const storageKey of users.keys()) await this.state.storage.delete(storageKey);
      for (const storageKey of [key, `daily:server:${day}`, `daily:total:${day}`, `materialized:${day}`]) await this.state.storage.delete(storageKey);
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/process" && request.method === "POST") return this.process(await request.json() as BatchPayload);
    if (url.pathname === "/flush" && request.method === "POST") return json({ data: { flushed: await this.flushBuckets(true) } });
    if (url.pathname === "/materialize" && request.method === "POST") {
      const input = await request.json().catch(() => ({})) as { record_at?: number; force?: boolean };
      return json({ data: { rows: await this.materialize(Number(input.record_at || 0) || undefined, input.force === true) } });
    }
    if (url.pathname === "/reset" && request.method === "POST") {
      const entries = await this.state.storage.list();
      for (const key of entries.keys()) await this.state.storage.delete(key);
      return json({ data: { cleared: entries.size } });
    }
    return json({ data: { service: "TrafficStatsHub" } });
  }

  async alarm() {
    try {
      await this.flushBuckets();
      const last = Number(await this.state.storage.get<number>("materialization:last") || 0);
      if (now() - last >= 3600) await this.materialize(undefined, true);
      await this.cleanup();
    } finally {
      const buckets = await this.state.storage.list({ prefix: "bucket:" });
      if (buckets.size) await this.state.storage.setAlarm(Date.now() + FIVE_MINUTES * 1000);
    }
  }
}

export const __test = { userKey, serverKey, userShard, mergeUser, mergeServer };
