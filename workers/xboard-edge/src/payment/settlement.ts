import { now } from "../compat.ts";
import { settings } from "../db.ts";
import type { D1PreparedStatement, KVNamespace } from "../types.ts";
import type { PaymentEnv } from "./types.ts";

export type SettlementDeps = {
  parseJsonArray: (value: unknown) => any[];
  pickSetting: (all: Record<string, any>, key: string, fallback?: any) => any;
  addOrderMonths: (timestamp: number, months: number) => number;
  nextResetAt: (expiredAt: number | null, method: number, timestamp: number) => number | null;
  bump: (kv: KVNamespace, key: string) => Promise<void>;
};

export async function settleOrder(
  env: PaymentEnv,
  sourceOrder: Record<string, any>,
  callbackNo: string,
  deps: SettlementDeps
) {
  const order = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE id=?").bind(sourceOrder.id).first<Record<string, any>>();
  if (!order) return false;
  if (Number(order.status) === 3) return true;
  if (![0, 1].includes(Number(order.status))) return false;
  const [planResult, userResult] = await env.XBOARD_DB.batch<Record<string, any>>([
    env.XBOARD_DB.prepare("SELECT * FROM v2_plan WHERE id=?").bind(order.plan_id),
    env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id=?").bind(order.user_id)
  ]);
  const plan = planResult.results?.[0] || null;
  const user = userResult.results?.[0] || null;
  if (!plan || !user) return false;
  const period = String(order.period || "");
  const timestamp = now();
  const allSettings = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const eventSetting = Number(order.type) === 1 ? "new_order_event_id"
    : Number(order.type) === 2 ? "renew_order_event_id"
    : Number(order.type) === 3 ? "change_order_event_id" : "";
  const orderEventId = eventSetting ? Number(deps.pickSetting(allSettings, eventSetting, 0)) : 0;
  let resetTraffic = orderEventId === 1;
  let expiredAt: number | null = user.expired_at == null ? null : Number(user.expired_at);
  if (period === "reset_traffic") {
    resetTraffic = true;
  } else {
    const months: Record<string, number> = {
      monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12, two_yearly: 24, three_yearly: 36
    };
    const expiryBase = Number(order.type) === 3 ? timestamp : Math.max(timestamp, Number(user.expired_at || 0));
    expiredAt = period === "onetime" ? null : deps.addOrderMonths(expiryBase, months[period] || 0);
    if (period !== "onetime" && !months[period]) return false;
    resetTraffic = resetTraffic || period === "onetime" || user.expired_at == null || Number(order.type) === 1;
  }
  const method = plan.reset_traffic_method === null || plan.reset_traffic_method === undefined
    ? Number(deps.pickSetting(allSettings, "reset_traffic_method", 0))
    : Number(plan.reset_traffic_method);
  const nextReset = resetTraffic ? deps.nextResetAt(expiredAt, method, timestamp) : user.next_reset_at ?? null;
  const statements: D1PreparedStatement[] = [];
  const orderGuard = `EXISTS (
    SELECT 1 FROM v2_order guarded_order
    WHERE guarded_order.id=? AND guarded_order.status IN (0,1)
      AND EXISTS (SELECT 1 FROM v2_user guarded_user WHERE guarded_user.id=guarded_order.user_id)
      AND EXISTS (SELECT 1 FROM v2_plan guarded_plan WHERE guarded_plan.id=guarded_order.plan_id)
  )`;
  const surplusOrderIds = deps.parseJsonArray(order.surplus_order_ids).map(Number).filter(Boolean);
  if (surplusOrderIds.length) {
    statements.push(env.XBOARD_DB.prepare(`UPDATE v2_order SET status=4,updated_at=?
      WHERE id IN (${surplusOrderIds.map(() => "?").join(",")}) AND ${orderGuard}`)
      .bind(timestamp, ...surplusOrderIds, order.id));
  }
  if (resetTraffic) {
    const resetTypes: Record<number, string> = { 0: "first_day_month", 1: "monthly", 3: "first_day_year", 4: "yearly" };
    statements.push(env.XBOARD_DB.prepare(`INSERT INTO v2_traffic_reset_logs(
      user_id,reset_type,old_u,old_d,old_upload,old_download,old_total,
      new_upload,new_download,new_total,trigger_source,metadata,reset_time,created_at)
      SELECT current_user.id,?,COALESCE(current_user.u,0),COALESCE(current_user.d,0),
        COALESCE(current_user.u,0),COALESCE(current_user.d,0),
        COALESCE(current_user.u,0)+COALESCE(current_user.d,0),
        0,0,0,'order',?,?,?
      FROM v2_user current_user WHERE current_user.id=? AND ${orderGuard}`)
      .bind(
        resetTypes[method] || "manual",
        JSON.stringify({ order_id: order.id, trade_no: order.trade_no, event_id: orderEventId || null }),
        timestamp, timestamp, user.id, order.id
      ));
  }
  if (period === "reset_traffic") {
    statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET
      u=0,d=0,balance=COALESCE(balance,0)+?,last_reset_at=?,next_reset_at=?,
      reset_count=COALESCE(reset_count,0)+1,updated_at=?
      WHERE id=? AND ${orderGuard}`)
      .bind(Number(order.surplus_credit || 0), timestamp, nextReset, timestamp, user.id, order.id));
  } else if (resetTraffic) {
    statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET
      plan_id=?,group_id=?,transfer_enable=?,speed_limit=?,device_limit=?,expired_at=?,
      u=0,d=0,balance=COALESCE(balance,0)+?,last_reset_at=?,next_reset_at=?,
      reset_count=COALESCE(reset_count,0)+1,updated_at=?
      WHERE id=? AND ${orderGuard}`)
      .bind(
        plan.id, plan.group_id, Number(plan.transfer_enable || 0) * 1073741824,
        plan.speed_limit ?? null, plan.device_limit ?? null, expiredAt,
        Number(order.surplus_credit || 0), timestamp, nextReset, timestamp, user.id, order.id
      ));
  } else {
    statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET
      plan_id=?,group_id=?,transfer_enable=?,speed_limit=?,device_limit=?,expired_at=?,
      balance=COALESCE(balance,0)+?,updated_at=?
      WHERE id=? AND ${orderGuard}`)
      .bind(
        plan.id, plan.group_id, Number(plan.transfer_enable || 0) * 1073741824,
        plan.speed_limit ?? null, plan.device_limit ?? null, expiredAt,
        Number(order.surplus_credit || 0), timestamp, user.id, order.id
      ));
  }
  statements.push(env.XBOARD_DB.prepare(`UPDATE v2_order SET status=3,paid_at=?,callback_no=?,updated_at=?
    WHERE id=? AND status IN (0,1)
      AND EXISTS (SELECT 1 FROM v2_user WHERE id=v2_order.user_id)
      AND EXISTS (SELECT 1 FROM v2_plan WHERE id=v2_order.plan_id)`)
    .bind(timestamp, callbackNo, timestamp, order.id));
  const results = await env.XBOARD_DB.batch(statements);
  if (Number((results.at(-1)?.meta as any)?.changes || 0) !== 1) {
    const current = await env.XBOARD_DB.prepare("SELECT status FROM v2_order WHERE id=?").bind(order.id).first<{ status: number }>();
    return Number(current?.status) === 3;
  }
  await deps.bump(env.XBOARD_KV, `user_version:${order.user_id}`);
  return true;
}
