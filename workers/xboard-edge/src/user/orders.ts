import { body, fail, json, now, ok, token } from "../compat";
import { settings } from "../db";
import { checkoutPayment, enabledPaymentMethods, paymentForOrder } from "../payment/index.ts";
import type { D1Database, KVNamespace } from "../types";

type OrderEnv = { XBOARD_DB: D1Database; XBOARD_KV: KVNamespace };

export type OrderDeps<E extends OrderEnv> = {
  nullableNumber: (value: unknown) => number | null;
  parseJsonObject: (value: unknown) => Record<string, any>;
  parseJsonArray: (value: unknown) => any[];
  legacyOrderPeriod: (value: unknown) => string;
  pickSetting: (all: Record<string, any>, key: string, fallback?: any) => any;
  cancelOrder: (env: E, order: Record<string, any>, timestamp: number) => Promise<boolean>;
  normalizeOrderPeriod: (value: unknown) => string;
  userIsAvailable: (user: Record<string, any>) => boolean;
  firstNumber: (env: E, sql: string, bindings?: unknown[]) => Promise<number>;
  canonicalCouponPeriods: (value: unknown) => string[];
  couponResource: (row: Record<string, any>) => Record<string, any>;
  orderSurplus: (env: E, user: Record<string, any>, settingsValues: Record<string, any>) => Promise<{ amount: number; orderIds: number[] }>;
  orderCommission: (env: E, user: Record<string, any>, totalAmount: number) => Promise<{ inviteUserId: number | null; commissionBalance: number }>;
  settleOrder: (env: E, order: Record<string, any>, callbackNo: string) => Promise<boolean>;
};

export async function handleUserOrders<E extends OrderEnv>(
  request: Request,
  env: E,
  route: string,
  user: Record<string, any>,
  deps: OrderDeps<E>
): Promise<Response | null> {
  if (route.startsWith("/order/")) {
    const url = new URL(request.url); const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
    url.searchParams.forEach((value, key) => { input[key] = value; });
    const userId = Number((user as any).id);
    const orderResource = (
      row: Record<string, any>,
      plans?: Map<number, Record<string, any>>,
      payments?: Map<number, Record<string, any>>
    ) => {
      const plan = row.plan_id ? plans?.get(Number(row.plan_id)) || null : null;
      const payment = row.payment_id ? payments?.get(Number(row.payment_id)) || null : null;
      return {
        ...row,
        status: Number(row.status),
        total_amount: Number(row.total_amount || 0),
        period: deps.legacyOrderPeriod(row.period),
        plan: plan ? { ...plan, prices: deps.parseJsonObject(plan.prices), tags: deps.parseJsonArray(plan.tags) } : null,
        payment
      };
    };
    if (request.method === "GET" && route === "/order/fetch") {
      const status = input.status === undefined ? null : deps.nullableNumber(input.status);
      if (input.status !== undefined && (status === null || ![0,1,2,3].includes(status))) return fail("状态参数有误", 422, 422);
      const result = status === null
        ? await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all<Record<string, any>>()
        : await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE user_id = ? AND status = ? ORDER BY created_at DESC").bind(userId, status).all<Record<string, any>>();
      const rows = result.results || [];
      const planIds = [...new Set(rows.map(row => Number(row.plan_id || 0)).filter(Boolean))];
      const paymentIds = [...new Set(rows.map(row => Number(row.payment_id || 0)).filter(Boolean))];
      const [planResult, paymentResult] = await Promise.all([
        planIds.length
          ? env.XBOARD_DB.prepare(`SELECT * FROM v2_plan WHERE id IN (${planIds.map(() => "?").join(",")})`).bind(...planIds).all<Record<string, any>>()
          : Promise.resolve({ success: true, results: [] as Record<string, any>[] }),
        paymentIds.length
          ? env.XBOARD_DB.prepare(`SELECT id,name,payment,icon FROM v2_payment WHERE id IN (${paymentIds.map(() => "?").join(",")})`).bind(...paymentIds).all<Record<string, any>>()
          : Promise.resolve({ success: true, results: [] as Record<string, any>[] })
      ]);
      const plans = new Map((planResult.results || []).map(plan => [Number(plan.id), plan]));
      const payments = new Map((paymentResult.results || []).map(payment => [Number(payment.id), payment]));
      return ok(rows.map(row => orderResource(row, plans, payments)));
    }
    if (request.method === "GET" && route === "/order/detail") {
      const order = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE user_id = ? AND trade_no = ?").bind(userId, String(input.trade_no || "")).first<Record<string, any>>();
      if (!order) return fail("订单不存在或已支付", 400, 400);
      const [plan, payment] = await Promise.all([
        order.plan_id ? env.XBOARD_DB.prepare("SELECT * FROM v2_plan WHERE id = ?").bind(order.plan_id).first<Record<string, any>>() : Promise.resolve(null),
        paymentForOrder(env, order.payment_id)
      ]);
      const value = orderResource(
        order,
        new Map(plan ? [[Number(plan.id), plan]] : []),
        new Map(payment ? [[Number(payment.id), payment]] : [])
      );
      if (!value.plan) return fail("订阅计划不存在", 400, 400);
      const surplusOrderIds = deps.parseJsonArray(order.surplus_order_ids).map(Number).filter(Boolean);
      const surplusResult = surplusOrderIds.length
        ? await env.XBOARD_DB.prepare(`SELECT * FROM v2_order WHERE user_id = ? AND id IN (${surplusOrderIds.map(() => "?").join(",")}) ORDER BY id ASC`).bind(userId, ...surplusOrderIds).all<Record<string, any>>()
        : { results: [] as Record<string, any>[] };
      return ok({ ...value, try_out_plan_id: Number(deps.pickSetting(await settings(env.XBOARD_DB, env.XBOARD_KV), "try_out_plan_id", 0)), surplus_orders: surplusResult.results || [] });
    }
    if (request.method === "GET" && route === "/order/check") {
      const order = await env.XBOARD_DB.prepare("SELECT status FROM v2_order WHERE user_id = ? AND trade_no = ?").bind(userId, String(input.trade_no || "")).first<{ status: number }>();
      return order ? ok(Number(order.status)) : fail("订单不存在", 400, 400);
    }
    if (request.method === "GET" && route === "/order/getPaymentMethod") return ok(await enabledPaymentMethods(env));
    if (request.method === "POST" && route === "/order/cancel") {
      const tradeNo = String(input.trade_no || "");
      if (!tradeNo) return fail("参数无效", 422, 422);
      const order = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE user_id = ? AND trade_no = ?").bind(userId, tradeNo).first<Record<string, any>>();
      if (!order) return fail("订单不存在", 400, 400);
      if (Number(order.status) !== 0) return fail("只能取消待支付订单", 400, 400);
      return await deps.cancelOrder(env, order, now()) ? ok(true) : fail("取消失败", 400, 400);
    }
    if (request.method === "POST" && route === "/order/save") {
      const planId = deps.nullableNumber(input.plan_id); const legacyPeriod = String(input.period || ""); const period = deps.normalizeOrderPeriod(legacyPeriod);
      if (!planId) return fail("套餐ID不能为空", 422, 422);
      if (!period) return fail("套餐周期错误", 422, 422);
      const pending = await env.XBOARD_DB.prepare("SELECT id FROM v2_order WHERE user_id = ? AND status IN (0,1) LIMIT 1").bind(userId).first();
      if (pending) return fail("您有未支付或待处理订单，请先取消", 400, 400);
      const plan = await env.XBOARD_DB.prepare("SELECT * FROM v2_plan WHERE id = ?").bind(planId).first<Record<string, any>>();
      if (!plan) return fail("订阅计划不存在", 400, 400);
      const prices = deps.parseJsonObject(plan.prices); const price = Number(prices[period] ?? prices[legacyPeriod]);
      if (!Number.isFinite(price) || price < 0) return fail("该付款周期未启用", 400, 400);
      const samePlan = Number((user as any).plan_id) === planId;
      const activeUser = deps.userIsAvailable(user as Record<string, any>);
      if (period === "reset_traffic") {
        if (!samePlan || !activeUser) return fail("订阅已过期或无有效订阅，无法购买流量重置包", 400, 400);
      } else {
        if ((!Number(plan.show) && !Number(plan.renew)) || (!Number(plan.show) && !samePlan)) return fail("该订阅已售罄，请选择其他订阅", 400, 400);
        if (!Number(plan.renew) && samePlan) return fail("该订阅无法续费，请更换其他订阅", 400, 400);
        if (!Number(plan.show) && Number(plan.renew) && !activeUser) return fail("该订阅已过期，请更换其他订阅", 400, 400);
      }
      if (plan.capacity_limit !== null && plan.capacity_limit !== undefined) {
        const count = await deps.firstNumber(env, "SELECT COUNT(*) AS c FROM v2_user WHERE plan_id = ? AND (expired_at IS NULL OR expired_at >= ?)", [planId, now()]);
        if (count >= Number(plan.capacity_limit) && Number((user as any).plan_id) !== planId) return fail("该订阅已售罄", 400, 400);
      }
      let totalAmount = Math.trunc(price * 100);
      let discountAmount = 0;
      let couponId: number | null = null;
      let couponHasGlobalLimit = false;
      const couponCode = String(input.coupon_code || "").trim();
      if (couponCode) {
        const coupon = await env.XBOARD_DB.prepare("SELECT * FROM v2_coupon WHERE code = ?").bind(couponCode).first<Record<string, any>>();
        const ts = now();
        if (!coupon || !Number(coupon.show)) return fail("优惠券无效", 400, 400);
        if (coupon.limit_use !== null && Number(coupon.limit_use) <= 0) return fail("优惠券已用完", 400, 400);
        if (Number(coupon.started_at || 0) > ts || Number(coupon.ended_at || 0) < ts) return fail("优惠券不在有效期内", 400, 400);
        const limitedPlans = deps.parseJsonArray(coupon.limit_plan_ids).map(Number);
        if (limitedPlans.length && !limitedPlans.includes(planId)) return fail("优惠券不适用于该套餐", 400, 400);
        const limitedPeriods = deps.canonicalCouponPeriods(coupon.limit_period);
        if (limitedPeriods.length && !limitedPeriods.includes(period)) return fail("优惠券不适用于该周期", 400, 400);
        if (coupon.limit_use_with_user !== null) {
          const used = await env.XBOARD_DB.prepare("SELECT COUNT(*) AS count FROM v2_order WHERE coupon_id = ? AND user_id = ? AND status NOT IN (0,2)").bind(coupon.id, userId).first<{ count: number }>();
          if (Number(used?.count || 0) >= Number(coupon.limit_use_with_user)) return fail("优惠券已达到个人使用次数限制", 400, 400);
        }
        const couponType = Math.trunc(Number.parseFloat(String(coupon.type || 0)));
        discountAmount = couponType === 1 ? Number(coupon.value || 0) : couponType === 2 ? totalAmount * Number(coupon.value || 0) / 100 : 0;
        discountAmount = Math.min(totalAmount, Math.trunc(discountAmount));
        couponId = Number(coupon.id);
        couponHasGlobalLimit = coupon.limit_use !== null;
      }
      if (Number((user as any).discount || 0) > 0) discountAmount += Math.trunc(totalAmount * Number((user as any).discount) / 100);
      discountAmount = Math.min(totalAmount, discountAmount);
      totalAmount -= discountAmount;
      const tradeNo = token(16); const ts = now();
      const hasPlan = (user as any).plan_id !== null && (user as any).plan_id !== undefined;
      const type = period === "reset_traffic" ? 4
        : hasPlan && Number((user as any).plan_id) !== planId && ((user as any).expired_at === null || Number((user as any).expired_at) > ts) ? 3
        : Number((user as any).plan_id) === planId && ((user as any).expired_at === null || Number((user as any).expired_at) > ts) ? 2 : 1;
      const allSettings = await settings(env.XBOARD_DB, env.XBOARD_KV);
      if (type === 3 && !Number(deps.pickSetting(allSettings, "plan_change_enable", 1))) return fail("目前不允许更改订阅，请联系客服或提交工单操作", 400, 400);
      const currentUser = await env.XBOARD_DB.prepare("SELECT * FROM v2_user WHERE id = ?").bind(userId).first<Record<string, any>>() || user as Record<string, any>;
      let surplusAmount = 0;
      let surplusCredit = 0;
      let surplusOrderIds: number[] = [];
      if (type === 3 && Number(deps.pickSetting(allSettings, "surplus_enable", 1))) {
        const surplus = await deps.orderSurplus(env, currentUser, allSettings);
        surplusAmount = surplus.amount;
        surplusOrderIds = surplus.orderIds;
        if (surplusAmount >= totalAmount) {
          surplusCredit = surplusAmount - totalAmount;
          totalAmount = 0;
        } else {
          totalAmount -= surplusAmount;
        }
      }
      const commission = await deps.orderCommission(env, currentUser, totalAmount);
      const payableAmount = totalAmount;
      const couponAvailability = couponHasGlobalLimit ? " AND EXISTS (SELECT 1 FROM v2_coupon WHERE id=? AND limit_use>0)" : "";
      const statements = [env.XBOARD_DB.prepare(`INSERT INTO v2_order(user_id, plan_id, period, trade_no, status, total_amount, balance_amount, discount_amount, coupon_id, type, surplus_amount, surplus_credit, surplus_order_ids, invite_user_id, commission_balance, created_at, updated_at)
        SELECT ?,?,?,?,0,MAX(0,?-MIN(MAX(COALESCE(u.balance,0),0),?)),MIN(MAX(COALESCE(u.balance,0),0),?),?,?,?,?,?,?,?,?,?,?
        FROM v2_user u WHERE u.id=? AND NOT EXISTS (SELECT 1 FROM v2_order WHERE user_id=u.id AND status IN (0,1))${couponAvailability}`)
        .bind(userId, planId, period, tradeNo, payableAmount, payableAmount, payableAmount, discountAmount, couponId, type, surplusAmount, surplusCredit, JSON.stringify(surplusOrderIds), commission.inviteUserId, commission.commissionBalance, ts, ts, userId, ...(couponHasGlobalLimit ? [couponId] : []))];
      statements.push(env.XBOARD_DB.prepare(`UPDATE v2_user SET balance=balance-(SELECT balance_amount FROM v2_order WHERE trade_no=?),updated_at=?
        WHERE id=? AND EXISTS (SELECT 1 FROM v2_order WHERE trade_no=? AND user_id=? AND status=0) AND (SELECT balance_amount FROM v2_order WHERE trade_no=?)>0`)
        .bind(tradeNo, ts, userId, tradeNo, userId, tradeNo));
      if (couponHasGlobalLimit) statements.push(env.XBOARD_DB.prepare("UPDATE v2_coupon SET limit_use=limit_use-1,updated_at=? WHERE id=? AND limit_use>0 AND EXISTS (SELECT 1 FROM v2_order WHERE trade_no=?)").bind(ts, couponId, tradeNo));
      const results = await env.XBOARD_DB.batch(statements);
      if (Number((results[0]?.meta as any)?.changes || 0) !== 1) return couponHasGlobalLimit
        ? fail("优惠券已用完", 400, 400)
        : fail("您有未支付或开通中的订单，请稍后再试或取消它", 400, 400);
      return ok(tradeNo);
    }
    if (request.method === "POST" && route === "/order/checkout") {
      const order = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE user_id = ? AND trade_no = ? AND status = 0").bind(userId, String(input.trade_no || "")).first<Record<string, any>>();
      if (!order) return fail("订单不存在或已支付", 400, 400);
      return checkoutPayment(request, env, order, user, input.method, (paidOrder, callbackNo) => deps.settleOrder(env, paidOrder, callbackNo));
    }
  }
  return null;
}
