import { body, fail, now, ok } from "../compat";
import { settings } from "../db";
import type { D1Database, KVNamespace } from "../types";

type TicketEnv = { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace };

export type TicketDeps<E extends TicketEnv> = {
  pickSetting: (all: Record<string, any>, key: string, fallback?: any) => any;
  ticketTelegramText: (env: E, request: Request, user: Record<string, any>, ticketId: number, subject: string, message: string) => Promise<string>;
  queueTelegramToAdmins: (env: E, text: string) => Promise<unknown>;
};

export async function handleUserTickets<E extends TicketEnv>(
  request: Request,
  env: E,
  path: string,
  route: string,
  user: Record<string, any>,
  deps: TicketDeps<E>
): Promise<Response | null> {
  if (!route.startsWith("/ticket/") && !path.includes("/ticket/")) return null;
  if (request.method === "GET" && route === "/ticket/fetch") {
    const idValue = new URL(request.url).searchParams.get("id");
    const id = idValue === null || idValue === "" || !Number.isFinite(Number(idValue)) ? null : Number(idValue);
    if (id) {
      const ticket = await env.XBOARD_DB.prepare("SELECT * FROM v2_ticket WHERE id = ? AND user_id = ?").bind(id, user.id).first<Record<string, any>>();
      if (!ticket) return fail("工单不存在", 400, 400);
      const messages = await env.XBOARD_DB.prepare("SELECT *, CASE WHEN user_id = ? THEN 1 ELSE 0 END AS is_me FROM v2_ticket_message WHERE ticket_id = ? ORDER BY id ASC").bind(user.id, id).all();
      return ok({ ...ticket, message: messages.results || [] });
    }
    const data = await env.XBOARD_DB.prepare("SELECT * FROM v2_ticket WHERE user_id = ? ORDER BY created_at DESC").bind(user.id).all();
    return ok(data.results || []);
  }
  if (request.method === "POST" && route === "/ticket/save") {
    const input = await body<Record<string, any>>(request);
    if (!String(input.subject || "").trim() || !String(input.message || "").trim()) return fail("工单主题和内容不能为空", 422, 422);
    if (![0, 1, 2].includes(Number(input.level))) return fail("工单等级格式不正确", 422, 422);
    const timestamp = now();
    const existing = await env.XBOARD_DB.prepare("SELECT id FROM v2_ticket WHERE user_id = ? AND status = 0 LIMIT 1").bind(user.id).first();
    if (existing) return fail("存在未关闭的工单", 400, 400);
    const result = await env.XBOARD_DB.prepare("INSERT INTO v2_ticket(user_id, subject, level, status, reply_status, last_reply_user_id, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)")
      .bind(user.id, String(input.subject), Number(input.level || 0), user.id, timestamp, timestamp).run();
    const ticketId = Number((result.meta as any)?.last_row_id || 0);
    await env.XBOARD_DB.prepare("INSERT INTO v2_ticket_message(ticket_id, user_id, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(ticketId, user.id, String(input.message), timestamp, timestamp).run();
    try { await deps.queueTelegramToAdmins(env, await deps.ticketTelegramText(env, request, user, ticketId, String(input.subject), String(input.message))); } catch {}
    return ok(true);
  }
  if (path.includes("/ticket/close")) {
    const input = await body<Record<string, any>>(request);
    const result = await env.XBOARD_DB.prepare("UPDATE v2_ticket SET status = 1, updated_at = ? WHERE id = ? AND user_id = ?").bind(now(), input.id, user.id).run();
    return Number((result.meta as any)?.changes || 0) === 1 ? ok(true) : fail("工单不存在", 400, 400);
  }
  if (request.method === "POST" && route === "/ticket/reply") {
    const input = await body<Record<string, any>>(request);
    if (!input.id || !input.message) return fail("参数不正确", 400, 400);
    const ticket = await env.XBOARD_DB.prepare("SELECT id, subject, status, reply_status, last_reply_user_id FROM v2_ticket WHERE id = ? AND user_id = ?").bind(input.id, user.id).first<Record<string, any>>();
    if (!ticket) return fail("工单不存在", 400, 400);
    if (Number(ticket.status)) return fail("工单已关闭，无法回复", 400, 400);
    const config = await settings(env.XBOARD_DB, env.XBOARD_KV);
    if (Number(deps.pickSetting(config, "ticket_must_wait_reply", 0)) && Number(ticket.last_reply_user_id) === Number(user.id)) return fail("请等待客服回复后再发送消息", 400, 400);
    const timestamp = now();
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("INSERT INTO v2_ticket_message(ticket_id, user_id, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(ticket.id, user.id, String(input.message), timestamp, timestamp),
      env.XBOARD_DB.prepare("UPDATE v2_ticket SET reply_status = 0, last_reply_user_id = ?, updated_at = ? WHERE id = ?").bind(user.id, timestamp, ticket.id)
    ]);
    try { await deps.queueTelegramToAdmins(env, await deps.ticketTelegramText(env, request, user, Number(ticket.id), String(ticket.subject || ""), String(input.message))); } catch {}
    return ok(true);
  }
  if (request.method === "POST" && route === "/ticket/withdraw") {
    const input = await body<Record<string, any>>(request);
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    if (Number(deps.pickSetting(all, "withdraw_close_enable", 0))) return fail("Unsupported withdraw", 400, 400);
    const methods = deps.pickSetting(all, "commission_withdraw_method", ["USDT", "支付宝"]);
    if (!Array.isArray(methods) || !methods.includes(input.withdraw_method)) return fail("Unsupported withdrawal method", 422, 422);
    const limit = Number(deps.pickSetting(all, "commission_withdraw_limit", 100));
    if (Number(user.commission_balance || 0) / 100 < limit) return fail(`The current required minimum withdrawal commission is ${limit}`, 422, 422);
    if (!String(input.withdraw_account || "").trim()) return fail("Withdrawal account is required", 422, 422);
    const existing = await env.XBOARD_DB.prepare("SELECT id FROM v2_ticket WHERE user_id = ? AND status = 0 LIMIT 1").bind(user.id).first();
    if (existing) return fail("存在未关闭的工单", 400, 400);
    const timestamp = now();
    const result = await env.XBOARD_DB.prepare("INSERT INTO v2_ticket(user_id,subject,level,status,reply_status,last_reply_user_id,created_at,updated_at) VALUES (?, ?, 2, 0, 0, ?, ?, ?)")
      .bind(user.id, "[Commission Withdrawal Request] This ticket is opened by the system", user.id, timestamp, timestamp).run();
    await env.XBOARD_DB.prepare("INSERT INTO v2_ticket_message(ticket_id,user_id,message,created_at,updated_at) VALUES (?,?,?,?,?)")
      .bind(Number((result.meta as any)?.last_row_id || 0), user.id, `Withdrawal method：${input.withdraw_method}\r\nWithdrawal account：${input.withdraw_account}`, timestamp, timestamp).run();
    return ok(true);
  }
  return null;
}
