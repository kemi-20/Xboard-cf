import type { D1Database, KVNamespace, Queue, DurableObjectState } from "./types";
import { body, fail, now, ok } from "./compat";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; TRAFFIC_EVENTS: Queue; NODE_HUB: any; }

async function auth(request: Request, env: Env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || request.headers.get("x-node-token") || new URL(request.url).searchParams.get("token");
  if (!token) return null;
  const globalToken = await env.XBOARD_DB.prepare("SELECT value FROM v2_settings WHERE name = 'server_token'").first<{ value: string }>();
  const nodeId = new URL(request.url).searchParams.get("node_id") || request.headers.get("x-node-id") || new URL(request.url).searchParams.get("id");
  if (globalToken?.value && token === globalToken.value && nodeId) {
    return await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE id = ?").bind(nodeId).first<any>();
  }
  const machine = await env.XBOARD_DB.prepare("SELECT * FROM v2_server_machine WHERE token = ? AND COALESCE(is_active, enabled, 1) = 1").bind(token).first<any>();
  if (machine) return { machine, id: new URL(request.url).searchParams.get("node_id") || 0, machine_id: machine.id };
  return null;
}
export class NodeHub {
  constructor(private state: DurableObjectState, private env: Env) {}
  async fetch(request: Request) {
    if (request.headers.get("upgrade") !== "websocket") return ok({ service: "NodeHub" });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    (server as any).accept();
    server.send(JSON.stringify({ type: "hello", at: now() }));
    server.addEventListener("message", (event: MessageEvent) => server.send(JSON.stringify({ type: "ack", data: event.data, at: now() })));
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return ok({ service: "xboard-server", time: now() });
    if (url.pathname.includes("/ws")) {
      const id = env.NODE_HUB.idFromName("global");
      return env.NODE_HUB.get(id).fetch(request);
    }
    const server = await auth(request, env);
    if (!server) return fail("Invalid node token", 401);
    const serverId = Number(server.id || url.searchParams.get("node_id") || 0);
    const node = serverId ? await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE id = ?").bind(serverId).first<any>() : server;
    if (!node) return fail("Invalid node id", 404);
    await env.XBOARD_KV.put(`node:last_check:${node.id}`, String(now()), { expirationTtl: 3600 });
    if (url.pathname.includes("config")) {
      const protocol = (() => { try { return JSON.parse(node.protocol_settings || "{}"); } catch { return {}; } })();
      return ok({ ...node, protocol_settings: protocol, group_ids: JSON.parse(node.group_ids || "[]"), route_ids: JSON.parse(node.route_ids || "[]"), push_interval: 60, pull_interval: 60 });
    }
    if (url.pathname.includes("user")) {
      const groupIds = (() => { try { return JSON.parse(node.group_ids || "[]").map(Number); } catch { return []; } })();
      const users = await env.XBOARD_DB.prepare("SELECT id, uuid, group_id, speed_limit, device_limit, transfer_enable, u, d FROM v2_user WHERE banned = 0 AND (expired_at IS NULL OR expired_at > ?) AND (transfer_enable = 0 OR (u + d) < transfer_enable)").bind(now()).all<any>();
      return ok((users.results || []).filter(user => groupIds.length === 0 || groupIds.includes(Number(user.group_id))).map(user => ({
        id: user.id,
        uuid: user.uuid,
        speed_limit: user.speed_limit,
        device_limit: user.device_limit,
        transfer_enable: user.transfer_enable,
        u: user.u,
        d: user.d
      })));
    }
    if (url.pathname.includes("traffic")) {
      const input = await body<any>(request);
      const rows = Array.isArray(input) ? input : Array.isArray(input?.data) ? input.data : Array.isArray(input?.res) ? input.res.map((r: any[]) => ({ user_id: r[0], u: r[1], d: r[2] })) : [input];
      const payload = rows.map((row: any) => Array.isArray(row) ? { user_id: row[0], u: row[1], d: row[2] } : row)
        .filter((row: any) => Number.isFinite(Number(row?.user_id ?? row?.id)) && Number.isFinite(Number(row?.u)) && Number.isFinite(Number(row?.d)))
        .map((row: any) => ({ user_id: Number(row.user_id ?? row.id), u: Math.max(0, Number(row.u)), d: Math.max(0, Number(row.d)) }));
      if (!payload.length) return ok(true);
      const event = { event_id: crypto.randomUUID(), type: "traffic", server_id: node.id, server_type: node.type, rate: Number(node.rate || 1), payload, created_at: now() };
      await env.TRAFFIC_EVENTS.send(event);
      await env.XBOARD_KV.put(`node:last_push:${node.id}`, String(now()), { expirationTtl: 3600 });
      return ok(true);
    }
    if (url.pathname.includes("alive")) {
      const input = await body<any>(request);
      await env.XBOARD_KV.put(`node:online:${node.id}`, JSON.stringify(input), { expirationTtl: 300 });
      return ok(true);
    }
    if (url.pathname.includes("status")) {
      const input = await body<any>(request);
      await env.XBOARD_KV.put(`node:load:${node.id}`, JSON.stringify(input), { expirationTtl: 3600 });
      return ok(true);
    }
    if (url.pathname.includes("alivelist")) return ok([]);
    if (url.pathname.includes("machine")) return ok({ node, load: await env.XBOARD_KV.get(`node:load:${node.id}`) });
    return ok({ server: node });
  }
};
