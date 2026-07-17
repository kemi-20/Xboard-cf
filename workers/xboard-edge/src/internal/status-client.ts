import { cachedData } from "../cache";
import { now } from "../compat";
import type { Fetcher } from "../types";

export type StatusSnapshot = {
  machines: Record<string, Record<string, any>>;
  nodes: Record<string, Record<string, any>>;
};

type StatusEnv = { XBOARD_SERVER: Fetcher };
type TokenLoader = () => Promise<string>;

let statusSnapshotVersion = 0;
let liveDeviceSnapshotCache: { value: Record<string, string[]>; expiresAt: number } | null = null;

async function statusHubRequest(env: StatusEnv, loadToken: TokenLoader, path: string, init: RequestInit = {}) {
  return env.XBOARD_SERVER.fetch(`https://xboard-server.internal/internal/status/${path}`, {
    ...init,
    headers: { ...(init.headers || {}), "x-xboard-internal-token": await loadToken() }
  });
}

export async function statusSnapshot(env: StatusEnv, loadToken: TokenLoader): Promise<StatusSnapshot> {
  return cachedData(`status-snapshot:${statusSnapshotVersion}`, 10, async () => {
    const response = await statusHubRequest(env, loadToken, "snapshot");
    if (!response.ok) throw new Error(`StatusHub returned ${response.status}`);
    const payload = await response.json() as { data?: StatusSnapshot };
    return payload.data || { machines: {}, nodes: {} };
  }, 30).catch(() => ({ machines: {}, nodes: {} }));
}

export async function clearStatus(env: StatusEnv, loadToken: TokenLoader, kind: "machine" | "node", id: number) {
  statusSnapshotVersion += 1;
  liveDeviceSnapshotCache = null;
  try {
    await statusHubRequest(env, loadToken, "clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, id })
    });
  } catch {
    // Configuration deletion remains successful if transient runtime state cannot be cleared immediately.
  }
}

export async function liveDeviceSnapshot(env: StatusEnv, loadToken: TokenLoader): Promise<Record<string, string[]> | null> {
  if (liveDeviceSnapshotCache && liveDeviceSnapshotCache.expiresAt > Date.now()) return liveDeviceSnapshotCache.value;
  const value: Record<string, string[]> = {};
  let available = false;
  try {
    const response = await statusHubRequest(env, loadToken, "devices/list", {
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

  const runtime = await statusSnapshot(env, loadToken);
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

export async function liveOnlineSummary(env: StatusEnv, loadToken: TokenLoader) {
  const devices = await liveDeviceSnapshot(env, loadToken);
  if (devices === null) return null;
  const counts = Object.values(devices).map(ips => ips.length).filter(Boolean);
  return { users: counts.length, devices: counts.reduce((total, count) => total + count, 0) };
}

export async function machineHistory(
  env: StatusEnv,
  loadToken: TokenLoader,
  machineId: number,
  limit: number,
  rangeHours: number | null
): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams({ machine_id: String(machineId), limit: String(limit) });
  if (rangeHours !== null) params.set("range_hours", String(rangeHours));
  return cachedData(`machine-history:${machineId}:${limit}:${rangeHours ?? "all"}`, 60, async () => {
    const response = await statusHubRequest(env, loadToken, `history?${params}`);
    if (!response.ok) throw new Error(`StatusHub returned ${response.status}`);
    const payload = await response.json() as { data?: Record<string, unknown>[] };
    return Array.isArray(payload.data) ? payload.data : [];
  }, 120).catch(() => null);
}
