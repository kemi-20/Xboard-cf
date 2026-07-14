import type { D1Database, KVNamespace } from "./types";
import { body, fail, json, now, ok, randomString } from "./compat";

interface MigrationEnv {
  XBOARD_DB: D1Database;
  XBOARD_KV: KVNamespace;
}

type MigrationMode = "merge" | "overwrite";
type MigrationRow = Record<string, unknown>;

type MigrationStatus = "running" | "failed" | "rolling_back" | "rollback_failed" | "rolled_back" | "completed";

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
const DELETE_TABLES = [...MIGRATION_TABLES].reverse();

const NON_MIGRATABLE_SERVICE_TABLES = new Set(["v2_payment"]);
const NON_MIGRATABLE_MAIL_SETTINGS = new Set([
  "email_driver", "email_host", "email_port", "email_username", "email_password",
  "email_encryption", "email_from_address", "email_from_name", "mail_driver",
  "resend_api_url", "resend_api_key", "resend_from_address", "resend_from_name"
]);
const DEFAULT_THEME_SETTINGS = new Set(["frontend_theme", "current_theme"]);

function isThemeSetting(name: unknown) {
  const key = String(name || "").trim().toLowerCase();
  return DEFAULT_THEME_SETTINGS.has(key) || key.startsWith("theme_") || key.startsWith("frontend_theme_");
}

function isNonMigratableSetting(name: unknown) {
  const key = String(name || "").trim().toLowerCase();
  return NON_MIGRATABLE_MAIL_SETTINGS.has(key) || key.startsWith("smtp_") || key.startsWith("payment_") || key.startsWith("pay_") || isThemeSetting(key);
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
    progress TEXT, report TEXT, error TEXT, access_token_hash TEXT, admin_id INTEGER, snapshot_counts TEXT,
    snapshot_complete INTEGER NOT NULL DEFAULT 0, prepared_at INTEGER, rollback_progress TEXT, started_at INTEGER NOT NULL,
    finished_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`).run();
  await env.XBOARD_DB.prepare(`CREATE TABLE IF NOT EXISTS v2_migration_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info',
    table_name TEXT, message TEXT NOT NULL, details TEXT, created_at INTEGER NOT NULL
  )`).run();
  try { await env.XBOARD_DB.prepare("ALTER TABLE v2_migration_runs ADD COLUMN access_token_hash TEXT").run(); } catch { /* Already present. */ }
  for (const statement of [
    "ALTER TABLE v2_migration_runs ADD COLUMN snapshot_counts TEXT",
    "ALTER TABLE v2_migration_runs ADD COLUMN snapshot_complete INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE v2_migration_runs ADD COLUMN prepared_at INTEGER",
    "ALTER TABLE v2_migration_runs ADD COLUMN rollback_progress TEXT"
  ]) {
    try { await env.XBOARD_DB.prepare(statement).run(); } catch { /* Already present. */ }
  }
  await env.XBOARD_DB.prepare(`CREATE TABLE IF NOT EXISTS v2_migration_snapshot_rows (
    run_id TEXT NOT NULL, table_name TEXT NOT NULL, row_index INTEGER NOT NULL, row_data TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(run_id, table_name, row_index)
  )`).run();
  await env.XBOARD_DB.prepare(`CREATE TABLE IF NOT EXISTS v2_migration_kv_snapshots (
    run_id TEXT NOT NULL, key_name TEXT NOT NULL, existed INTEGER NOT NULL DEFAULT 0, value TEXT,
    created_at INTEGER NOT NULL, PRIMARY KEY(run_id, key_name)
  )`).run();
  await env.XBOARD_DB.prepare("CREATE INDEX IF NOT EXISTS idx_migration_logs_run ON v2_migration_logs(run_id, id)").run();
  await env.XBOARD_DB.prepare("CREATE INDEX IF NOT EXISTS idx_migration_snapshot_run_table ON v2_migration_snapshot_rows(run_id, table_name, row_index)").run();
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

function migrationError(message: string, status: number, details: Record<string, unknown> = {}) {
  return json({ message, errors: message, code: status, details }, status);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

function exportRow(table: string, source: MigrationRow): MigrationRow | null {
  if (table === "v2_payment") return null;
  if (table === "v2_plugins" && String(source.type || "").toLowerCase() === "payment") return null;
  const row = { ...source };
  if (table === "v2_settings") {
    const name = String(row.name || "").trim().toLowerCase();
    if (isThemeSetting(name)) {
      if (!DEFAULT_THEME_SETTINGS.has(name)) return null;
      row.value = "Xboard";
    }
    if (NON_MIGRATABLE_MAIL_SETTINGS.has(name) || name.startsWith("smtp_")) row.value = "";
    if (name.startsWith("payment_") || name.startsWith("pay_")) return null;
  }
  if (table === "v2_stat" && row.transfer_used_total === undefined) row.transfer_used_total = row.transfer_used ?? "0";
  if (table === "v2_server_machine" && row.is_active === undefined) row.is_active = row.enabled ?? 1;
  if (table === "v2_subscribe_templates" && row.content === undefined) row.content = row.template ?? "";
  if (table === "v2_commission_log") {
    if (row.get_amount === undefined) row.get_amount = row.amount ?? 0;
    if (row.invite_user_id === undefined) row.invite_user_id = row.user_id ?? 0;
    if (row.order_amount === undefined) row.order_amount = 0;
    if (row.trade_no === undefined) row.trade_no = "";
  }
  return row;
}

async function exactRows(db: D1Database, table: string, sourceRows: MigrationRow[]) {
  const columns = await tableColumns(db, table);
  const columnSet = new Set(columns.map(column => column.name));
  return sourceRows.map(source => Object.fromEntries(Object.entries(source).filter(([key]) => columnSet.has(key))));
}

async function readTableRows(db: D1Database, table: string, limit: number, offset: number) {
  const columns = await tableColumns(db, table);
  const order = columns.some(column => column.name === "id") ? " ORDER BY id ASC" : "";
  const result = await db.prepare(`SELECT * FROM ${table}${order} LIMIT ? OFFSET ?`).bind(limit, offset).all<MigrationRow>();
  return result.results || [];
}

async function allTableCounts(db: D1Database) {
  const counts: Record<string, number> = {};
  for (const table of MIGRATION_TABLES) counts[table] = await tableCount(db, table);
  return counts;
}

async function setDefaultTheme(db: D1Database) {
  const ts = now();
  await db.batch([
    db.prepare("DELETE FROM v2_settings WHERE lower(name) LIKE 'theme_%' OR lower(name) LIKE 'frontend_theme_%' OR lower(name) IN ('frontend_theme','current_theme')"),
    db.prepare("INSERT INTO v2_settings(name,value,created_at,updated_at) VALUES ('frontend_theme','Xboard',?,?)").bind(ts, ts),
    db.prepare("INSERT INTO v2_settings(name,value,created_at,updated_at) VALUES ('current_theme','Xboard',?,?)").bind(ts, ts)
  ]);
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
  if (table === "v2_coupon") row.type = Math.trunc(Number.parseFloat(String(row.type ?? 0)));
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

async function markMigrationFailed(env: MigrationEnv, runId: string, message: string, details: Record<string, unknown> = {}) {
  const ts = now();
  const error = { message, ...details, failed_at: ts };
  await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(error), ts, ts, runId).run();
  await logMigration(env, runId, message, String(details.table || "") || undefined, details, "error");
  return error;
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
  const allowedStatuses: MigrationStatus[] = ["running", "failed", "rolling_back", "rollback_failed"];
  if (!run || !allowedStatuses.includes(String(run.status) as MigrationStatus) || !run.access_token_hash) return null;
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
    snapshot_counts: safeJson(run.snapshot_counts),
    progress: safeJson(run.progress),
    rollback_progress: safeJson(run.rollback_progress),
    report: safeJson(run.report, null),
    error: safeJson(run.error, run.error || null)
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
  const snapshotCounts = await allTableCounts(env.XBOARD_DB);
  await env.XBOARD_DB.prepare("INSERT INTO v2_migration_runs(id,source_type,source_name,source_size,mode,status,source_counts,progress,access_token_hash,admin_id,snapshot_counts,snapshot_complete,started_at,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,'{}',?,?,?,0,?,?,?)")
    .bind(runId, sourceType, String(input.source_name || ""), Number(input.source_size || 0), normalizeMode(input.mode), JSON.stringify(sourceCounts), await sha256(migrationToken), adminId, JSON.stringify(snapshotCounts), ts, ts, ts).run();
  await logMigration(env, runId, `开始 ${sourceType.toUpperCase()} 迁移，等待迁移前快照`, undefined, { source_counts: sourceCounts, snapshot_counts: snapshotCounts, mode: normalizeMode(input.mode) });
  return ok({ run_id: runId, migration_token: migrationToken, mode: normalizeMode(input.mode), tables: MIGRATION_TABLES, backup_counts: snapshotCounts });
}

async function exportManifest(env: MigrationEnv) {
  return ok({
    format: "xboard-sqlite3",
    template: "/migration/xboard-template.db",
    tables: MIGRATION_TABLES,
    counts: await allTableCounts(env.XBOARD_DB),
    excluded: ["邮件与 Resend 凭据会导出为空值", "支付渠道和支付插件不会导出", "主题固定为 Xboard 默认主题"]
  });
}

async function exportTable(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const table = String(input.table || "");
  const limit = Math.min(100, Math.max(1, Number(input.limit || 100)));
  const offset = Math.max(0, Number(input.offset || 0));
  if (!tableSet.has(table)) return fail("不允许导出该数据表", 422, 422);
  const sourceRows = await readTableRows(env.XBOARD_DB, table, limit, offset);
  const rows = sourceRows.map(row => exportRow(table, row)).filter((row): row is MigrationRow => row !== null);
  return ok({ table, rows, source_rows: sourceRows.length, next_offset: offset + sourceRows.length, done: sourceRows.length < limit });
}

async function snapshotTable(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  const table = String(input.table || "");
  const limit = Math.min(100, Math.max(1, Number(input.limit || 100)));
  const offset = Math.max(0, Number(input.offset || 0));
  if (!runId || !tableSet.has(table)) return fail("无效的快照任务或数据表", 422, 422);
  const run = await migrationRun(env, runId);
  if (!run || run.status !== "running" || Number(run.snapshot_complete || 0)) return fail("迁移前快照任务不存在或已结束", 409, 409);
  try {
    const sourceRows = await readTableRows(env.XBOARD_DB, table, limit, offset);
    const statements = sourceRows.map((row, index) => env.XBOARD_DB.prepare(
      "INSERT OR REPLACE INTO v2_migration_snapshot_rows(run_id,table_name,row_index,row_data,created_at) VALUES (?,?,?,?,?)"
    ).bind(runId, table, offset + index, JSON.stringify(row), now()));
    if (statements.length) await env.XBOARD_DB.batch(statements);
    const captured = await env.XBOARD_DB.prepare("SELECT COUNT(*) AS count FROM v2_migration_snapshot_rows WHERE run_id = ? AND table_name = ?")
      .bind(runId, table).first<{ count: number }>();
    const progress = safeJson(run.progress) as Record<string, any>;
    progress.snapshot = progress.snapshot || {};
    progress.snapshot[table] = { captured: Number(captured?.count || 0), expected: Number((safeJson(run.snapshot_counts) as Record<string, number>)[table] || 0) };
    await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET progress = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(progress), now(), runId).run();
    return ok({
      table,
      rows: sourceRows.map(row => exportRow(table, row)).filter((row): row is MigrationRow => row !== null),
      source_rows: sourceRows.length,
      captured: Number(captured?.count || 0),
      next_offset: offset + sourceRows.length,
      done: sourceRows.length < limit
    });
  } catch (error) {
    const details = { phase: "snapshot", table, offset, limit, error: errorMessage(error) };
    await markMigrationFailed(env, runId, `迁移前快照失败：${table}`, details);
    return migrationError(`迁移前快照失败：${table}，${details.error}`, 500, details);
  }
}

async function finishSnapshot(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  const run = await migrationRun(env, runId);
  if (!run || run.status !== "running") return fail("迁移任务不存在或已结束", 409, 409);
  if (Number(run.snapshot_complete || 0)) return ok({ counts: safeJson(run.snapshot_counts), already_complete: true });
  if (run.prepared_at) return fail("目标数据库已开始准备，不能再完成迁移前快照", 409, 409);
  const expected = safeJson(run.snapshot_counts) as Record<string, number>;
  const mismatches: Array<{ table: string; expected: number; captured: number }> = [];
  for (const table of MIGRATION_TABLES) {
    const row = await env.XBOARD_DB.prepare("SELECT COUNT(*) AS count FROM v2_migration_snapshot_rows WHERE run_id = ? AND table_name = ?")
      .bind(runId, table).first<{ count: number }>();
    const captured = Number(row?.count || 0);
    if (captured !== Number(expected[table] || 0)) mismatches.push({ table, expected: Number(expected[table] || 0), captured });
  }
  if (mismatches.length) {
    const details = { phase: "snapshot_validation", mismatches };
    await markMigrationFailed(env, runId, "迁移前快照校验失败", details);
    return migrationError("迁移前快照校验失败，未写入任何导入数据", 409, details);
  }
  await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET snapshot_complete = 1, updated_at = ? WHERE id = ?").bind(now(), runId).run();
  await logMigration(env, runId, "迁移前 D1 快照与原版 SQLite 自动备份已完成", undefined, { counts: expected });
  return ok({ counts: expected });
}

async function prepareMigration(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  const run = await migrationRun(env, runId);
  if (!run || run.status !== "running") return fail("迁移任务不存在或已结束", 409, 409);
  if (!Number(run.snapshot_complete || 0)) return fail("迁移前快照尚未完成", 409, 409);
  if (run.prepared_at) return ok({ mode: run.mode, already_prepared: true });
  try {
    if (run.mode === "overwrite") {
      await env.XBOARD_DB.batch(DELETE_TABLES.map(table => env.XBOARD_DB.prepare(`DELETE FROM ${table}`)));
    }
    const ts = now();
    await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET prepared_at = ?, updated_at = ? WHERE id = ?").bind(ts, ts, runId).run();
    await logMigration(env, runId, run.mode === "overwrite" ? "已清空目标业务表，开始完整切换" : "保留目标记录，开始合并迁移");
    return ok({ mode: run.mode, prepared_at: ts });
  } catch (error) {
    const details = { phase: "prepare", mode: run.mode, error: errorMessage(error) };
    await markMigrationFailed(env, runId, "准备目标数据库失败", details);
    return migrationError(`准备目标数据库失败：${details.error}`, 500, details);
  }
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
  if (!Number(run.snapshot_complete || 0) || !run.prepared_at) return fail("迁移前快照或目标数据库准备尚未完成", 409, 409);

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
  } catch (error) {
    const ids = sourceRows.map(row => row.id).filter(value => value !== undefined && value !== null);
    const details = {
      phase: "sqlite_import",
      table,
      rows: sourceRows.length,
      first_id: ids[0] ?? null,
      last_id: ids.at(-1) ?? null,
      error: errorMessage(error)
    };
    await markMigrationFailed(env, runId, `SQLite 批次写入失败：${table}`, details);
    return migrationError(`SQLite 批次写入失败：${table}（${details.error}）`, 500, details);
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
  if (!Number(run.snapshot_complete || 0) || !run.prepared_at) return fail("迁移前快照或目标数据库准备尚未完成", 409, 409);
  let imported = 0;
  let skipped = 0;
  try {
    for (const entry of entries) {
      const mapped = mapRedisEntry(String(entry.key || ""), entry.value);
      if (!mapped) { skipped++; continue; }
      const existingSnapshot = await env.XBOARD_DB.prepare("SELECT key_name FROM v2_migration_kv_snapshots WHERE run_id = ? AND key_name = ?")
        .bind(runId, mapped.key).first();
      if (!existingSnapshot) {
        const previous = await env.XBOARD_KV.get(mapped.key);
        await env.XBOARD_DB.prepare("INSERT INTO v2_migration_kv_snapshots(run_id,key_name,existed,value,created_at) VALUES (?,?,?,?,?)")
          .bind(runId, mapped.key, previous === null ? 0 : 1, previous, now()).run();
      }
      await env.XBOARD_KV.put(mapped.key, mapped.value, { expirationTtl: 3600 });
      imported++;
    }
  } catch (error) {
    const details = { phase: "redis_import", received: entries.length, imported, skipped, error: errorMessage(error) };
    await markMigrationFailed(env, runId, "Redis/KV 批次写入失败", details);
    return migrationError(`Redis/KV 批次写入失败：${details.error}`, 500, details);
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

async function abortMigration(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  const run = await migrationRun(env, runId);
  if (!run) return fail("迁移任务不存在", 404, 404);
  if (run.status === "failed") return ok({ status: "failed", error: safeJson(run.error, run.error) });
  if (run.status !== "running") return fail("迁移任务已经结束", 409, 409);
  const details = {
    phase: String(input.phase || "client"),
    table: input.table || null,
    offset: input.offset || null,
    error: String(input.error || "浏览器端迁移流程中断")
  };
  const error = await markMigrationFailed(env, runId, `迁移已中断：${details.error}`, details);
  return ok({ status: "failed", error });
}

async function startRollback(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  const run = await migrationRun(env, runId);
  if (!run || !["failed", "rollback_failed"].includes(String(run.status))) return fail("只有失败的迁移任务可以一键还原", 409, 409);
  if (!Number(run.snapshot_complete || 0)) return fail("迁移前快照不完整，无法自动还原", 409, 409);
  try {
    await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET status = 'rolling_back', rollback_progress = ?, finished_at = NULL, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify({ phase: "clearing", tables: {} }), now(), runId).run();
    await env.XBOARD_DB.batch(DELETE_TABLES.map(table => env.XBOARD_DB.prepare(`DELETE FROM ${table}`)));
    const progress = { phase: "restoring", tables: {} };
    await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET rollback_progress = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(progress), now(), runId).run();
    await logMigration(env, runId, "已清空失败迁移产生的数据，开始从迁移前快照还原");
    return ok({ status: "rolling_back", tables: MIGRATION_TABLES, counts: safeJson(run.snapshot_counts) });
  } catch (error) {
    const details = { phase: "rollback_clear", error: errorMessage(error) };
    await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET status = 'rollback_failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(details), now(), runId).run();
    await logMigration(env, runId, "还原前清理失败", undefined, details, "error");
    return migrationError(`还原前清理失败：${details.error}`, 500, details);
  }
}

async function rollbackTable(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  const table = String(input.table || "");
  const limit = Math.min(100, Math.max(1, Number(input.limit || 50)));
  const offset = Math.max(0, Number(input.offset || 0));
  if (!runId || !tableSet.has(table)) return fail("无效的还原任务或数据表", 422, 422);
  const run = await migrationRun(env, runId);
  if (!run || run.status !== "rolling_back") return fail("还原任务不存在或已结束", 409, 409);
  try {
    const snapshot = await env.XBOARD_DB.prepare("SELECT row_data FROM v2_migration_snapshot_rows WHERE run_id = ? AND table_name = ? ORDER BY row_index ASC LIMIT ? OFFSET ?")
      .bind(runId, table, limit, offset).all<{ row_data: string }>();
    const sourceRows = (snapshot.results || []).map(row => safeJson(row.row_data) as MigrationRow);
    const rows = await exactRows(env.XBOARD_DB, table, sourceRows);
    const statements = rows.map(row => {
      const columns = Object.keys(row);
      if (!columns.length) throw new Error(`${table} 的快照行没有可还原字段`);
      const quoted = columns.map(column => `\`${column.replace(/`/g, "")}\``).join(",");
      return env.XBOARD_DB.prepare(`INSERT OR REPLACE INTO ${table} (${quoted}) VALUES (${columns.map(() => "?").join(",")})`)
        .bind(...columns.map(column => row[column]));
    });
    if (statements.length) await env.XBOARD_DB.batch(statements);
    const progress = safeJson(run.rollback_progress) as Record<string, any>;
    progress.phase = "restoring";
    progress.tables = progress.tables || {};
    progress.tables[table] = { restored: offset + sourceRows.length, expected: Number((safeJson(run.snapshot_counts) as Record<string, number>)[table] || 0) };
    await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET rollback_progress = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(progress), now(), runId).run();
    return ok({ table, restored: sourceRows.length, next_offset: offset + sourceRows.length, done: sourceRows.length < limit });
  } catch (error) {
    const details = { phase: "rollback_restore", table, offset, limit, error: errorMessage(error) };
    await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET status = 'rollback_failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(details), now(), runId).run();
    await logMigration(env, runId, `还原数据表失败：${table}`, table, details, "error");
    return migrationError(`还原数据表失败：${table}（${details.error}）`, 500, details);
  }
}

async function finishRollback(request: Request, env: MigrationEnv) {
  const input = await body<Record<string, unknown>>(request);
  const runId = String(input.run_id || "");
  const run = await migrationRun(env, runId);
  if (!run || run.status !== "rolling_back") return fail("还原任务不存在或已结束", 409, 409);
  const expected = safeJson(run.snapshot_counts) as Record<string, number>;
  const mismatches: Array<{ table: string; expected: number; restored: number }> = [];
  for (const table of MIGRATION_TABLES) {
    const restored = await tableCount(env.XBOARD_DB, table);
    if (restored !== Number(expected[table] || 0)) mismatches.push({ table, expected: Number(expected[table] || 0), restored });
  }
  if (mismatches.length) {
    const details = { phase: "rollback_validation", mismatches };
    await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET status = 'rollback_failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(details), now(), runId).run();
    await logMigration(env, runId, "还原后的数据行数校验失败", undefined, details, "error");
    return migrationError("还原后的数据行数校验失败", 409, details);
  }
  try {
    const kvRows = await env.XBOARD_DB.prepare("SELECT key_name, existed, value FROM v2_migration_kv_snapshots WHERE run_id = ?").bind(runId).all<Record<string, any>>();
    for (const row of kvRows.results || []) {
      if (Number(row.existed)) await env.XBOARD_KV.put(String(row.key_name), String(row.value ?? ""));
      else await env.XBOARD_KV.delete(String(row.key_name));
    }
    for (const key of ["settings:all", "settings_version", "servers_version"]) {
      try { await env.XBOARD_KV.delete(key); } catch { /* D1 remains authoritative. */ }
    }
  } catch (error) {
    const details = { phase: "rollback_kv", error: errorMessage(error) };
    await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET status = 'rollback_failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(details), now(), runId).run();
    return migrationError(`D1 已还原，但 KV 状态还原失败：${details.error}`, 500, details);
  }
  const ts = now();
  const report = { restored_counts: expected, restored_at: ts };
  await env.XBOARD_DB.prepare("UPDATE v2_migration_runs SET status = 'rolled_back', rollback_progress = ?, report = ?, error = NULL, access_token_hash = NULL, finished_at = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify({ phase: "completed", tables: expected }), JSON.stringify(report), ts, ts, runId).run();
  await logMigration(env, runId, "已一键还原到迁移前状态", undefined, report);
  return ok(report);
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
  if (warnings.length) {
    const details = { phase: "finish_validation", mismatches: warnings };
    await markMigrationFailed(env, runId, "迁移数据接收数量校验失败", details);
    return migrationError("迁移数据接收数量校验失败，任务已中断，可一键还原", 409, details);
  }
  try {
    await setDefaultTheme(env.XBOARD_DB);
  } catch (error) {
    const details = { phase: "default_theme", error: errorMessage(error) };
    await markMigrationFailed(env, runId, "设置默认主题失败", details);
    return migrationError(`设置默认主题失败：${details.error}`, 500, details);
  }
  const report = {
    source_type: run.source_type,
    mode: run.mode,
    source_counts: sourceCounts,
    target_counts: counts,
    progress,
    warnings,
    skipped_service_config: ["原 SMTP/邮件驱动设置", "Resend 凭据", "支付渠道及支付插件配置", "原主题与主题配置"],
    theme: "Xboard"
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
  try {
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("DELETE FROM v2_migration_snapshot_rows WHERE run_id = ?").bind(runId),
      env.XBOARD_DB.prepare("DELETE FROM v2_migration_kv_snapshots WHERE run_id = ?").bind(runId)
    ]);
  } catch { /* Successful migrations do not depend on snapshot cleanup. */ }
  await logMigration(env, runId, "迁移完成", undefined, report, "info");
  return ok(report);
}

export async function handleAdminMigration(request: Request, env: MigrationEnv, route: string, adminId: number) {
  await ensureMigrationSchema(env);
  if (route === "/migration/status" && request.method === "GET") return migrationStatus(env);
  if (route === "/migration/export/manifest" && request.method === "GET") return exportManifest(env);
  if (route === "/migration/export/table" && request.method === "POST") return exportTable(request, env);
  if (route === "/migration/start" && request.method === "POST") return startMigration(request, env, adminId);
  if (route === "/migration/snapshot/table" && request.method === "POST") return snapshotTable(request, env);
  if (route === "/migration/snapshot/finish" && request.method === "POST") return finishSnapshot(request, env);
  if (route === "/migration/prepare" && request.method === "POST") return prepareMigration(request, env);
  if (route === "/migration/batch" && request.method === "POST") return importBatch(request, env);
  if (route === "/migration/redis/import" && request.method === "POST") return importRedis(request, env);
  if (route === "/migration/abort" && request.method === "POST") return abortMigration(request, env);
  if (route === "/migration/rollback/start" && request.method === "POST") return startRollback(request, env);
  if (route === "/migration/rollback/table" && request.method === "POST") return rollbackTable(request, env);
  if (route === "/migration/rollback/finish" && request.method === "POST") return finishRollback(request, env);
  if (route === "/migration/finish" && request.method === "POST") return finishMigration(request, env);
  return null;
}

export function migrationTables() { return [...MIGRATION_TABLES].sort((a, b) => tableOrder[a] - tableOrder[b]); }
