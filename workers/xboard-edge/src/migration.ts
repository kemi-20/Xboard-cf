import type { D1Database, KVNamespace } from "./types";
import { body, fail, now, ok, randomString } from "./compat";

interface MigrationEnv {
  XBOARD_DB: D1Database;
  XBOARD_KV: KVNamespace;
}

type MigrationMode = "merge" | "overwrite";
type MigrationRow = Record<string, unknown>;

const MIGRATION_TABLES = [
  "v2_server_group", "v2_plan", "v2_user", "personal_access_tokens", "v2_server_machine",
  "v2_server_route", "v2_server", "v2_settings", "v2_notice", "v2_knowledge", "v2_ticket",
  "v2_ticket_message", "v2_mail_templates", "v2_invite_code", "v2_mail_log", "v2_plugins",
  "v2_log", "failed_jobs", "v2_order", "v2_payment", "v2_coupon", "v2_commission_log",
  "v2_gift_card_template", "v2_gift_card_code", "v2_gift_card_usage", "v2_stat",
  "v2_stat_user", "v2_stat_server", "v2_admin_audit_log", "v2_traffic_reset_logs",
  "v2_subscribe_templates", "v2_server_machine_load_history"
] as const;

const tableSet = new Set<string>(MIGRATION_TABLES);
const tableOrder = Object.fromEntries(MIGRATION_TABLES.map((table, index) => [table, index]));

const NON_MIGRATABLE_SERVICE_TABLES = new Set(["v2_payment"]);
const NON_MIGRATABLE_MAIL_SETTINGS = new Set([
  "email_driver", "email_host", "email_port", "email_username", "email_password",
  "email_encryption", "email_from_address", "email_from_name", "mail_driver",
  "resend_api_url", "resend_api_key", "resend_from_address", "resend_from_name"
]);

function isNonMigratableSetting(name: unknown) {
  const key = String(name || "").trim().toLowerCase();
  return NON_MIGRATABLE_MAIL_SETTINGS.has(key) || key.startsWith("smtp_") || key.startsWith("payment_") || key.startsWith("pay_");
}

function safeJson(value: unknown, fallback: unknown = {}) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function normalizeMode(value: unknown): MigrationMode {
  return value === "overwrite" ? "overwrite" : "merge";
}

function unixTime(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (/^-?\d+(\.\d+)?$/.test(String(value).trim())) return Math.trunc(Number(value));
  const parsed = Date.parse(String(value).replace(" ", "T") + (/Z$|[+-]\d\d:?\d\d$/.test(String(value)) ? "" : "Z"));
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : null;
}

async function ensureMigrationSchema(env: MigrationEnv) {
  await env.XBOARD_DB.prepare(`CREATE TABLE IF NOT EXISTS v2_migration_runs (
    id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_name TEXT, source_size INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'merge', status TEXT NOT NULL DEFAULT 'running', source_counts TEXT,
    progress TEXT, report TEXT, error TEXT, access_token_hash TEXT, admin_id INTEGER, started_at INTEGER NOT NULL,
    finished_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`).run();
  await env.XBOARD_DB.prepare(`CREATE TABLE IF NOT EXISTS v2_migration_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info',
    table_name TEXT, message TEXT NOT NULL, details TEXT, created_at INTEGER NOT NULL
  )`).run();
  try { await env.XBOARD_DB.prepare("ALTER TABLE v2_migration_runs ADD COLUMN access_token_hash TEXT").run(); } catch { /* Already present. */ }
  await env.XBOARD_DB.prepare("CREATE INDEX IF NOT EXISTS idx_migration_logs_run ON v2_migration_logs(run_id, id)").run();
}

async function tableColumns(db: D1Database, table: string) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<Record<string, unknown>>();
  return (result.results || []).map(column => ({
    name: String(column.name),
    type: String(column.type || "").toUpperCase(),
    notnull: Number(column.notnull || 0),
    defaultValue: column.dflt_value
  }));
}

function normalizedSourceRow(table: string, source: MigrationRow): MigrationRow | null {
  if (NON_MIGRATABLE_SERVICE_TABLES.has(table)) return null;
  if (table === "v2_settings" && isNonMigratableSetting(source.name)) return null;
  if (table === "v2_plugins" && String(source.type || "").toLowerCase() === "payment") return null;
  const row = { ...source };
  if (table === "v2_stat" && row.transfer_used === undefined && row.transfer_used_total !== undefined) row.transfer_used = row.transfer_used_total;
  if (table === "v2_server_machine" && row.enabled === undefined && row.is_active !== undefined) row.enabled = row.is_active;
  if (table === "v2_subscribe_templates") {
    if (row.type === undefined) row.type = row.name || "clash";
    if (row.template === undefined) row.template = row.content || "";
    if (row.enabled === undefined) row.enabled = 1;
  }
  if (table === "v2_commission_log") {
    if (row.amount === undefined && row.get_amount !== undefined) row.amount = row.get_amount;
    if (row.order_id === undefined) row.order_id = null;
  }
  if (table === "v2_user" && row.password_algo == null && /^\$2[aby]\$/.test(String(row.password || ""))) row.password_algo = "bcrypt";
  return row;
}

async function prepareRows(db: D1Database, table: string, sourceRows: MigrationRow[]) {
  const columns = await tableColumns(db, table);
  const columnMap = new Map(columns.map(column => [column.name, column]));
  return sourceRows.flatMap(source => {
    const normalized = normalizedSourceRow(table, source);
    if (!normalized) return [];
    const row: MigrationRow = {};
    for (const [key, raw] of Object.entries(normalized)) {
      const column = columnMap.get(key);
      if (!column) continue;
      let value = raw;
      if (column.type.includes("INT") && key.endsWith("_at")) value = unixTime(raw);
      if (value !== null && typeof value === "object") value = JSON.stringify(value);
      if (typeof value === "boolean") value = value ? 1 : 0;
      row[key] = value;
    }
    return [row];
  });
}

async function logMigration(env: MigrationEnv, runId: string, message: string, table?: string, details?: unknown, level = "info") {
  await env.XBOARD_DB.prepare("INSERT INTO v2_migration_logs(run_id,level,table_name,message,details,created_at) VALUES (?,?,?,?,?,?)")
    .bind(runId, level, table || null, message, details === undefined ? null : JSON.stringify(details), now()).run();
}

async function migrationRun(env: MigrationEnv, runId: string) {
  return env.XBOARD_DB.prepare("SELECT * FROM v2_migration_runs WHERE id = ?").bind(runId).first<Record<string, unknown>>();
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function authorizeMigration(request: Request, env: MigrationEnv, route: string) {
  if (!route.startsWith("/migration/") || route === "/migration/start" || route === "/migration/status") return null;
  const accessToken = request.headers.get("x-migration-token") || "";
  if (!accessToken) return null;
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  if (!runId) return null;
  await ensureMigrationSchema(env);
  const run = await migrationRun(env, runId);
  if (!run || run.status !== "running" || !run.access_token_hash) return null;
  return String(run.access_token_hash) === await sha256(accessToken) ? Number(run.admin_id || 0) : null;
}

async function tableCount(db: D1Database, table: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return Number(row?.count || 0);
}

async function migrationStatus(env: MigrationEnv) {
  await ensureMigrationSchema(env);
  const runs = await env.XBOARD_DB.prepare("SELECT * FROM v2_migration_runs ORDER BY created_at DESC LIMIT 10").all<Record<string, unknown>>();
  const parsed = (runs.results || []).map(run => ({
    ...run,
    source_counts: safeJson(run.source_counts),
    progress: safeJson(run.progress),
    report: safeJson(run.report, null)
  }));
  return ok({ tables: MIGRATION_TABLES, runs: parsed });
}

async function startMigration(request: Request, env: MigrationEnv, adminId: number) {
  const input = await body<Record<string, unknown>>(request);
  const sourceType = input.source_type === "redis" ? "redis" : input.source_type === "xboard" ? "xboard" : "sqlite";
  const sourceCounts = input.source_counts && typeof input.source_counts === "object" ? input.source_counts : {};
  const runId = `${Date.now().toString(36)}-${randomString(16)}`;
  const migrationToken = randomString(48);
  const ts = now();
  await env.XBOARD_DB.prepare("INSERT INTO v2_migration_runs(id,source_type,source_name,source_size,mode,status,source_counts,progress,access_token_hash,admin_id,started_at,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,'{}',?,?,?,?,?)")
    .bind(runId, sourceType, String(input.source_name || ""), Number(input.source_size || 0), normalizeMode(input.mode), JSON.stringify(sourceCounts), await sha256(migrationToken), adminId, ts, ts, ts).run();
  await logMigration(env, runId, `开始 ${sourceType.toUpperCase()} 迁移`, undefined, { source_counts: sourceCounts, mode: normalizeMode(input.mode) });
  return ok({ run_id: runId, migration_token: migrationToken, mode: normalizeMode(input.mode), tables: MIGRATION_TABLES });
}

async function importBatch(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  const table = String(input.table || "");
  const sourceRows = Array.isArray(input.rows) ? input.rows as MigrationRow[] : [];
  if (!runId || !tableSet.has(table)) return fail("无效的迁移批次或数据表", 422, 422);
  if (!sourceRows.length || sourceRows.length > 100) return fail("每批必须包含 1 至 100 行", 422, 422);
  const run = await migrationRun(env, runId);
  if (!run || run.status !== "running" || !["sqlite", "xboard"].includes(String(run.source_type))) return fail("迁移任务不存在或已结束", 409, 409);

  const preparedRows = await prepareRows(env.XBOARD_DB, table, sourceRows);
  const before = await tableCount(env.XBOARD_DB, table);
  const statements = preparedRows.map(row => {
    const columns = Object.keys(row);
    if (!columns.length) throw new Error(`${table} 没有可导入字段`);
    const quoted = columns.map(column => `\`${column.replace(/`/g, "")}\``).join(",");
    const placeholders = columns.map(() => "?").join(",");
    const verb = run.mode === "overwrite" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
    return env.XBOARD_DB.prepare(`${verb} INTO ${table} (${quoted}) VALUES (${placeholders})`).bind(...columns.map(column => row[column]));
  });
  try {
    if (statements.length) await env.XBOARD_DB.batch(statements);
  } catch (error: any) {
    await logMigration(env, runId, "批次写入失败", table, { error: error?.message, rows: sourceRows.length }, "error");
    throw error;
  }
  const after = await tableCount(env.XBOARD_DB, table);
  const progress = safeJson(run.progress) as Record<string, any>;
  const previous = progress[table] || { received: 0, inserted: 0, batches: 0 };
  progress[table] = {
    received: Number(previous.received || 0) + sourceRows.length,
    inserted: Number(previous.inserted || 0) + Math.max(0, after - before),
    skipped: Number(previous.skipped || 0) + sourceRows.length - preparedRows.length,
    batches: Number(previous.batches || 0) + 1,
    target_count: after
  };
  await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET progress = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(progress), now(), runId).run();
  return ok({ table, received: sourceRows.length, inserted: Math.max(0, after - before), skipped: sourceRows.length - preparedRows.length, target_count: after, progress: progress[table] });
}

class PhpValueParser {
  private position = 0;
  constructor(private readonly source: string) {}
  private take(length: number) { const value = this.source.slice(this.position, this.position + length); this.position += length; return value; }
  private until(marker: string) { const end = this.source.indexOf(marker, this.position); if (end < 0) throw new Error("Invalid PHP serialized value"); const value = this.source.slice(this.position, end); this.position = end + marker.length; return value; }
  parse(): any {
    const type = this.take(2);
    if (type === "N;") return null;
    if (type === "b:") return this.until(";") === "1";
    if (type === "i:") return Number(this.until(";"));
    if (type === "d:") return Number(this.until(";"));
    if (type === "s:") {
      const byteLength = Number(this.until(":"));
      if (this.take(1) !== '"') throw new Error("Invalid PHP string");
      let value = "";
      while (new TextEncoder().encode(value).length < byteLength) value += this.take(1);
      if (this.take(2) !== '";') throw new Error("Invalid PHP string terminator");
      return value;
    }
    if (type === "a:") {
      const count = Number(this.until(":"));
      if (this.take(1) !== "{") throw new Error("Invalid PHP array");
      const entries: Array<[any, any]> = [];
      for (let index = 0; index < count; index++) entries.push([this.parse(), this.parse()]);
      if (this.take(1) !== "}") throw new Error("Invalid PHP array terminator");
      const isList = entries.every(([key], index) => key === index);
      return isList ? entries.map(([, value]) => value) : Object.fromEntries(entries.map(([key, value]) => [String(key), value]));
    }
    throw new Error(`Unsupported PHP serialized type ${type}`);
  }
}

function decodeRedisValue(value: unknown) {
  if (typeof value !== "string") return value;
  if (!/^(?:N;|[abdis]:)/.test(value)) return value;
  try { return new PhpValueParser(value).parse(); } catch { return value; }
}

function stripRedisPrefix(key: string) {
  return key
    .replace(/^.*?_database_/, "")
    .replace(/^.*?_cache/, "")
    .replace(/^xboard_cache/, "");
}

function mapRedisEntry(sourceKey: string, sourceValue: unknown) {
  if (/horizon:|framework\/schedule-|EMAIL_VERIFY_CODE_|PASSWORD_ERROR_LIMIT_|REGISTER_IP_RATE_LIMIT_|TEMP_TOKEN_/i.test(sourceKey)) return null;
  const key = stripRedisPrefix(sourceKey);
  const node = key.match(/^SERVER_[A-Z0-9]+_(LAST_CHECK_AT|LAST_PUSH_AT|ONLINE_USER|LOAD_STATUS|METRICS)_(\d+)$/i);
  if (node) {
    const names: Record<string, string> = { LAST_CHECK_AT: "last_check", LAST_PUSH_AT: "last_push", ONLINE_USER: "online", LOAD_STATUS: "load", METRICS: "metrics" };
    const decoded = decodeRedisValue(sourceValue);
    return { key: `node:${names[node[1].toUpperCase()]}:${node[2]}`, value: typeof decoded === "object" ? JSON.stringify(decoded) : String(decoded ?? "") };
  }
  const wsAlive = key.match(/^node_ws_alive:(\d+)$/i);
  if (wsAlive) return { key: `node:ws:alive:${wsAlive[1]}`, value: String(decodeRedisValue(sourceValue) ?? "") };
  if (key === "traffic:pending_check") return { key, value: JSON.stringify(decodeRedisValue(sourceValue) ?? []) };
  if (key === "SCHEDULE_LAST_CHECK_AT") return { key: "schedule:last_run:legacy", value: String(decodeRedisValue(sourceValue) ?? "") };
  return null;
}

async function importRedis(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  const entries = Array.isArray(input.entries) ? input.entries as Array<{ key?: unknown; value?: unknown }> : [];
  if (!runId || !entries.length || entries.length > 100) return fail("每批必须包含 1 至 100 个 Redis 键", 422, 422);
  const run = await migrationRun(env, runId);
  if (!run || run.status !== "running" || !["redis", "xboard"].includes(String(run.source_type))) return fail("迁移任务不存在或已结束", 409, 409);
  let imported = 0;
  let skipped = 0;
  for (const entry of entries) {
    const mapped = mapRedisEntry(String(entry.key || ""), entry.value);
    if (!mapped) { skipped++; continue; }
    await env.XBOARD_KV.put(mapped.key, mapped.value, { expirationTtl: 3600 });
    imported++;
  }
  const progress = safeJson(run.progress) as Record<string, any>;
  progress.redis = {
    received: Number(progress.redis?.received || 0) + entries.length,
    imported: Number(progress.redis?.imported || 0) + imported,
    skipped: Number(progress.redis?.skipped || 0) + skipped,
    batches: Number(progress.redis?.batches || 0) + 1
  };
  await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET progress = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(progress), now(), runId).run();
  return ok({ imported, skipped, progress: progress.redis });
}

async function finishMigration(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  const run = await migrationRun(env, runId);
  if (!run || run.status !== "running") return fail("迁移任务不存在或已结束", 409, 409);
  const sourceCounts = safeJson(run.source_counts) as Record<string, number>;
  const progress = safeJson(run.progress) as Record<string, any>;
  const counts: Record<string, number> = {};
  const warnings: string[] = [];
  if (run.source_type !== "redis") {
    for (const table of MIGRATION_TABLES) {
      if (sourceCounts[table] === undefined) continue;
      counts[table] = await tableCount(env.XBOARD_DB, table);
      const received = Number(progress[table]?.received || 0);
      if (received !== Number(sourceCounts[table])) warnings.push(`${table}: 源库 ${sourceCounts[table]} 行，实际接收 ${received} 行`);
    }
  }
  const report = {
    source_type: run.source_type,
    mode: run.mode,
    source_counts: sourceCounts,
    target_counts: counts,
    progress,
    warnings,
    skipped_service_config: ["原 SMTP/邮件驱动设置", "Resend 凭据", "支付渠道及支付插件配置"]
  };
  const ts = now();
  await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET status = 'completed', report = ?, access_token_hash = NULL, finished_at = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(report), ts, ts, runId).run();
  for (const key of ["settings:all", "settings_version", "servers_version"]) {
    try { await env.XBOARD_KV.delete(key); } catch { /* D1 remains authoritative. */ }
  }
  try {
    await env.XBOARD_KV.put("settings_version", String(Date.now()));
    await env.XBOARD_KV.put("servers_version", String(Date.now()));
  } catch { /* Cache invalidation is best effort. */ }
  await logMigration(env, runId, "迁移完成", undefined, report, warnings.length ? "warning" : "info");
  return ok(report);
}

export async function handleAdminMigration(request: Request, env: MigrationEnv, route: string, adminId: number) {
  await ensureMigrationSchema(env);
  if (route === "/migration/status" && request.method === "GET") return migrationStatus(env);
  if (route === "/migration/start" && request.method === "POST") return startMigration(request, env, adminId);
  if (route === "/migration/batch" && request.method === "POST") return importBatch(request, env);
  if (route === "/migration/redis/import" && request.method === "POST") return importRedis(request, env);
  if (route === "/migration/finish" && request.method === "POST") return finishMigration(request, env);
  return null;
}

export function migrationTables() { return [...MIGRATION_TABLES].sort((a, b) => tableOrder[a] - tableOrder[b]); }
