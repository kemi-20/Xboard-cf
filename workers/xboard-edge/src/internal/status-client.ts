import { cachedData } from "../cache.ts";
import { now } from "../compat.ts";
import type { Fetcher } from "../types.ts";

export type RuntimeStatus = {
  last_seen_at?: unknown;
  disconnected_at?: unknown;
  connected?: unknown;
  last_check_at?: unknown;
  last_push_at?: unknown;
  load_status?: unknown;
  metrics?: unknown;
  online?: unknown;
  connections_at?: unknown;
  connections?: unknown;
  updated_at?: unknown;
  [key: string]: unknown;
};

export type StatusSnapshot = {
  machines: Record<string, RuntimeStatus>;
  nodes: Record<string, RuntimeStatus>;
  available: boolean;
  stale: boolean;
};

type StatusEnv = { XBOARD_SERVER: Fetcher };
type AuthHeaderLoader = () => Promise<Record<string, string>>;

let statusSnapshotVersion = 0;
let liveDeviceSnapshotCache: { value: Record<string, string[]>; expiresAt: number } | null = null;
let lastGoodStatusSnapshot: { value: StatusSnapshot; expiresAt: number } | null = null;
let lastGoodPersistedAt = 0;
const LAST_GOOD_STATUS_URL = "https://xboard-cache.internal/status-snapshot-last-good-v2";

function validSnapshot(value: unknown): value is StatusSnapshot {
  const snapshot = value as StatusSnapshot | null;
  return Boolean(snapshot && snapshot.machines && typeof snapshot.machines === "object" && !Array.isArray(snapshot.machines)
    && snapshot.nodes && typeof snapshot.nodes === "object" && !Array.isArray(snapshot.nodes));
}

async function persistLastGoodStatus(value: StatusSnapshot) {
  const current = Date.now();
  if (current - lastGoodPersistedAt < 60_000) return;
  lastGoodPersistedAt = current;
  const cache = (globalThis as any).caches?.default;
  if (!cache) return;
  try {
    await cache.put(new Request(LAST_GOOD_STATUS_URL), new Response(JSON.stringify({ value, savedAt: current }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=900" }
    }));
  } catch {}
}

async function loadLastGoodStatus() {
  const current = Date.now();
  if (lastGoodStatusSnapshot && lastGoodStatusSnapshot.expiresAt > current) return lastGoodStatusSnapshot.value;
  const cache = (globalThis as any).caches?.default;
  if (!cache) return null;
  try {
    const response = await cache.match(new Request(LAST_GOOD_STATUS_URL));
    if (!response) return null;
    const stored = await response.json() as { value?: unknown; savedAt?: unknown };
    const savedAt = Number(stored.savedAt || 0);
    if (!validSnapshot(stored.value) || savedAt <= 0 || current - savedAt > 900_000) return null;
    lastGoodStatusSnapshot = { value: stored.value, expiresAt: savedAt + 900_000 };
    return stored.value;
  } catch {
    return null;
  }
}

async function statusHubRequest(env: StatusEnv, loadAuthHeaders: AuthHeaderLoader, path: string, init: RequestInit = {}) {
  return env.XBOARD_SERVER.fetch(`https://xboard-server.internal/internal/status/${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.headers || {}),
      "cache-control": "no-store, no-cache, must-revalidate",
      "pragma": "no-cache",
      ...await loadAuthHeaders()
    }
  });
}

export async function statusSnapshot(env: StatusEnv, loadAuthHeaders: AuthHeaderLoader): Promise<StatusSnapshot> {
  return cachedData(`status-snapshot:v2:${statusSnapshotVersion}`, 10, async () => {
    const response = await statusHubRequest(env, loadAuthHeaders, "snapshot", { method: "POST" });
    if (!response.ok) throw new Error(`StatusHub returned ${response.status}`);
    const payload = await response.json() as { data?: Omit<StatusSnapshot, "available" | "stale"> };
    if (!payload.data || typeof payload.data.machines !== "object" || !payload.data.machines || Array.isArray(payload.data.machines)
      || typeof payload.data.nodes !== "object" || !payload.data.nodes || Array.isArray(payload.data.nodes)) {
      throw new Error("StatusHub returned an invalid snapshot");
    }
    const value = { machines: payload.data.machines, nodes: payload.data.nodes, available: true, stale: false };
    lastGoodStatusSnapshot = { value, expiresAt: Date.now() + 900_000 };
    await persistLastGoodStatus(value);
    return value;
  }, 0).catch(async () => {
    const lastGood = await loadLastGoodStatus();
    if (lastGood) return { ...lastGood, available: false, stale: true };
    return { machines: {}, nodes: {}, available: false, stale: false };
  });
}

export function resetStatusClientMemoryForTest() {
  statusSnapshotVersion += 1;
  liveDeviceSnapshotCache = null;
  lastGoodStatusSnapshot = null;
  lastGoodPersistedAt = 0;
}

export async function clearStatus(env: StatusEnv, loadAuthHeaders: AuthHeaderLoader, kind: "machine" | "node", id: number) {
  statusSnapshotVersion += 1;
  liveDeviceSnapshotCache = null;
  try {
    await statusHubRequest(env, loadAuthHeaders, "clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, id })
    });
  } catch {
    // Configuration deletion remains successful if transient runtime state cannot be cleared immediately.
  }
}

export async function liveDeviceSnapshot(env: StatusEnv, loadAuthHeaders: AuthHeaderLoader): Promise<Record<string, string[]> | null> {
  if (liveDeviceSnapshotCache && liveDeviceSnapshotCache.expiresAt > Date.now()) return liveDeviceSnapshotCache.value;
  const value: Record<string, string[]> = {};
  let available = false;
  try {
    const response = await statusHubRequest(env, loadAuthHeaders, "devices/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timestamp: now() })
    });
    if (response.ok) {
      const payload = await response.json() as { data?: { users?: Record<string, unknown> } };
      if (payload.data?.users && typeof payload.data.users === "object" && !Array.isArray(payload.data.users)) {
        available = true;
        for (const [userId, ips] of Object.entries(payload.data.users)) {
          value[userId] = Array.isArray(ips) ? [...new Set(ips.map(String).filter(Boolean))] : [];
        }
      }
    }
  } catch {
    // A node connection snapshot below may still provide current device counts.
  }

  const runtime = await statusSnapshot(env, loadAuthHeaders);
  const cutoff = now() - 900;
  const connectionCounts: Record<string, number> = {};
  for (const node of Object.values(runtime.nodes || {})) {
    const connectionsAt = Number(node.connections_at || node.updated_at || 0);
    if (connectionsAt < cutoff || !node.connections || typeof node.connections !== "object" || Array.isArray(node.connections)) continue;
    available = true;
    for (const [userId, count] of Object.entries(node.connections)) {
      const online = Math.max(0, Math.trunc(Number(count || 0)));
      if (online > 0) connectionCounts[userId] = Number(connectionCounts[userId] || 0) + online;
    }
  }
  for (const [userId, count] of Object.entries(connectionCounts)) {
    const current = value[userId] || [];
    const missing = Math.max(0, count - current.length);
    if (missing) value[userId] = [...current, ...Array.from({ length: missing }, (_, index) => `__active_connection__:${index}`)];
  }
  if (!available) return null;
  liveDeviceSnapshotCache = { value, expiresAt: Date.now() + 10_000 };
  return value;
}

export async function liveOnlineSummary(env: StatusEnv, loadAuthHeaders: AuthHeaderLoader) {
  const devices = await liveDeviceSnapshot(env, loadAuthHeaders);
  if (devices === null) return null;
  const counts = Object.values(devices).map(ips => ips.length).filter(Boolean);
  return { users: counts.length, devices: counts.reduce((total, count) => total + count, 0) };
}

export async function machineHistory(
  env: StatusEnv,
  loadAuthHeaders: AuthHeaderLoader,
  machineId: number,
  limit: number,
  rangeHours: number | null
): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams({ machine_id: String(machineId), limit: String(limit) });
  if (rangeHours !== null) params.set("range_hours", String(rangeHours));
  return cachedData(`machine-history:${machineId}:${limit}:${rangeHours ?? "all"}`, 60, async () => {
    const response = await statusHubRequest(env, loadAuthHeaders, `history?${params}`, { method: "POST" });
    if (!response.ok) throw new Error(`StatusHub returned ${response.status}`);
    const payload = await response.json() as { data?: Record<string, unknown>[] };
    return Array.isArray(payload.data) ? payload.data : [];
  }, 120).catch(() => null);
}
