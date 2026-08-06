import { body } from "../compat.ts";
import type { D1Database, Fetcher } from "../types.ts";
import { internalAuthHeaders, type InternalAuthEnv } from "./auth.ts";

type SyncEnv = InternalAuthEnv & {
  XBOARD_DB: D1Database;
  XBOARD_SERVER: Fetcher;
};

export type NodeSyncIntent =
  | { scope: "all" }
  | { scope: "node"; node_id: number }
  | { scope: "user"; user_id: number; old_group_id?: number };

export async function invalidateServerSettings(env: SyncEnv) {
  try {
    await env.XBOARD_SERVER.fetch("https://xboard-server.internal/internal/settings/invalidate", {
      method: "POST",
      headers: await internalAuthHeaders(env)
    });
  } catch {
    // Other workers refresh their short settings cache naturally if the service is unavailable.
  }
}

export async function notifyNodeSync(env: SyncEnv, intent: NodeSyncIntent = { scope: "all" }) {
  try {
    await env.XBOARD_SERVER.fetch("https://xboard-server.internal/internal/sync", {
      method: "POST",
      headers: { "content-type": "application/json", ...await internalAuthHeaders(env) },
      body: JSON.stringify(intent)
    });
  } catch {
    // HTTP polling remains the compatibility fallback when no node is connected by WebSocket.
  }
}

export function shouldNotifyNodeSync(pathname: string, method: string) {
  if (method !== "POST" && method !== "DELETE") return false;
  return [
    "/server/manage/save", "/server/manage/update", "/server/manage/drop", "/server/manage/sort",
    "/server/route/save", "/server/route/drop", "/server/route/sort",
    "/server/group/save", "/server/group/drop",
    "/server/machine/save", "/server/machine/update", "/server/machine/drop",
    "/user/update", "/user/destroy", "/user/ban", "/user/resetSecret", "/user/generate",
    "/plan/save", "/plan/drop", "/order/paid"
  ].some(suffix => pathname.endsWith(suffix));
}

export async function nodeSyncIntent(request: Request, pathname: string, env: SyncEnv): Promise<NodeSyncIntent | null> {
  if (!shouldNotifyNodeSync(pathname, request.method)) return null;
  const input = await body<Record<string, unknown>>(request);
  if (pathname.endsWith("/server/manage/save") || pathname.endsWith("/server/manage/update")) {
    const nodeId = Number(input.id || 0);
    return nodeId > 0 ? { scope: "node", node_id: nodeId } : { scope: "all" };
  }
  if (!pathname.includes("/user/")) return { scope: "all" };
  const rawId = input.id ?? (Array.isArray(input.ids) && input.ids.length === 1 ? input.ids[0] : undefined);
  const userId = Number(rawId || 0);
  if (!userId) return { scope: "all" };
  const previous = await env.XBOARD_DB.prepare("SELECT group_id FROM v2_user WHERE id = ?").bind(userId).first<{ group_id: number | null }>();
  return { scope: "user", user_id: userId, old_group_id: Number(previous?.group_id || 0) };
}
