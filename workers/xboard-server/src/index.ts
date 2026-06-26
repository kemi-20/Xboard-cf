import type { D1Database, KVNamespace, Queue, DurableObjectState } from "./types";
import { body, fail, now, ok } from "./compat";

export interface Env { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace; TRAFFIC_EVENTS: Queue; NODE_HUB: any; }

async function auth(request: Request, env: Env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || request.headers.get("x-node-token") || new URL(request.url).searchParams.get("token");
  if (!token) return null;
  return await env.XBOARD_DB.prepare("SELECT * FROM v2_server WHERE json_extract(protocol_settings, '$.token') = ? OR id = ?").bind(token, token).first<any>();
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
    await env.XBOARD_KV.put(`node:last_check:${server.id}`, String(now()), { expirationTtl: 3600 });
    if (url.pathname.includes("config")) return ok(server);
    if (url.pathname.includes("user")) {
      const users = await env.XBOARD_DB.prepare("SELECT id, uuid, email, transfer_enable, u, d, expired_at, speed_limit, device_limit FROM v2_user WHERE banned = 0").all();
      return ok(users.results || []);
    }
    if (url.pathname.includes("traffic")) {
      const input = await body<any>(request);
      const event = { event_id: crypto.randomUUID(), type: "traffic", server_id: server.id, server_type: server.type, payload: input, created_at: now() };
      await env.TRAFFIC_EVENTS.send(event);
      await env.XBOARD_KV.put(`node:last_push:${server.id}`, String(now()), { expirationTtl: 3600 });
      return ok(true);
    }
    if (url.pathname.includes("machine")) return ok({ node: server, load: await env.XBOARD_KV.get(`node:load:${server.id}`) });
    return ok({ server });
  }
};
