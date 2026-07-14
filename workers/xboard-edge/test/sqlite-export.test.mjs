import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { insertExportRows, sqliteTableColumns } from "../public/migration/sqlite-export.js";

const migrationTables = [
  "v2_server_group", "v2_plan", "v2_user", "personal_access_tokens", "v2_server_machine",
  "v2_server_route", "v2_server", "v2_settings", "v2_notice", "v2_knowledge", "v2_ticket",
  "v2_ticket_message", "v2_mail_templates", "v2_invite_code", "v2_mail_log", "v2_plugins",
  "v2_log", "failed_jobs", "v2_order", "v2_payment", "v2_coupon", "v2_commission_log",
  "v2_gift_card_template", "v2_gift_card_code", "v2_gift_card_usage", "v2_stat",
  "v2_stat_user", "v2_stat_server", "v2_admin_audit_log", "v2_traffic_reset_logs",
  "v2_subscribe_templates", "v2_server_machine_load_history"
];

async function templateDatabase() {
  const SQL = await initSqlJs({ locateFile: file => fileURLToPath(new URL(`../node_modules/sql.js/dist/${file}`, import.meta.url)) });
  return new SQL.Database(fs.readFileSync("public/migration/xboard-template.db"));
}

test("SQLite export fills every required template column instead of aborting", async () => {
  const db = await templateDatabase();
  try {
    const existingTables = new Set(db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values.flat().map(String));
    let id = 900000;
    for (const table of migrationTables.filter(name => existingTables.has(name))) {
      const row = Object.fromEntries(sqliteTableColumns(db, table).map(column => [column.name, null]));
      if (Object.hasOwn(row, "id")) row.id = id++;
      insertExportRows(db, table, [row]);
    }
    assert.equal(db.exec("PRAGMA integrity_check")[0].values[0][0], "ok");
  } finally {
    db.close();
  }
});

test("SQLite export repairs legacy audit rows with missing HTTP fields", async () => {
  const db = await templateDatabase();
  try {
    insertExportRows(db, "v2_admin_audit_log", [{
      id: 990001, admin_id: null, action: "legacy.action", method: null, uri: null,
      request_data: null, ip: null, created_at: 1234567890, updated_at: null
    }]);
    const row = db.exec("SELECT admin_id, method, uri, created_at, updated_at FROM v2_admin_audit_log WHERE id = 990001")[0].values[0];
    assert.deepEqual(row, [0, "UNKNOWN", "/", 1234567890, 1234567890]);
  } finally {
    db.close();
  }
});

test("SQLite DATETIME export is stable regardless of the browser timezone", async () => {
  const db = await templateDatabase();
  try {
    insertExportRows(db, "failed_jobs", [{
      id: 990002, uuid: "timezone-test", connection: "test", queue: "test",
      payload: "{}", exception: "test", failed_at: 1767225600
    }]);
    const failedAt = db.exec("SELECT failed_at FROM failed_jobs WHERE id = 990002")[0].values[0][0];
    assert.equal(failedAt, "2026-01-01 00:00:00");
  } finally {
    db.close();
  }
});
