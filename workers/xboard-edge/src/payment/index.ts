import { body, fail, json, now, ok, randomString } from "../compat.ts";
import { settings } from "../db.ts";
import { isPrivateNetworkHost, PaymentError, paymentMethodNames, paymentProviders } from "./providers.ts";
import type { PaymentConfig, PaymentEnv, PaymentRow } from "./types.ts";

type SettleOrder = (order: Record<string, any>, callbackNo: string) => Promise<boolean>;
const MAX_CALLBACK_BODY_BYTES = 512 * 1024;
const PAYMENT_CREATE_STALE_SECONDS = 120;
let paymentSchemaPromise: Promise<void> | null = null;

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

export function safeHttpsOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || isPrivateNetworkHost(url.hostname)) {
    throw new PaymentError("通知域名必须是公开可访问的 HTTPS 地址", 422);
  }
  return url.origin;
}

function isLoopbackHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host.endsWith(".localhost") || /^127\./.test(host);
}

export function safeAppOrigin(value: string) {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if ((!localHttp && url.protocol !== "https:") || url.username || url.password) {
    throw new PaymentError("站点地址必须是 HTTPS 地址", 422);
  }
  return url.origin;
}

export function safeNotificationOrigin(value: string) {
  const origin = safeAppOrigin(value);
  const url = new URL(origin);
  const localTestOrigin = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!localTestOrigin && isPrivateNetworkHost(url.hostname)) {
    throw new PaymentError("支付通知地址必须是公开可访问的 HTTPS 地址", 422);
  }
  return origin;
}

function safeCheckoutUrl(value: unknown) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.username || url.password || isPrivateNetworkHost(url.hostname)) {
    throw new PaymentError("支付服务返回了不安全的支付地址", 502);
  }
  return url.toString();
}

function paymentNotifyUrl(request: Request, payment: PaymentRow, appUrl: string) {
  const path = `/api/v1/guest/payment/notify/${encodeURIComponent(payment.payment)}/${encodeURIComponent(payment.uuid)}`;
  let base = new URL(request.url).origin;
  try {
    base = payment.notify_domain ? safeHttpsOrigin(String(payment.notify_domain)) : safeNotificationOrigin(appUrl);
  } catch {
    // A migrated invalid URL must not break the entire payment settings page.
  }
  return `${base}${path}`;
}

async function ensurePaymentSchema(env: PaymentEnv) {
  if (paymentSchemaPromise) return paymentSchemaPromise;
  const pending = (async () => {
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
    await env.XBOARD_DB.prepare(`UPDATE v2_payment_transactions
      SET provider=provider || ':' || payment_id
      WHERE provider IN (${paymentMethodNames.map(() => "?").join(",")})`)
      .bind(...paymentMethodNames).run();
  })();
  paymentSchemaPromise = pending;
  try {
    await pending;
  } catch (error) {
    paymentSchemaPromise = null;
    throw error;
  }
}

async function validatePaymentActivation(env: PaymentEnv, payment: PaymentRow, appUrl: string) {
  const provider = paymentProviders.get(String(payment.payment || ""));
  if (!provider) throw new PaymentError("支付方式不存在或未启用", 422);
  if (!String(payment.uuid || "").trim()) throw new PaymentError("支付渠道缺少回调 UUID，请停用后新建渠道", 422);
  if (!appUrl) throw new PaymentError("请在站点配置中配置站点地址", 422);
  try { safeNotificationOrigin(appUrl); } catch (error) {
    throw error instanceof PaymentError ? error : new PaymentError("站点地址必须是 HTTPS 地址", 422);
  }
  if (payment.notify_domain) safeHttpsOrigin(String(payment.notify_domain));
  provider.validateConfig(parseConfig(payment.config));
  const duplicate = await env.XBOARD_DB.prepare("SELECT COUNT(*) AS count FROM v2_payment WHERE payment=? AND uuid=?")
    .bind(payment.payment, payment.uuid).first<{ count: number }>();
  if (Number(duplicate?.count || 0) !== 1) throw new PaymentError("支付渠道回调 UUID 重复，请停用后新建渠道", 409);
}

async function hasPaymentTransactions(env: PaymentEnv, paymentId: number) {
  await ensurePaymentSchema(env);
  const row = await env.XBOARD_DB.prepare("SELECT 1 AS found FROM v2_payment_transactions WHERE payment_id=? LIMIT 1")
    .bind(paymentId).first<{ found: number }>();
  return Boolean(row);
}

async function hasPaymentReferences(env: PaymentEnv, paymentId: number) {
  if (await hasPaymentTransactions(env, paymentId)) return true;
  const row = await env.XBOARD_DB.prepare("SELECT 1 AS found FROM v2_order WHERE payment_id=? LIMIT 1")
    .bind(paymentId).first<{ found: number }>();
  return Boolean(row);
}

async function uniquePaymentUuid(env: PaymentEnv, method: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const uuid = randomString(8);
    const existing = await env.XBOARD_DB.prepare("SELECT 1 AS found FROM v2_payment WHERE payment=? AND uuid=? LIMIT 1")
      .bind(method, uuid).first<{ found: number }>();
    if (!existing) return uuid;
  }
  throw new PaymentError("无法生成唯一的支付回调标识，请重试", 503);
}

function stableConfig(config: PaymentConfig) {
  return JSON.stringify(Object.fromEntries(Object.entries(config).sort(([left], [right]) => left.localeCompare(right))));
}

function transactionProvider(method: string, paymentId: number) {
  return `${method}:${paymentId}`;
}

function transactionProviderMatches(value: unknown, method: string, paymentId: number) {
  const provider = String(value || "");
  return provider === method || provider === transactionProvider(method, paymentId);
}

async function boundedCallbackRequest(request: Request) {
  if (request.method === "GET" || request.body === null) return request;
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_CALLBACK_BODY_BYTES) throw new PaymentError("支付回调正文过大", 413);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > MAX_CALLBACK_BODY_BYTES) {
      await reader.cancel();
      throw new PaymentError("支付回调正文过大", 413);
    }
    chunks.push(chunk.value);
  }
  const bodyBytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body: bodyBytes });
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
      const paymentId = Number(input.id);
      const existing = await env.XBOARD_DB.prepare("SELECT payment,config,notify_domain,enable FROM v2_payment WHERE id=?")
        .bind(paymentId).first<{ payment: string; config: string; notify_domain: string | null; enable: number }>();
      if (!existing) return fail("支付方式不存在", 400, 400202);
      if (existing.payment !== method) return fail("已有支付渠道不能更换 Provider，请新建渠道", 409, 409);
      const changesCredentials = stableConfig(parseConfig(existing.config)) !== stableConfig(config);
      const changesNotifyDomain = String(existing.notify_domain || "") !== String(notifyDomain || "");
      const changesTransport = changesCredentials || changesNotifyDomain;
      if (changesTransport && Number(existing.enable)) {
        return fail("请先停用支付渠道再修改网关密钥或通知域名", 409, 409);
      }
      if (changesTransport) await ensurePaymentSchema(env);
      const updatePayment = env.XBOARD_DB.prepare(`UPDATE v2_payment
        SET name=?,payment=?,config=?,icon=?,handling_fee_fixed=?,handling_fee_percent=?,notify_domain=?,updated_at=?
        WHERE id=?
          AND (?=0 OR enable=0)`)
        .bind(name, method, JSON.stringify(config), String(input.icon || provider.icon), fixed, percent, notifyDomain,
          timestamp, paymentId, changesTransport ? 1 : 0);
      const statements = [updatePayment];
      if (changesTransport) {
        statements.push(
          env.XBOARD_DB.prepare(`UPDATE v2_order
            SET payment_id=NULL,handling_amount=0,updated_at=?
            WHERE payment_id=? AND status=0
              AND EXISTS (SELECT 1 FROM v2_payment WHERE id=? AND enable=0)
              AND NOT EXISTS (SELECT 1 FROM v2_payment_transactions
                WHERE order_id=v2_order.id AND payment_id=? AND status IN ('paid','paid_unapplied'))`)
            .bind(timestamp, paymentId, paymentId, paymentId),
          env.XBOARD_DB.prepare(`DELETE FROM v2_payment_transactions
            WHERE payment_id=? AND status NOT IN ('paid','paid_unapplied')
              AND EXISTS (SELECT 1 FROM v2_payment WHERE id=? AND enable=0)`).bind(paymentId, paymentId)
        );
      }
      const [result] = await env.XBOARD_DB.batch(statements);
      if (Number((result.meta as any)?.changes || 0) !== 1) {
        return changesTransport
          ? fail("支付渠道状态已变化，请刷新后重试", 409, 409)
          : fail("支付方式不存在", 400, 400202);
      }
    } else {
      const uuid = await uniquePaymentUuid(env, method);
      await env.XBOARD_DB.prepare(`INSERT INTO v2_payment
        (name,payment,config,enable,uuid,icon,handling_fee_fixed,handling_fee_percent,notify_domain,sort,created_at,updated_at)
        VALUES (?,?,?,0,?,?,?,?,?,COALESCE((SELECT MAX(sort)+1 FROM v2_payment),1),?,?)`)
        .bind(name, method, JSON.stringify(config), uuid, String(input.icon || provider.icon), fixed, percent, notifyDomain, timestamp, timestamp).run();
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
    const payment = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment WHERE id=?").bind(id).first<PaymentRow>();
    if (!payment) return fail("支付方式不存在", 400, 400202);
    if (!Number(payment.enable)) {
      try { await validatePaymentActivation(env, payment, appUrl); } catch (error) {
        const status = error instanceof PaymentError ? error.status : 422;
        return fail(error instanceof PaymentError ? error.message : "支付配置无效", status, status);
      }
    }
    const result = await env.XBOARD_DB.prepare("UPDATE v2_payment SET enable=?,updated_at=? WHERE id=? AND enable=?")
      .bind(Number(payment.enable) ? 0 : 1, now(), id, Number(payment.enable) ? 1 : 0).run();
    return Number((result.meta as any)?.changes || 0) === 1 ? ok(true) : fail("支付方式不存在", 400, 400202);
  }
  if (request.method === "POST" && route === "/payment/drop") {
    if (await hasPaymentReferences(env, id)) return fail("该渠道已有订单或支付记录，只能停用，不能删除", 409, 409);
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
  const callbackUuid = String(payment.uuid || "").trim();
  if (!callbackUuid) return fail("支付渠道缺少回调 UUID，请停用后新建渠道", 409, 409);
  const provider = paymentProviders.get(String(payment.payment));
  if (!provider) return fail("支付方式不可用", 400, 400);
  const config = parseConfig(payment.config);
  try { provider.validateConfig(config); } catch (error) {
    return fail(error instanceof PaymentError ? error.message : "支付配置无效", 400, 400);
  }
  const orderAmount = Number(order.total_amount);
  const fixed = Number(payment.handling_fee_fixed || 0);
  const percent = Number(payment.handling_fee_percent || 0);
  const initialHandlingAmount = Math.round(orderAmount * percent / 100 + fixed);
  const initialExpectedAmount = orderAmount + initialHandlingAmount;
  const all = await settings(env.XBOARD_DB, env.XBOARD_KV);
  const initialCurrency = String(all.currency || "CNY").trim().toUpperCase();
  const appUrl = String(all.app_url || "").trim();
  if (!appUrl) return fail("站点地址尚未配置", 400, 400);
  let appOrigin: string;
  let notifyBase: string;
  try {
    appOrigin = safeAppOrigin(appUrl);
    notifyBase = payment.notify_domain ? safeHttpsOrigin(String(payment.notify_domain)) : safeNotificationOrigin(appUrl);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "站点或通知地址无效", 422, 422);
  }
  if (!Number.isSafeInteger(orderAmount) || orderAmount <= 0 || !Number.isSafeInteger(initialExpectedAmount)
    || initialExpectedAmount <= 0 || !Number.isFinite(percent) || percent < 0 || percent > 100
    || !Number.isSafeInteger(fixed) || fixed < 0 || !/^[A-Z]{3}$/.test(initialCurrency)) {
    return fail("订单金额、手续费或币种无效", 400, 400);
  }
  await ensurePaymentSchema(env);
  const timestamp = now();
  const providerScope = transactionProvider(provider.method, Number(payment.id));
  let transaction = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment_transactions WHERE order_id=? AND payment_id=?")
    .bind(order.id, payment.id).first<Record<string, any>>();
  if (!transaction) {
    if (provider.method === "AlipayF2F" && initialCurrency !== "CNY") return fail("支付宝当面付仅支持 CNY 订单", 400, 400);
    if (provider.method === "EPay" && initialCurrency !== "CNY") return fail("易支付仅支持 CNY 订单", 400, 400);
    if (provider.method === "CoinPayments" && String(config.coinpayments_currency || "").toUpperCase() !== initialCurrency) {
      return fail("CoinPayments 货币必须与站点货币一致", 400, 400);
    }
    if (provider.method === "MGate" && config.mgate_source_currency
      && String(config.mgate_source_currency).toUpperCase() !== initialCurrency) {
      return fail("MGate 源货币必须与站点货币一致", 400, 400);
    }
    const insertKey = crypto.randomUUID();
    await env.XBOARD_DB.prepare(`INSERT OR IGNORE INTO v2_payment_transactions
      (order_id,trade_no,payment_id,provider,expected_amount,currency,idempotency_key,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'pending',?,?)`)
      .bind(order.id, order.trade_no, payment.id, providerScope, initialExpectedAmount, initialCurrency, insertKey, timestamp, timestamp).run();
    transaction = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment_transactions WHERE order_id=? AND payment_id=?")
      .bind(order.id, payment.id).first<Record<string, any>>();
  }
  if (!transaction) return fail("创建支付会话失败", 500, 500);
  if (!transactionProviderMatches(transaction.provider, provider.method, Number(payment.id))
    || String(transaction.trade_no) !== String(order.trade_no)) {
    return fail("支付交易与订单不匹配", 409, 409);
  }
  const expectedAmount = Number(transaction.expected_amount);
  const currency = String(transaction.currency || "").toUpperCase();
  const handlingAmount = expectedAmount - orderAmount;
  if (!Number.isSafeInteger(expectedAmount) || expectedAmount <= 0 || !Number.isSafeInteger(handlingAmount)
    || handlingAmount < 0 || !/^[A-Z]{3}$/.test(currency)) return fail("支付交易金额或币种无效", 409, 409);
  if (provider.method === "AlipayF2F" && currency !== "CNY") return fail("支付宝当面付仅支持 CNY 订单", 400, 400);
  if (provider.method === "EPay" && currency !== "CNY") return fail("易支付仅支持 CNY 订单", 400, 400);
  if (provider.method === "CoinPayments" && String(config.coinpayments_currency || "").toUpperCase() !== currency) {
    return fail("CoinPayments 货币必须与站点货币一致", 400, 400);
  }
  if (provider.method === "MGate" && config.mgate_source_currency
    && String(config.mgate_source_currency).toUpperCase() !== currency) {
    return fail("MGate 源货币必须与站点货币一致", 400, 400);
  }
  if (String(transaction.status) === "paid") return fail("支付已确认，订单正在开通", 409, 409);
  if (transaction.checkout_url && transaction.expires_at && Number(transaction.expires_at) <= timestamp + 30) {
    return fail("支付会话已过期，请取消当前订单后重新下单", 409, 409);
  }
  if (transaction.checkout_url) {
    let checkoutUrl: string;
    try {
      checkoutUrl = safeCheckoutUrl(transaction.checkout_url);
    } catch {
      await env.XBOARD_DB.prepare("UPDATE v2_payment_transactions SET checkout_url=NULL,status='failed',updated_at=? WHERE id=?")
        .bind(timestamp, transaction.id).run();
      transaction = { ...transaction, checkout_url: null, status: "failed" };
      checkoutUrl = "";
    }
    if (checkoutUrl) {
      const rebound = await env.XBOARD_DB.prepare("UPDATE v2_order SET payment_id=?,handling_amount=?,updated_at=? WHERE id=? AND status=0")
        .bind(payment.id, handlingAmount, timestamp, order.id).run();
      if (Number((rebound.meta as any)?.changes || 0) !== 1) return fail("订单状态已变化", 400, 400);
      return json({ type: provider.method === "AlipayF2F" ? 0 : 1, data: checkoutUrl });
    }
  }
  const claimResults = await env.XBOARD_DB.batch([
    env.XBOARD_DB.prepare(`UPDATE v2_payment_transactions SET status='creating',updated_at=?
      WHERE id=? AND (
        status IN ('pending','failed')
        OR (status='creating' AND updated_at<?)
        OR (status='ready' AND checkout_url IS NULL)
      )`).bind(timestamp, transaction.id, timestamp - PAYMENT_CREATE_STALE_SECONDS),
    env.XBOARD_DB.prepare(`UPDATE v2_order SET payment_id=?,handling_amount=?,updated_at=?
      WHERE id=? AND status=0
        AND EXISTS (SELECT 1 FROM v2_payment_transactions WHERE id=? AND status='creating')`)
      .bind(payment.id, handlingAmount, timestamp, order.id, transaction.id)
  ]);
  const claimed = Number((claimResults[0]?.meta as any)?.changes || 0) === 1;
  const orderBound = Number((claimResults[1]?.meta as any)?.changes || 0) === 1;
  if (!claimed) return fail("支付会话正在创建，请稍后重试", 409, 409);
  if (!orderBound) {
    await env.XBOARD_DB.prepare("UPDATE v2_payment_transactions SET status='canceled',updated_at=? WHERE id=? AND status='creating'")
      .bind(now(), transaction.id).run();
    return fail("订单状态已变化", 400, 400);
  }
  const lockedPayment = await env.XBOARD_DB.prepare("SELECT enable,config,notify_domain,updated_at FROM v2_payment WHERE id=?")
    .bind(payment.id).first<{ enable: number; config: string; notify_domain: string | null; updated_at: number }>();
  const paymentChanged = !lockedPayment || !Number(lockedPayment.enable)
    || Number(lockedPayment.updated_at || 0) !== Number(payment.updated_at || 0)
    || stableConfig(parseConfig(lockedPayment.config)) !== stableConfig(config)
    || String(lockedPayment.notify_domain || "") !== String(payment.notify_domain || "");
  if (paymentChanged) {
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare("DELETE FROM v2_payment_transactions WHERE id=? AND status='creating'").bind(transaction.id),
      env.XBOARD_DB.prepare(`UPDATE v2_order SET payment_id=NULL,handling_amount=0,updated_at=?
        WHERE id=? AND status=0 AND payment_id=?`).bind(now(), order.id, payment.id)
    ]);
    return fail("支付渠道配置已变化，请重新选择支付方式", 409, 409);
  }
  const callbackPath = `/api/v1/guest/payment/notify/${encodeURIComponent(provider.method)}/${encodeURIComponent(callbackUuid)}`;
  const returnUrl = `${appOrigin}/#/order/${encodeURIComponent(String(order.trade_no))}`;
  try {
    const result = await provider.createCheckout({
      config,
      tradeNo: String(order.trade_no),
      amount: expectedAmount,
      currency,
      userId: Number(user.id),
      userEmail: String(user.email || ""),
      appName: String(all.app_name || "XBoard"),
      planName: String(order.plan_name || ""),
      period: String(order.period || ""),
      notifyUrl: `${notifyBase}${callbackPath}`,
      returnUrl,
      idempotencyKey: String(transaction.idempotency_key)
    });
    const checkoutUrl = safeCheckoutUrl(result.data);
    const stored = await env.XBOARD_DB.prepare(`UPDATE v2_payment_transactions SET
      provider_reference=COALESCE(provider_reference,?),checkout_url=?,
      status=CASE WHEN status='creating' THEN 'ready' ELSE status END,
      expires_at=?,updated_at=?
      WHERE id=? AND status IN ('creating','verified','paid')
        AND (provider_reference IS NULL OR provider_reference=?)
        AND EXISTS (SELECT 1 FROM v2_order WHERE id=? AND payment_id=? AND status IN (0,1,3))`)
      .bind(result.providerReference || null, checkoutUrl, result.expiresAt || null, now(), transaction.id,
        result.providerReference || null, order.id, payment.id).run();
    if (Number((stored.meta as any)?.changes || 0) !== 1) {
      await env.XBOARD_DB.prepare("UPDATE v2_payment_transactions SET status='canceled',updated_at=? WHERE id=? AND status='creating'")
        .bind(now(), transaction.id).run();
      return fail("订单状态已变化", 400, 400);
    }
    return json({ type: result.type, data: checkoutUrl });
  } catch (error) {
    await env.XBOARD_DB.prepare("UPDATE v2_payment_transactions SET status='failed',updated_at=? WHERE id=? AND status='creating'")
      .bind(now(), transaction.id).run();
    return fail(error instanceof PaymentError ? error.message : "创建支付失败", error instanceof PaymentError ? error.status : 502, 400);
  }
}

function exactAmount(actual: number | undefined, expected: number) {
  return actual !== undefined && Number.isSafeInteger(actual) && Number.isSafeInteger(expected) && actual === expected;
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
  const paymentRows = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment WHERE payment=? AND uuid=? LIMIT 2")
    .bind(method, paymentUuid).all<PaymentRow>();
  if ((paymentRows.results || []).length !== 1) {
    return new Response((paymentRows.results || []).length ? "ambiguous payment method" : "payment method unavailable", {
      status: (paymentRows.results || []).length ? 409 : 404
    });
  }
  const payment = paymentRows.results![0];
  const providerScope = transactionProvider(method, Number(payment.id));
  const config = parseConfig(payment.config);
  try {
    const callback = await provider.verifyCallback(await boundedCallbackRequest(request), config);
    if (callback.state !== "paid") return new Response(callback.responseText, { status: 200 });
    if (!callback.tradeNo || !callback.callbackNo || !callback.providerReference) throw new PaymentError("支付回调缺少订单标识", 400);
    const order = await env.XBOARD_DB.prepare("SELECT * FROM v2_order WHERE trade_no=?").bind(callback.tradeNo).first<Record<string, any>>();
    if (!order) throw new PaymentError("订单不存在", 404);
    await ensurePaymentSchema(env);
    const timestamp = now();
    const existing = await env.XBOARD_DB.prepare("SELECT * FROM v2_payment_transactions WHERE order_id=? AND payment_id=?")
      .bind(order.id, payment.id).first<Record<string, any>>();
    if (existing && (!transactionProviderMatches(existing.provider, method, Number(payment.id))
      || String(existing.trade_no) !== String(order.trade_no))) {
      throw new PaymentError("支付交易与订单不匹配", 400);
    }
    if (existing?.provider_reference && String(existing.provider_reference) !== callback.providerReference) {
      throw new PaymentError("支付会话标识不匹配", 400);
    }
    const conflicting = await env.XBOARD_DB.prepare(`SELECT order_id,payment_id FROM v2_payment_transactions
      WHERE provider IN (?,?) AND (provider_reference=? OR event_id=?)
        AND NOT (order_id=? AND payment_id=?)
      LIMIT 1`).bind(providerScope, method, callback.providerReference, callback.callbackNo, order.id, payment.id)
      .first<{ order_id: number; payment_id: number }>();
    if (conflicting) throw new PaymentError("支付回调已绑定到其他订单", 409);
    const expectedAmount = existing
      ? Number(existing.expected_amount)
      : Number(order.total_amount || 0) + Number(order.handling_amount || 0);
    if (!exactAmount(callback.amount, expectedAmount)) throw new PaymentError("支付金额不匹配", 400);
    const expectedCurrency = existing
      ? String(existing.currency || "").toUpperCase()
      : String((await settings(env.XBOARD_DB, env.XBOARD_KV)).currency || "CNY").toUpperCase();
    if (!callback.currency || callback.currency.toUpperCase() !== expectedCurrency) throw new PaymentError("支付币种不匹配", 400);
    if (!existing) {
      await env.XBOARD_DB.prepare(`INSERT INTO v2_payment_transactions
        (order_id,trade_no,payment_id,provider,provider_reference,expected_amount,currency,idempotency_key,event_id,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'verified',?,?)`)
        .bind(order.id, order.trade_no, payment.id, providerScope, callback.providerReference, expectedAmount, expectedCurrency, crypto.randomUUID(), callback.callbackNo, timestamp, timestamp).run();
    } else {
      await env.XBOARD_DB.prepare(`UPDATE v2_payment_transactions
        SET provider_reference=COALESCE(provider_reference,?),event_id=COALESCE(event_id,?),status='verified',updated_at=?
        WHERE id=?`).bind(callback.providerReference, callback.callbackNo, timestamp, existing.id).run();
    }
    if (Number(order.payment_id || 0) !== Number(payment.id) || ![0, 1, 3].includes(Number(order.status))) {
      await env.XBOARD_DB.prepare(`UPDATE v2_payment_transactions
        SET status='paid_unapplied',event_id=COALESCE(event_id,?),updated_at=? WHERE order_id=? AND payment_id=?`)
        .bind(callback.callbackNo, now(), order.id, payment.id).run();
      return new Response(callback.responseText, { status: 200 });
    }
    const settled = await settle(order, callback.callbackNo);
    if (!settled) throw new PaymentError("订单开通失败", 500);
    await env.XBOARD_DB.batch([
      env.XBOARD_DB.prepare(`UPDATE v2_payment_transactions
        SET status='paid',event_id=COALESCE(event_id,?),updated_at=? WHERE order_id=? AND payment_id=?`)
        .bind(callback.callbackNo, now(), order.id, payment.id),
      env.XBOARD_DB.prepare(`UPDATE v2_payment_transactions SET status='superseded',updated_at=?
        WHERE order_id=? AND payment_id<>? AND status NOT IN ('paid','paid_unapplied','canceled','superseded')`)
        .bind(now(), order.id, payment.id)
    ]);
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
  safeHttpsOrigin,
  safeAppOrigin,
  safeNotificationOrigin,
  safeCheckoutUrl,
  boundedCallbackRequest,
  uniquePaymentUuid,
  validatePaymentActivation,
  transactionProvider,
  transactionProviderMatches,
  ensurePaymentSchema,
  resetPaymentSchema() { paymentSchemaPromise = null; }
};
