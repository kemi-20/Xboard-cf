const securePath = location.pathname.split("/").filter(Boolean)[0] || "admin";
const apiBase = "/api/v2/admin/migration";
document.querySelector("#back").href = `/${securePath}`;

const state = { sqliteFile: null, redisFile: null, db: null, redisEntries: [], counts: {}, tables: [], sqliteTotal: 0, total: 0, done: 0, runId: null, migrationToken: null };
const $ = selector => document.querySelector(selector);
const log = message => { const area = $("#log"); area.textContent += `${new Date().toLocaleTimeString()}  ${message}\n`; area.scrollTop = area.scrollHeight; };
const setStep = value => document.querySelectorAll(".step").forEach(element => { const step = Number(element.dataset.step); element.classList.toggle("active", step === value); element.classList.toggle("done", step < value); });

function storedToken() {
  const keys = ["XBOARD_ACCESS_TOKEN", "Xboard_access_token", "access_token", "ACCESS_TOKEN"];
  const candidates = [localStorage, sessionStorage].flatMap(storage => keys.map(key => storage.getItem(key))).filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const value = parsed?.value?.auth_data ?? parsed?.value ?? parsed?.data?.auth_data ?? parsed?.data ?? parsed?.auth_data ?? parsed?.token ?? parsed;
      if (typeof value === "string") return value;
    } catch {
      if (typeof candidate === "string") return candidate;
    }
  }
  return "";
}

async function api(path, options = {}) {
  const auth = storedToken();
  if (!auth) throw new Error("未找到后台登录凭据，请返回后台重新登录");
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: auth.startsWith("Bearer ") ? auth : `Bearer ${auth}`, ...(state.migrationToken ? { "x-migration-token": state.migrationToken } : {}), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (payload.code !== undefined && Number(payload.code) !== 0)) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload.data ?? payload;
}

function renderCounts(counts) {
  const entries = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  return `<table class="summary"><thead><tr><th>数据表</th><th style="text-align:right">记录数</th></tr></thead><tbody>${entries.map(([table, count]) => `<tr><td>${table}</td><td class="num">${Number(count).toLocaleString()}</td></tr>`).join("")}</tbody></table>`;
}

async function inspectSqlite(file) {
  const SQL = await initSqlJs({ locateFile: name => `/migration/${name}` });
  state.db?.close();
  state.db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  const status = await api("/status");
  state.tables = status.tables;
  const existing = new Set(state.db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.flat().map(String) || []);
  const counts = {};
  for (const table of state.tables) {
    if (!existing.has(table)) continue;
    counts[table] = Number(state.db.exec(`SELECT COUNT(*) FROM \`${table}\``)[0]?.values[0]?.[0] || 0);
  }
  return counts;
}

class RdbReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; this.decoder = new TextDecoder(); }
  u8() { if (this.pos >= this.bytes.length) throw new Error("RDB 文件意外结束"); return this.bytes[this.pos++]; }
  take(length) { const value = this.bytes.slice(this.pos, this.pos + length); this.pos += length; return value; }
  u32le() { const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4); const value = view.getUint32(0, true); this.pos += 4; return value; }
  u64le() { const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8); const value = Number(view.getBigUint64(0, true)); this.pos += 8; return value; }
  length() {
    const first = this.u8(), mode = first >> 6;
    if (mode === 0) return { value: first & 0x3f, encoded: false };
    if (mode === 1) return { value: ((first & 0x3f) << 8) | this.u8(), encoded: false };
    if (mode === 2) {
      const subtype = first & 0x3f;
      if (subtype === 0) { const b = this.take(4); return { value: new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false), encoded: false }; }
      if (subtype === 1) { const b = this.take(8); return { value: Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, false)), encoded: false }; }
      throw new Error(`不支持的 RDB 长度编码 ${subtype}`);
    }
    return { value: first & 0x3f, encoded: true };
  }
  lzf(input, outputLength) {
    const output = new Uint8Array(outputLength); let ip = 0, op = 0;
    while (ip < input.length) {
      const control = input[ip++];
      if (control < 32) { const length = control + 1; output.set(input.slice(ip, ip + length), op); ip += length; op += length; continue; }
      let length = control >> 5; let reference = op - ((control & 0x1f) << 8) - 1;
      if (length === 7) length += input[ip++]; reference -= input[ip++]; length += 2;
      for (let index = 0; index < length; index++) output[op++] = output[reference + index];
    }
    return output;
  }
  stringBytes() {
    const length = this.length();
    if (!length.encoded) return this.take(length.value);
    if (length.value === 0) return new TextEncoder().encode(String((this.u8() << 24) >> 24));
    if (length.value === 1) { const b = this.take(2); return new TextEncoder().encode(String(new DataView(b.buffer, b.byteOffset, 2).getInt16(0, true))); }
    if (length.value === 2) { const b = this.take(4); return new TextEncoder().encode(String(new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true))); }
    if (length.value === 3) { const compressed = this.length().value, original = this.length().value; return this.lzf(this.take(compressed), original); }
    throw new Error(`不支持的 RDB 字符串编码 ${length.value}`);
  }
  string() { return this.decoder.decode(this.stringBytes()); }
  score() { const length = this.u8(); if (length === 253) return "NaN"; if (length === 254) return "Infinity"; if (length === 255) return "-Infinity"; return this.decoder.decode(this.take(length)); }
  listpack(bytes) {
    if (bytes.length < 7) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let position = 6; const values = [];
    const signed = (value, bits) => value & (1 << (bits - 1)) ? value - (1 << bits) : value;
    while (position < bytes.length && bytes[position] !== 255) {
      const start = position, first = bytes[position++]; let value;
      if (first <= 127) value = first;
      else if ((first & 0xc0) === 0x80) { const length = first & 0x3f; value = this.decoder.decode(bytes.slice(position, position + length)); position += length; }
      else if ((first & 0xe0) === 0xc0) { value = signed(((first & 0x1f) << 8) | bytes[position++], 13); }
      else if ((first & 0xf0) === 0xe0) { const length = ((first & 0x0f) << 8) | bytes[position++]; value = this.decoder.decode(bytes.slice(position, position + length)); position += length; }
      else if (first === 0xf0) { value = view.getInt16(position, true); position += 2; }
      else if (first === 0xf1) { let raw = bytes[position] | (bytes[position + 1] << 8) | (bytes[position + 2] << 16); value = raw & 0x800000 ? raw - 0x1000000 : raw; position += 3; }
      else if (first === 0xf2) { value = view.getInt32(position, true); position += 4; }
      else if (first === 0xf3) { value = Number(view.getBigInt64(position, true)); position += 8; }
      else throw new Error(`不支持的 listpack 编码 ${first}`);
      values.push(value);
      const entryLength = position - start;
      position += entryLength <= 127 ? 1 : entryLength <= 16383 ? 2 : entryLength <= 2097151 ? 3 : entryLength <= 268435455 ? 4 : 5;
    }
    return values;
  }
  intset(bytes) {
    if (bytes.length < 8) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const encoding = view.getUint32(0, true), count = view.getUint32(4, true), values = [];
    if (![2, 4, 8].includes(encoding) || 8 + count * encoding > bytes.length) throw new Error("无效的 Redis intset");
    for (let index = 0; index < count; index++) {
      const offset = 8 + index * encoding;
      values.push(String(encoding === 2 ? view.getInt16(offset, true) : encoding === 4 ? view.getInt32(offset, true) : Number(view.getBigInt64(offset, true))));
    }
    return values;
  }
  value(type) {
    if (type === 0) return this.string();
    if (type === 1 || type === 2) { const count = this.length().value, result = []; for (let i = 0; i < count; i++) result.push(this.string()); return result; }
    if (type === 3) { const count = this.length().value, result = []; for (let i = 0; i < count; i++) result.push([this.string(), this.score()]); return result; }
    if (type === 4) { const count = this.length().value, result = {}; for (let i = 0; i < count; i++) result[this.string()] = this.string(); return result; }
    if (type === 5) { const count = this.length().value, result = []; for (let i = 0; i < count; i++) { const member = this.string(); const bytes = this.take(8); result.push([member, new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true)]); } return result; }
    if ([9, 10, 12, 13, 16, 17].includes(type)) { this.stringBytes(); return null; }
    if (type === 11) return this.intset(this.stringBytes());
    if (type === 20) return this.listpack(this.stringBytes());
    if (type === 14) { const count = this.length().value; for (let i = 0; i < count; i++) this.stringBytes(); return null; }
    if (type === 18) { const count = this.length().value; for (let i = 0; i < count; i++) { this.length(); this.stringBytes(); } return null; }
    throw new Error(`RDB 中包含暂不支持的对象类型 ${type}（偏移 ${this.pos}）`);
  }
}

function usefulRedisKey(key) {
  return /(?:SERVER_[A-Z0-9]+_(?:LAST_CHECK_AT|LAST_PUSH_AT|ONLINE_USER|LOAD_STATUS|METRICS)_\d+|node_ws_alive:\d+|traffic:pending_check|SCHEDULE_LAST_CHECK_AT)$/i.test(key);
}

function parseRdb(bytes) {
  const reader = new RdbReader(bytes);
  const header = reader.decoder.decode(reader.take(9));
  if (!/^REDIS\d{4}$/.test(header)) throw new Error("不是有效的 Redis RDB 文件");
  const entries = []; let db = 0;
  while (reader.pos < bytes.length) {
    let type = reader.u8();
    if (type === 255) break;
    if (type === 254) { db = reader.length().value; continue; }
    if (type === 250) { reader.stringBytes(); reader.stringBytes(); continue; }
    if (type === 251) { reader.length(); reader.length(); continue; }
    if (type === 252) { reader.u64le(); type = reader.u8(); }
    else if (type === 253) { reader.u32le(); type = reader.u8(); }
    if (type === 248) { reader.length(); type = reader.u8(); }
    if (type === 249) { reader.u8(); type = reader.u8(); }
    if (type === 247) throw new Error("RDB MODULE_AUX 暂不支持");
    const key = reader.string();
    const value = reader.value(type);
    if (usefulRedisKey(key) && value !== null) entries.push({ db, key, value });
  }
  return entries;
}

async function inspectRedis(file) {
  if (file.name.toLowerCase().endsWith(".json")) {
    const data = JSON.parse(await file.text());
    const databases = Array.isArray(data) ? data : [data];
    state.redisEntries = databases.flatMap((database, db) => Object.entries(database || {}).map(([key, value]) => ({ db, key, value }))).filter(entry => usefulRedisKey(entry.key));
  } else {
    state.redisEntries = parseRdb(new Uint8Array(await file.arrayBuffer()));
  }
  return state.redisEntries.length;
}

async function inspect() {
  const sqliteFile = $("#sqlite-file").files[0];
  const redisFile = $("#redis-file").files[0];
  if (!sqliteFile || !redisFile) throw new Error("请同时选择 SQLite3 和 Redis 备份文件");
  state.sqliteFile = sqliteFile; state.redisFile = redisFile;
  $("#inspect").disabled = true; $("#file-status").textContent = "正在读取两份备份";
  try {
    const sqliteCounts = await inspectSqlite(sqliteFile);
    const redisCount = await inspectRedis(redisFile);
    state.sqliteTotal = Object.values(sqliteCounts).reduce((sum, count) => sum + Number(count), 0);
    state.counts = { ...sqliteCounts, redis_useful_keys: redisCount };
    state.total = state.sqliteTotal + redisCount;
    $("#preflight-content").innerHTML = `<p class="success">联合校验通过：SQLite ${state.sqliteTotal.toLocaleString()} 行，Redis ${redisCount.toLocaleString()} 个有效键。</p><div class="warning"><strong>以下服务配置无法迁移</strong>原版 SMTP/邮件驱动设置和支付渠道、支付插件配置不会导入。迁移完成后，请在新后台的邮件设置中手动配置 Resend API Key、发件人邮箱和发件人名称。邮件模板、订单等可审计业务历史仍会保留，但真实支付功能不会启用。</div><p class="muted">队列任务、Horizon 监控、调度锁、旧会话、验证码和限流计数不会导入。</p>${renderCounts(state.counts)}`;
    $("#preflight").hidden = false; $("#file-status").textContent = `${sqliteFile.name} + ${redisFile.name}`; setStep(2);
  } finally { $("#inspect").disabled = false; }
}

function sqliteRows(table, limit, offset) {
  const result = state.db.exec(`SELECT * FROM \`${table}\` LIMIT ${Number(limit)} OFFSET ${Number(offset)}`)[0];
  if (!result) return [];
  return result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
}

async function migrateSqlite() {
  const batchSize = 50;
  for (const table of state.tables) {
    const count = Number(state.counts[table] || 0);
    for (let offset = 0; offset < count; offset += batchSize) {
      const rows = sqliteRows(table, batchSize, offset);
      const result = await api("/batch", { method: "POST", body: JSON.stringify({ run_id: state.runId, table, rows }) });
      state.done += rows.length; updateProgress(`${table}: ${Math.min(offset + rows.length, count)}/${count}`);
      log(`${table}: 接收 ${rows.length} 行，新增 ${result.inserted} 行，D1 当前 ${result.target_count} 行`);
    }
  }
}

async function migrateRedis() {
  const batchSize = 100;
  for (let offset = 0; offset < state.redisEntries.length; offset += batchSize) {
    const entries = state.redisEntries.slice(offset, offset + batchSize);
    const result = await api("/redis/import", { method: "POST", body: JSON.stringify({ run_id: state.runId, entries }) });
    state.done += entries.length; updateProgress(`Redis: ${state.done}/${state.total}`); log(`Redis: 导入 ${result.imported}，跳过 ${result.skipped}`);
  }
}

function updateProgress(label) { $("#progress-label").textContent = label; $("#progress-bar").style.width = `${state.total ? Math.min(100, state.done / state.total * 100) : 100}%`; }

async function migrate() {
  $("#migrate").disabled = true; $("#running").hidden = false; setStep(3); state.done = 0; $("#log").textContent = "";
  try {
    const started = await api("/start", { method: "POST", body: JSON.stringify({ source_type: "xboard", source_name: `${state.sqliteFile.name} + ${state.redisFile.name}`, source_size: state.sqliteFile.size + state.redisFile.size, source_counts: state.counts, mode: $("#mode").value }) });
    state.runId = started.run_id; state.migrationToken = started.migration_token; log(`任务 ${state.runId} 已创建，策略 ${started.mode}`);
    await migrateSqlite();
    await migrateRedis();
    const report = await api("/finish", { method: "POST", body: JSON.stringify({ run_id: state.runId }) });
    updateProgress("迁移完成"); setStep(4); $("#result").hidden = false;
    $("#report").innerHTML = `<p class="success">任务 ${state.runId} 已完成。</p>${report.warnings?.length ? `<p class="error">${report.warnings.join("<br>")}</p>` : "<p>源数据接收数量校验通过。</p>"}${report.target_counts ? renderCounts(report.target_counts) : ""}`;
    log("迁移完成，设置和节点缓存版本已刷新");
  } catch (error) { log(`失败: ${error.message}`); $("#progress-label").innerHTML = `<span class="error">${error.message}</span>`; throw error; }
  finally { $("#migrate").disabled = false; }
}

$("#inspect").addEventListener("click", () => inspect().catch(error => { $("#file-status").innerHTML = `<span class="error">${error.message}</span>`; }));
$("#migrate").addEventListener("click", () => migrate().catch(() => {}));
for (const id of ["#sqlite-file", "#redis-file"]) $(id).addEventListener("change", () => { $("#preflight").hidden = true; });
