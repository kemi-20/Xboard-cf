function formatSqliteDate(value) {
  if (value === null || value === undefined || value === "") return value;
  if (!Number.isFinite(Number(value))) return value;
  const date = new Date(Number(value) * 1000);
  const part = number => String(number).padStart(2, "0");
  return `${date.getUTCFullYear()}-${part(date.getUTCMonth() + 1)}-${part(date.getUTCDate())} ${part(date.getUTCHours())}:${part(date.getUTCMinutes())}:${part(date.getUTCSeconds())}`;
}

function requiredFallback(column, row) {
  const name = column.name.toLowerCase();
  if (name === "updated_at") return row.created_at ?? 0;
  if (name === "created_at") return row.updated_at ?? 0;
  if (name === "method") return "UNKNOWN";
  if (name === "uri") return row.target ?? "/";
  if (column.type.includes("CHAR") || column.type.includes("TEXT") || column.type.includes("CLOB")) return "";
  if (column.type.includes("BLOB")) return new Uint8Array();
  return 0;
}

export function sqliteTableColumns(db, table) {
  const info = db.exec(`PRAGMA table_info(\`${table}\`)`)[0];
  if (!info) return [];
  return info.values.map(values => ({
    name: String(values[1]),
    type: String(values[2] || "").toUpperCase(),
    notnull: Number(values[3] || 0) === 1,
    defaultValue: values[4],
    primaryKey: Number(values[5] || 0) > 0
  }));
}

export function normalizedSqliteValues(columns, row) {
  const selected = [];
  const values = [];
  for (const column of columns) {
    let value = row[column.name];
    if ((value === null || value === undefined) && column.notnull && !column.primaryKey) {
      if (column.defaultValue !== null && column.defaultValue !== undefined) continue;
      value = requiredFallback(column, row);
    }
    if (value === undefined) continue;
    if (column.type.includes("DATETIME") && typeof value === "number") value = formatSqliteDate(value);
    if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) value = JSON.stringify(value);
    if (typeof value === "boolean") value = value ? 1 : 0;
    selected.push(column);
    values.push(value);
  }
  return { selected, values };
}

export function insertExportRows(db, table, rows) {
  if (!rows.length) return;
  const columns = sqliteTableColumns(db, table);
  if (!columns.length) return;
  db.run("BEGIN");
  try {
    for (const row of rows) {
      const { selected, values } = normalizedSqliteValues(columns, row);
      if (!selected.length) continue;
      const names = selected.map(column => `\`${column.name.replaceAll("`", "")}\``).join(",");
      db.run(`INSERT OR REPLACE INTO \`${table}\` (${names}) VALUES (${selected.map(() => "?").join(",")})`, values);
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw new Error(`生成原版 SQLite 时写入 ${table} 失败：${error.message}`);
  }
}
