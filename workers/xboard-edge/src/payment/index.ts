import { body, fail, json, now, ok, randomString } from "../compat.ts";
import { settings } from "../db.ts";
import { PaymentError, paymentMethodNames, paymentProviders } from "./providers.ts";
import type { PaymentConfig, PaymentEnv, PaymentRow } from "./types.ts";

type SettleOrder = (order: Record<string, any>, callbackNo: string) => Promise<boolean>;

function parseConfig(value: unknown): PaymentConfig {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as PaymentConfig;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeHttpsOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new PaymentError("通知域名必须是 HTTPS 地址", 422);
  return url.origin;
}

function paymentNotifyUrl(request: Request, payment: PaymentRow, appUrl: string) {
  const path = `/api/v1/guest/payment/notify/${encodeURIComponent(payment.payment)}/${encodeURIComponent(payment.uuid)}`;
  const base = payment.notify_domain ? safeHttpsOrigin(String(payment.notify_domain)) : new URL(appUrl || request.url).origin;
  return `${base}${path}`;
}

async function ensurePaymentSchema(env: PaymentEnv) {
  await env.XBOARD_DB.prepare(`CREATE TABLE IF NOT EXISTS v2_payment_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    trade_no TEXT NOT NULL,
    payment_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_reference TEXT,
    expected_amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    checkout_url TEXT,
    idempotency_key TEXT NOT NULL,
    event_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(order_id, payment_id),
    UNIQUE(provider, provider_reference),
    UNIQUE(provider, event_id),
    UNIQUE(idempotency_key)
  )`).run();
  await env.XBOARD_DB.prepare("CREATE INDEX IF NOT EXISTS idx_payment_transactions_trade ON v2_payment_transactions(trade_no, payment_id)").run();
  await env.XBOARD_DB.prepare("CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON v2_payment_transactions(status, updated_at)").run();
}

function paymentResource(row: PaymentRow, request: Request, appUrl: string) {
  return {
    ...row,
    id: Number(row.id),
    enable: Boolean(Number(row.enable)),
    handling_fee_fixed: row.handling_fee_fixed === null ? null : Number(row.handling_fee_fixed),
    handling_fee_percent: row.handling_fee_percent === null ? null : Number(row.handling_fee_percent),
    sort: Number(row.sort || 0),
    config: parseConfig(row.config),
    notify_url: paymentNotifyUrl(request, row, appUrl)
  };
}

export async function handleAdminPayment(request: Request, env: PaymentEnv, route: string): Promise<Response | null> {
  if (!route.startsWith("/payment/")) return null;
  if (request.method === "GET" && route === "/payment/getPaymentMethods") return ok(paymentMethodNames);
  const allSettings = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const appUrl = String(allSettings.app_url || "");
  if (request.method === "GET" && route === "/payment/fetch") {
    const result = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment ORDER BY sort ASC, id ASC").all<PaymentRow>();
    return ok((result.results || []).map(row => paymentResource(row, request, appUrl)));
  }
  const input = await body<Record<string, any>>(request.clone());
  if (request.method === "POST" && route === "/payment/getPaymentForm") {
    const provider = paymentProviders.get(String(input.payment || ""));
    if (!provider) return fail("支付方式不存在或未启用", 400, 400);
    let config: PaymentConfig = {};
    if (input.id) {
      const row = await env.XBOARD_DB.prepare("SELECT config, payment FROM v2_payment WHERE id = ?").bind(Number(input.id)).first<{ config: string; payment: string }>();
      if (!row || row.payment !== provider.method) return fail("支付方式不存在或未启用", 400, 400);
      config = parseConfig(row.config);
    }
    return ok(Object.fromEntries(Object.entries(provider.form).map(([key, definition]) => [key, {
      type: definition.type,
      label: definition.label,
      placeholder: definition.placeholder || "",
      description: definition.description || "",
      value: config[key] ?? definition.default ?? "",
      options: definition.options || []
    }])));
  }
  if (request.method === "POST" && route === "/payment/save") {
    if (!appUrl) return fail("请在站点配置中配置站点地址", 400, 400);
    const name = String(input.name || "").trim();
    const method = String(input.payment || "").trim();
    const provider = paymentProviders.get(method);
    const config = parseConfig(input.config);
    if (!name) return fail("显示名称不能为空", 422, 422);
    if (!provider) return fail("网关参数无效", 422, 422);
    try { provider.validateConfig(config); } catch (error) {
      return fail(error instanceof PaymentError ? error.message : "支付配置无效", 422, 422);
    }
    const fixed = numberOrNull(input.handling_fee_fixed);
    const percent = numberOrNull(input.handling_fee_percent);
    if (fixed !== null && (!Number.isInteger(fixed) || fixed < 0)) return fail("固定手续费格式有误", 422, 422);
    if (percent !== null && (percent < 0 || percent > 100)) return fail("百分比手续费范围须在0-100之间", 422, 422);
    let notifyDomain: string | null = String(input.notify_domain || "").trim() || null;
    try { if (notifyDomain) notifyDomain = safeHttpsOrigin(notifyDomain); } catch (error) {
      return fail(error instanceof Error ? error.message : "自定义通知域名格式有误", 422, 422);
    }
    const timestamp = now();
    if (input.id) {
      const result = await env.XBOARD_DB.prepare(`UPDATE v2_payment
        SET name=?,payment=?,config=?,icon=?,handling_fee_fixed=?,handling_fee_percent=?,notify_domain=?,updated_at=?
        WHERE id=?`)
        .bind(name, method, JSON.stringify(config), String(input.icon || provider.icon), fixed, percent, notifyDomain, timestamp, Number(input.id)).run();
      if (Number((result.meta as any)?.changes || 0) !== 1) return fail("支付方式不存在", 400, 400202);
    } else {
      await env.XBOARD_DB.prepare(`INSERT INTO v2_payment
        (name,payment,config,enable,uuid,icon,handling_fee_fixed,handling_fee_percent,notify_domain,sort,created_at,updated_at)
        VALUES (?,?,?,0,?,?,?,?,?,COALESCE((SELECT MAX(sort)+1 FROM v2_payment),1),?,?)`)
        .bind(name, method, JSON.stringify(config), randomString(8), String(input.icon || provider.icon), fixed, percent, notifyDomain, timestamp, timestamp).run();
    }
    return ok(true);
  }
  if (request.method === "POST" && route === "/payment/sort") {
    const ids = (Array.isArray(input.ids) ? input.ids : []).map(Number).filter(value => Number.isInteger(value) && value > 0);
    if (!ids.length) return fail("参数有误", 422, 422);
    const timestamp = now();
    await env.XBOARD_DB.batch(ids.map((paymentId, index) => env.XBOARD_DB.prepare("UPDATE v2_payment SET sort=?,updated_at=? WHERE id=?").bind(index + 1, timestamp, paymentId)));
    return ok(true);
  }
  const id = Number(input.id || 0);
  if (!Number.isInteger(id) || id < 1) return fail("参数有误", 422, 422);
  if (request.method === "POST" && route === "/payment/show") {
    const result = await env.XBOARD_DB.prepare("UPDATE v2_payment SET enable=CASE WHEN enable=1 THEN 0 ELSE 1 END,updated_at=? WHERE id=?").bind(now(), id).run();
    return Number((result.meta as any)?.changes || 0) === 1 ? ok(true) : fail("支付方式不存在", 400, 400202);
  }
  if (request.method === "POST" && route === "/payment/drop") {
    const result = await env.XBOARD_DB.prepare("DELETE FROM v2_payment WHERE id=?").bind(id).run();
    return Number((result.meta as any)?.changes || 0) === 1 ? ok(true) : fail("支付方式不存在", 400, 400202);
  }
  return null;
}

export async function enabledPaymentMethods(env: PaymentEnv) {
  const result = await env.XBOARD_DB.prepare(`SELECT id,name,payment,icon,handling_fee_fixed,handling_fee_percent
    FROM v2_payment WHERE enable=1 ORDER BY sort ASC,id ASC`).all<Record<string, any>>();
  return (result.results || []).filter(row => paymentProviders.has(String(row.payment))).map(row => ({
    ...row,
    id: Number(row.id),
    handling_fee_fixed: row.handling_fee_fixed === null ? null : Number(row.handling_fee_fixed),
    handling_fee_percent: row.handling_fee_percent === null ? null : Number(row.handling_fee_percent)
  }));
}

export async function paymentForOrder(env: PaymentEnv, paymentId: unknown) {
  const id = Number(paymentId || 0);
  if (!id) return null;
  const row = await env.XBOARD_DB.prepare("SELECT id,name,payment,icon FROM v2_payment WHERE id=?").bind(id).first<Record<string, any>>();
  return row ? { ...row, id: Number(row.id) } : null;
}

export async function checkoutPayment(
  request: Request,
  env: PaymentEnv,
  order: Record<string, any>,
  user: Record<string, any>,
  methodId: unknown,
  settle: SettleOrder
) {
  if (Number(order.total_amount || 0) <= 0) {
    return await settle(order, String(order.trade_no))
      ? json({ type: -1, data: true })
      : fail("支付失败", 400, 400);
  }
  const payment = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment WHERE id=? AND enable=1")
    .bind(Number(methodId || 0)).first<PaymentRow>();
  if (!payment) return fail("支付方式不可用", 400, 400);
  const provider = paymentProviders.get(String(payment.payment));
  if (!provider) return fail("支付方式不可用", 400, 400);
  const config = parseConfig(payment.config);
  try { provider.validateConfig(config); } catch (error) {
    return fail(error instanceof PaymentError ? error.message : "支付配置无效", 400, 400);
  }
  const fixed = Number(payment.handling_fee_fixed || 0);
  const percent = Number(payment.handling_fee_percent || 0);
  const handlingAmount = Math.round(Number(order.total_amount) * percent / 100 + fixed);
  const expectedAmount = Number(order.total_amount) + handlingAmount;
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const currency = String(all.currency || "CNY").trim().toUpperCase();
  const appUrl = String(all.app_url || "").trim();
  if (!appUrl) return fail("站点地址尚未配置", 400, 400);
  if (provider.method === "AlipayF2F" && currency !== "CNY") return fail("支付宝当面付仅支持 CNY 订单", 400, 400);
  if (provider.method === "CoinPayments" && String(config.coinpayments_currency || "").toUpperCase() !== currency) {
    return fail("CoinPayments 货币必须与站点货币一致", 400, 400);
  }
  if (provider.method === "MGate" && config.mgate_source_currency
    && String(config.mgate_source_currency).toUpperCase() !== currency) {
    return fail("MGate 源货币必须与站点货币一致", 400, 400);
  }
  await ensurePaymentSchema(env);
  const timestamp = now();
  const insertKey = crypto.randomUUID();
  await env.XBOARD_DB.prepare(`INSERT OR IGNORE INTO v2_payment_transactions
    (order_id,trade_no,payment_id,provider,expected_amount,currency,idempotency_key,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'pending',?,?)`)
    .bind(order.id, order.trade_no, payment.id, provider.method, expectedAmount, currency, insertKey, timestamp, timestamp).run();
  let transaction = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment_transactions WHERE order_id=? AND payment_id=?")
    .bind(order.id, payment.id).first<Record<string, any>>();
  if (!transaction) return fail("创建支付会话失败", 500, 500);
  if ((Number(transaction.expected_amount) !== expectedAmount || String(transaction.currency) !== currency)
    && String(transaction.status) !== "paid") {
    await env.XBOARD_DB.prepare(`UPDATE v2_payment_transactions SET
      provider_reference=NULL,expected_amount=?,currency=?,checkout_url=NULL,idempotency_key=?,
      event_id=NULL,status='pending',expires_at=NULL,updated_at=? WHERE id=?`)
      .bind(expectedAmount, currency, crypto.randomUUID(), timestamp, transaction.id).run();
    transaction = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment_transactions WHERE id=?")
      .bind(transaction.id).first<Record<string, any>>() || transaction;
  }
  if (transaction.checkout_url && (!transaction.expires_at || Number(transaction.expires_at) > timestamp + 30)) {
    await env.XBOARD_DB.prepare("UPDATE v2_order SET payment_id=?,handling_amount=?,updated_at=? WHERE id=? AND status=0")
      .bind(payment.id, expectedAmount - Number(order.total_amount), timestamp, order.id).run();
    return json({ type: provider.method === "AlipayF2F" ? 0 : 1, data: String(transaction.checkout_url) });
  }
  const claim = await env.XBOARD_DB.prepare("UPDATE v2_payment_transactions SET status='creating',updated_at=? WHERE id=? AND status IN ('pending','failed')")
    .bind(timestamp, transaction.id).run();
  if (Number((claim.meta as any)?.changes || 0) !== 1) return fail("支付会话正在创建，请稍后重试", 409, 409);
  const callbackPath = `/api/v1/guest/payment/notify/${encodeURIComponent(provider.method)}/${encodeURIComponent(String(payment.uuid))}`;
  const notifyBase = payment.notify_domain ? safeHttpsOrigin(String(payment.notify_domain)) : new URL(appUrl).origin;
  const returnUrl = `${appUrl.replace(/\/$/, "")}/#/order/${encodeURIComponent(String(order.trade_no))}`;
  try {
    const result = await provider.createCheckout({
      config,
      tradeNo: String(order.trade_no),
      amount: expectedAmount,
      currency,
      userId: Number(user.id),
      userEmail: String(user.email || ""),
      appName: String(all.app_name || "XBoard"),
      notifyUrl: `${notifyBase}${callbackPath}`,
      returnUrl,
      idempotencyKey: String(transaction.idempotency_key)
    });
    const results = await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare(`UPDATE v2_payment_transactions SET provider_reference=?,checkout_url=?,status='ready',expires_at=?,updated_at=?
        WHERE id=? AND status='creating'`).bind(result.providerReference || null, result.data, result.expiresAt || null, now(), transaction.id),
      env.XBOARD_DB.prepare("UPDATE v2_order SET payment_id=?,handling_amount=?,updated_at=? WHERE id=? AND status=0")
        .bind(payment.id, handlingAmount, now(), order.id)
    ]);
    if (Number((results[1]?.meta as any)?.changes || 0) !== 1) return fail("订单状态已变化", 400, 400);
    return json({ type: result.type, data: result.data });
  } catch (error) {
    await env.XBOARD_DB.prepare("UPDATE v2_payment_transactions SET status='failed',updated_at=? WHERE id=? AND status='creating'")
      .bind(now(), transaction.id).run();
    return fail(error instanceof PaymentError ? error.message : "创建支付失败", error instanceof PaymentError ? error.status : 502, 400);
  }
}

function exactAmount(actual: number | undefined, expected: number) {
  return actual !== undefined && Number.isInteger(actual) && actual === expected;
}

export async function handlePaymentCallback(
  request: Request,
  env: PaymentEnv,
  method: string,
  paymentUuid: string,
  settle: SettleOrder
) {
  const provider = paymentProviders.get(method);
  if (!provider) return new Response("payment method not found", { status: 404 });
  // Disabling a method blocks new checkouts, but an already-paid checkout must
  // still be verifiable. The order payment_id and transaction reference below
  // prevent callbacks from an old or switched method from settling the order.
  const payment = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment WHERE payment=? AND uuid=?")
    .bind(method, paymentUuid).first<PaymentRow>();
  if (!payment) return new Response("payment method unavailable", { status: 404 });
  const config = parseConfig(payment.config);
  try {
    const callback = await provider.verifyCallback(request, config);
    if (callback.state !== "paid") return new Response(callback.responseText, { status: 200 });
    if (!callback.tradeNo || !callback.callbackNo || !callback.providerReference) throw new PaymentError("支付回调缺少订单标识", 400);
    const order = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE trade_no=?").bind(callback.tradeNo).first<Record<string, any>>();
    if (!order) throw new PaymentError("订单不存在", 404);
    if (Number(order.payment_id || 0) !== Number(payment.id)) throw new PaymentError("订单支付渠道不匹配", 400);
    const expectedAmount = Number(order.total_amount || 0) + Number(order.handling_amount || 0);
    if (!exactAmount(callback.amount, expectedAmount)) throw new PaymentError("支付金额不匹配", 400);
    const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
    const expectedCurrency = String(all.currency || "CNY").toUpperCase();
    if (!callback.currency || callback.currency.toUpperCase() !== expectedCurrency) throw new PaymentError("支付币种不匹配", 400);
    await ensurePaymentSchema(env);
    const timestamp = now();
    const existing = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment_transactions WHERE order_id=? AND payment_id=?")
      .bind(order.id, payment.id).first<Record<string, any>>();
    if (existing?.provider_reference && String(existing.provider_reference) !== callback.providerReference) {
      throw new PaymentError("支付会话标识不匹配", 400);
    }
    if (!existing) {
      await env.XBOARD_DB.prepare(`INSERT INTO v2_payment_transactions
        (order_id,trade_no,payment_id,provider,provider_reference,expected_amount,currency,idempotency_key,event_id,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'verified',?,?)`)
        .bind(order.id, order.trade_no, payment.id, method, callback.providerReference, expectedAmount, expectedCurrency, crypto.randomUUID(), callback.callbackNo, timestamp, timestamp).run();
    } else {
      await env.XBOARD_DB.prepare(`UPDATE v2_payment_transactions
        SET provider_reference=COALESCE(provider_reference,?),event_id=COALESCE(event_id,?),status='verified',updated_at=?
        WHERE id=?`).bind(callback.providerReference, callback.callbackNo, timestamp, existing.id).run();
    }
    const settled = await settle(order, callback.callbackNo);
    if (!settled) throw new PaymentError("订单开通失败", 500);
    await env.XBOARD_DB.prepare("UPDATE v2_payment_transactions SET status='paid',event_id=?,updated_at=? WHERE order_id=? AND payment_id=?")
      .bind(callback.callbackNo, now(), order.id, payment.id).run();
    return new Response(callback.responseText, { status: 200 });
  } catch (error) {
    const status = error instanceof PaymentError ? error.status : 500;
    return new Response(status >= 500 ? "temporary failure" : "invalid callback", { status });
  }
}

export const __test = {
  parseConfig,
  exactAmount,
  paymentNotifyUrl,
  safeHttpsOrigin
};
