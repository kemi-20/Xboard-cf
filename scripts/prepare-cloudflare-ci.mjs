import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");

const apiRoot = "https://api.cloudflare.com/client/v4";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function api(path, options = {}) {
  const response = await fetch(`${apiRoot}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const details = (payload.errors || []).map(error => error.message || JSON.stringify(error)).join("; ");
    throw new Error(`Cloudflare API ${path} failed (${response.status}): ${details || response.statusText}`);
  }
  return payload.result;
}

async function discoverAccount() {
  const accounts = await api("/accounts?per_page=50");
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("The API token cannot access any Cloudflare account");
  if (accounts.length > 1) {
    process.stdout.write(`Token can access ${accounts.length} accounts; using ${accounts[0].name} (${accounts[0].id}).\n`);
  }
  return accounts[0];
}

async function ensureD1(accountId, name) {
  const databases = await api(`/accounts/${accountId}/d1/database?per_page=100`);
  const existing = databases.find(database => database.name === name);
  if (existing) return { database: existing, created: false };
  const database = await api(`/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name, primary_location_hint: "apac" })
  });
  return { database, created: true };
}

async function enableReadReplication(accountId, databaseId) {
  try {
    await api(`/accounts/${accountId}/d1/database/${databaseId}`, {
      method: "PUT",
      body: JSON.stringify({ read_replication: { mode: "auto" } })
    });
    process.stdout.write("D1 read replication enabled for the new xboard-db database.\n");
  } catch (error) {
    process.stderr.write(`Warning: xboard-db was created successfully, but read replication could not be enabled: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function ensureKv(accountId, title) {
  const namespaces = await api(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const existing = namespaces.find(namespace => namespace.title === title);
  if (existing) return existing;
  return api(`/accounts/${accountId}/storage/kv/namespaces`, { method: "POST", body: JSON.stringify({ title }) });
}

async function ensureQueue(accountId, queueName) {
  const queues = await api(`/accounts/${accountId}/queues?per_page=100`);
  const existing = queues.find(queue => queue.queue_name === queueName || queue.name === queueName);
  if (existing) return existing;
  return api(`/accounts/${accountId}/queues`, { method: "POST", body: JSON.stringify({ queue_name: queueName }) });
}

async function patchWrangler(worker, accountId, databaseId, kvId) {
  const path = resolve("workers", worker, "wrangler.toml");
  let toml = await readFile(path, "utf8");
  if (/^database_id\s*=/m.test(toml)) toml = toml.replace(/^database_id\s*=\s*"[^"]*"/m, `database_id = "${databaseId}"`);
  else toml = toml.replace(/^(database_name\s*=\s*"[^"]*"\s*)$/m, `$1\ndatabase_id = "${databaseId}"`);
  if (/^id\s*=/m.test(toml)) toml = toml.replace(/^id\s*=\s*"[^"]*"/m, `id = "${kvId}"`);
  else toml = toml.replace(/^(binding\s*=\s*"XBOARD_KV"\s*)$/m, `$1\nid = "${kvId}"`);
  if (worker === "xboard-edge" || worker === "xboard-server") {
    if (/^\[cache\]\s*$/m.test(toml)) {
      toml = toml.replace(/^(\[cache\]\s*\r?\n)(?:enabled\s*=\s*(?:true|false)\s*\r?\n)?/m, "$1enabled = true\n");
    } else {
      toml = toml.replace(/^(compatibility_date\s*=\s*"[^"]*"\s*\r?\n)/m, "$1\n[cache]\nenabled = true\n");
    }
  }
  await writeFile(path, toml);
}

const account = await discoverAccount();
const { database, created: databaseCreated } = await ensureD1(account.id, "xboard-db");
const databaseId = database.uuid || database.id;
if (databaseCreated) await enableReadReplication(account.id, databaseId);
const kv = await ensureKv(account.id, "xboard-kv");
const queueNames = [
  "traffic-events",
  "notification-events",
  "traffic-events-dlq",
  "notification-events-dlq"
];
for (const queueName of queueNames) await ensureQueue(account.id, queueName);

for (const worker of ["xboard-edge", "xboard-server", "xboard-jobs"]) {
  await patchWrangler(worker, account.id, databaseId, kv.id);
}

const output = process.env.GITHUB_OUTPUT;
if (output) {
  await writeFile(output, `account_id=${account.id}\ndatabase_id=${databaseId}\nkv_id=${kv.id}\n`, { flag: "a" });
}
const githubEnv = process.env.GITHUB_ENV;
if (githubEnv) await writeFile(githubEnv, `CLOUDFLARE_ACCOUNT_ID=${account.id}\n`, { flag: "a" });
process.stdout.write(`Cloudflare resources ready for account ${account.name} (${account.id}).\n`);
