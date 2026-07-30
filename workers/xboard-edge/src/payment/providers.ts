import { md5 } from "../compat.ts";
import { coinbaseJwt, constantTimeEqual, hmacHex, rsa2Sign, rsa2Verify } from "./crypto.ts";
import type {
  CallbackResult,
  CheckoutContext,
  PaymentConfig,
  PaymentFormField,
  PaymentProvider
} from "./types.ts";

const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;
const PROVIDER_TIMEOUT_MS = 12_000;
const STRIPE_API_VERSION = "2026-02-25.clover";

export class PaymentError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function text(config: PaymentConfig, key: string, fallback = "") {
  return String(config[key] ?? fallback).trim();
}

function required(config: PaymentConfig, keys: string[]) {
  for (const key of keys) if (!text(config, key)) throw new PaymentError(`缺少支付配置：${key}`, 422);
}

function field(label: string, description: string, options: Partial<PaymentFormField> = {}): PaymentFormField {
  return { type: "string", label, description, ...options };
}

function cents(value: unknown) {
  const match = String(value ?? "").trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return undefined;
  const fraction = match[2] || "";
  if (fraction.slice(2).replace(/0/g, "")) return undefined;
  const amount = BigInt(match[1]) * 100n + BigInt((fraction + "00").slice(0, 2));
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : undefined;
}

function integerAmount(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return undefined;
  const amount = Number(raw);
  return Number.isSafeInteger(amount) ? amount : undefined;
}

function decimal(amount: number) {
  return (amount / 100).toFixed(2);
}

function canonical(params: Record<string, unknown>, exclude: string[] = []) {
  const ignored = new Set(exclude);
  return Object.entries(params)
    .filter(([key, value]) => !ignored.has(key) && value !== null && value !== undefined && String(value) !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}

function toSearchParams(params: Record<string, unknown>) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) result.set(key, String(value));
  }
  return result;
}

function searchObject(params: URLSearchParams) {
  const result: Record<string, string> = {};
  params.forEach((value, key) => { result[key] = value; });
  return result;
}

function safeJson(raw: string) {
  try { return JSON.parse(raw) as Record<string, any>; } catch { throw new PaymentError("支付服务返回了无效数据", 502); }
}

export function isPrivateNetworkHost(value: string) {
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) {
    return host === "::" || host === "::1" || host.startsWith("::ffff:")
      || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const octets = host.split(".").map(Number);
  if (octets.some(value => value > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function validGatewayUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new PaymentError("支付网关地址无效", 422); }
  if (url.protocol !== "https:" || url.username || url.password) throw new PaymentError("支付网关必须使用 HTTPS", 422);
  if (isPrivateNetworkHost(url.hostname)) {
    throw new PaymentError("支付网关不能指向本地或私有地址", 422);
  }
  return url;
}

function joinUrl(base: string, path: string) {
  const url = validGatewayUrl(base.endsWith("/") ? base : `${base}/`);
  const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.pathname = `${basePath}${path.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url;
}

async function providerFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal, redirect: "error" });
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_PROVIDER_RESPONSE_BYTES) throw new PaymentError("支付服务响应过大", 502);
    let raw = "";
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > MAX_PROVIDER_RESPONSE_BYTES) {
          await reader.cancel();
          throw new PaymentError("支付服务响应过大", 502);
        }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    }
    if (!response.ok) throw new PaymentError(`支付服务请求失败 (${response.status})`, 502);
    return { response, raw };
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    if ((error as Error)?.name === "AbortError") throw new PaymentError("支付服务请求超时", 504);
    throw new PaymentError("支付服务暂时不可用", 502);
  } finally {
    clearTimeout(timeout);
  }
}

function rawJsonObjectMember(raw: string, member: string) {
  const marker = `"${member}"`;
  const memberAt = raw.indexOf(marker);
  if (memberAt < 0) return "";
  const colonAt = raw.indexOf(":", memberAt + marker.length);
  const start = raw.indexOf("{", colonAt + 1);
  if (colonAt < 0 || start < 0) return "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < raw.length; index++) {
    const character = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return raw.slice(start, index + 1);
  }
  return "";
}

function alipayTime() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

const alipay: PaymentProvider = {
  method: "AlipayF2F",
  name: "支付宝当面付",
  icon: "💙",
  form: {
    app_id: field("支付宝 APPID", "支付宝开放平台应用的 APPID", { required: true }),
    private_key: field("应用私钥", "RSA2 应用私钥，支持 PKCS#1、PKCS#8 或裸 Base64", { type: "text", required: true }),
    public_key: field("支付宝公钥", "支付宝公钥，不是应用公钥", { type: "text", required: true }),
    product_name: field("商品名称", "显示在支付宝账单中的商品名称")
  },
  validateConfig(config) {
    required(config, ["app_id", "private_key", "public_key"]);
  },
  async createCheckout(context) {
    this.validateConfig(context.config);
    const bizContent = JSON.stringify({
      subject: text(context.config, "product_name") || `${context.appName} - 订阅`,
      out_trade_no: context.tradeNo,
      total_amount: decimal(context.amount)
    });
    const params: Record<string, string> = {
      app_id: text(context.config, "app_id"),
      method: "alipay.trade.precreate",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: alipayTime(),
      version: "1.0",
      notify_url: context.notifyUrl,
      biz_content: bizContent
    };
    params.sign = await rsa2Sign(canonical(params), text(context.config, "private_key"));
    const { raw } = await providerFetch("https://openapi.alipay.com/gateway.do", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: toSearchParams(params)
    });
    const response = safeJson(raw);
    const signedResponse = rawJsonObjectMember(raw, "alipay_trade_precreate_response");
    if (!response.sign || !signedResponse
      || !await rsa2Verify(signedResponse, String(response.sign), text(context.config, "public_key"))) {
      throw new PaymentError("支付宝响应签名无效", 502);
    }
    const result = response.alipay_trade_precreate_response;
    if (!result || String(result.code) !== "10000" || !result.qr_code) {
      throw new PaymentError(String(result?.sub_msg || result?.msg || "支付宝创建订单失败"), 502);
    }
    return { type: 0, data: String(result.qr_code), providerReference: String(result.out_trade_no || context.tradeNo) };
  },
  async verifyCallback(request, config) {
    this.validateConfig(config);
    const raw = await request.text();
    const params = searchObject(new URLSearchParams(raw));
    const signature = String(params.sign || "");
    if (!signature || !await rsa2Verify(canonical(params, ["sign", "sign_type"]), signature, text(config, "public_key"))) {
      throw new PaymentError("支付宝回调签名无效", 400);
    }
    if (params.app_id !== text(config, "app_id")) throw new PaymentError("支付宝 APPID 不匹配", 400);
    if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(String(params.trade_status))) {
      return { state: "ignored", responseText: "success" };
    }
    return {
      state: "paid",
      tradeNo: String(params.out_trade_no || ""),
      callbackNo: String(params.trade_no || ""),
      providerReference: String(params.out_trade_no || ""),
      amount: cents(params.total_amount),
      currency: "CNY",
      responseText: "success"
    };
  }
};

const btcpay: PaymentProvider = {
  method: "BTCPay",
  name: "BTCPay",
  icon: "₿",
  form: {
    btcpay_url: field("API 地址", "BTCPay Server 的 HTTPS 地址", { required: true, placeholder: "https://pay.example.com/" }),
    btcpay_storeId: field("Store ID", "BTCPay 商店标识符", { required: true }),
    btcpay_api_key: field("API Key", "具有创建和读取 Invoice 权限的个人 API Key", { required: true }),
    btcpay_webhook_key: field("Webhook Secret", "BTCPay webhook 密钥", { required: true })
  },
  validateConfig(config) {
    required(config, ["btcpay_url", "btcpay_storeId", "btcpay_api_key", "btcpay_webhook_key"]);
    validGatewayUrl(text(config, "btcpay_url"));
  },
  async createCheckout(context) {
    this.validateConfig(context.config);
    const url = joinUrl(text(context.config, "btcpay_url"), `api/v1/stores/${encodeURIComponent(text(context.config, "btcpay_storeId"))}/invoices`);
    const { raw } = await providerFetch(url, {
      method: "POST",
      headers: {
        authorization: `token ${text(context.config, "btcpay_api_key")}`,
        "content-type": "application/json",
        "idempotency-key": context.idempotencyKey
      },
      body: JSON.stringify({
        amount: decimal(context.amount),
        currency: context.currency,
        metadata: { orderId: context.tradeNo },
        checkout: { redirectURL: context.returnUrl }
      })
    });
    const result = safeJson(raw);
    if (!result.id || !result.checkoutLink) throw new PaymentError("BTCPay 创建 Invoice 失败", 502);
    return { type: 1, data: String(result.checkoutLink), providerReference: String(result.id) };
  },
  async verifyCallback(request, config) {
    this.validateConfig(config);
    const raw = await request.text();
    const expected = `sha256=${await hmacHex("SHA-256", text(config, "btcpay_webhook_key"), raw)}`;
    if (!constantTimeEqual(request.headers.get("btcpay-sig") || "", expected)) throw new PaymentError("BTCPay 回调签名无效", 400);
    const event = safeJson(raw);
    if (String(event.type || "") !== "InvoiceSettled") return { state: "ignored", responseText: "OK" };
    if (String(event.storeId || "") !== text(config, "btcpay_storeId")) throw new PaymentError("BTCPay Store ID 不匹配", 400);
    const invoiceId = String(event.invoiceId || "");
    if (!invoiceId) throw new PaymentError("BTCPay Invoice ID 缺失", 400);
    const url = joinUrl(text(config, "btcpay_url"), `api/v1/stores/${encodeURIComponent(text(config, "btcpay_storeId"))}/invoices/${encodeURIComponent(invoiceId)}`);
    const { raw: invoiceRaw } = await providerFetch(url, { headers: { authorization: `token ${text(config, "btcpay_api_key")}` } });
    const invoice = safeJson(invoiceRaw);
    if (String(invoice.id || "") !== invoiceId) throw new PaymentError("BTCPay Invoice ID 不匹配", 400);
    if (String(invoice.status) !== "Settled") return { state: "pending", responseText: "OK" };
    if (invoice.storeId && String(invoice.storeId) !== text(config, "btcpay_storeId")) throw new PaymentError("BTCPay Store ID 不匹配", 400);
    return {
      state: "paid",
      tradeNo: String(invoice.metadata?.orderId || ""),
      callbackNo: invoiceId,
      providerReference: invoiceId,
      amount: cents(invoice.amount),
      currency: String(invoice.currency || "").toUpperCase(),
      responseText: "OK"
    };
  }
};

function coinbaseLegacyEndpoint(config: PaymentConfig) {
  const configured = text(config, "coinbase_url", "https://api.commerce.coinbase.com/charges");
  const url = validGatewayUrl(configured);
  if (!/\/charges\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, "")}/charges`;
  return url;
}

const coinbase: PaymentProvider = {
  method: "Coinbase",
  name: "Coinbase Commerce",
  icon: "🪙",
  form: {
    coinbase_url: field("接口地址", "Coinbase Commerce Charges API 地址", { required: true, default: "https://api.commerce.coinbase.com/charges" }),
    coinbase_api_key: field("API Key", "Coinbase Commerce API Key", { required: true }),
    coinbase_webhook_key: field("Webhook Secret", "Coinbase Commerce webhook 密钥", { required: true })
  },
  validateConfig(config) {
    required(config, ["coinbase_api_key", "coinbase_webhook_key"]);
    coinbaseLegacyEndpoint(config);
  },
  async createCheckout(context) {
    this.validateConfig(context.config);
    const { raw } = await providerFetch(coinbaseLegacyEndpoint(context.config), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-api-key": text(context.config, "coinbase_api_key"),
        "x-cc-version": "2018-03-22"
      },
      body: JSON.stringify({
        name: `${context.appName} - 订阅`,
        description: `订单 ${context.tradeNo}`,
        pricing_type: "fixed_price",
        local_price: { amount: decimal(context.amount), currency: context.currency },
        redirect_url: context.returnUrl,
        cancel_url: context.returnUrl,
        metadata: { outTradeNo: context.tradeNo }
      })
    });
    const result = safeJson(raw).data;
    if (!result?.id || !result.hosted_url) throw new PaymentError("Coinbase Commerce 创建 Charge 失败", 502);
    return { type: 1, data: String(result.hosted_url), providerReference: String(result.id) };
  },
  async verifyCallback(request, config) {
    this.validateConfig(config);
    const raw = await request.text();
    const expected = await hmacHex("SHA-256", text(config, "coinbase_webhook_key"), raw);
    if (!constantTimeEqual((request.headers.get("x-cc-webhook-signature") || "").toLowerCase(), expected)) {
      throw new PaymentError("Coinbase Commerce 回调签名无效", 400);
    }
    const event = safeJson(raw).event;
    const eventType = String(event?.type || "");
    if (!["charge:confirmed", "charge:resolved"].includes(eventType)) return { state: "ignored", responseText: "OK" };
    const charge = event?.data || {};
    const reference = String(charge.id || charge.code || "");
    if (!reference) throw new PaymentError("Coinbase Charge ID 缺失", 400);
    const endpoint = coinbaseLegacyEndpoint(config);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(reference)}`;
    const { raw: chargeRaw } = await providerFetch(endpoint, {
      headers: { "x-cc-api-key": text(config, "coinbase_api_key"), "x-cc-version": "2018-03-22" }
    });
    const verified = safeJson(chargeRaw).data;
    if (String(verified?.id || "") !== reference) throw new PaymentError("Coinbase Charge ID 不匹配", 400);
    const statuses = Array.isArray(verified?.timeline) ? verified.timeline.map((item: any) => String(item.status)) : [];
    if (!statuses.some((status: string) => ["COMPLETED", "RESOLVED"].includes(status))) return { state: "pending", responseText: "OK" };
    return {
      state: "paid",
      tradeNo: String(verified?.metadata?.outTradeNo || charge.metadata?.outTradeNo || ""),
      callbackNo: String(event.id || reference),
      providerReference: String(verified?.id || reference),
      amount: cents(verified?.pricing?.local?.amount),
      currency: String(verified?.pricing?.local?.currency || "").toUpperCase(),
      responseText: "OK"
    };
  }
};

function coinbaseBusinessBase(config: PaymentConfig) {
  const sandbox = text(config, "coinbase_business_environment", "production") === "sandbox";
  return new URL(sandbox
    ? "https://business.coinbase.com/sandbox/api/v1/checkouts"
    : "https://business.coinbase.com/api/v1/checkouts");
}

async function coinbaseBusinessRequest(config: PaymentConfig, method: string, url: URL, init: RequestInit = {}) {
  const jwt = await coinbaseJwt(
    text(config, "coinbase_business_key_name"),
    text(config, "coinbase_business_private_key"),
    method,
    url
  );
  return providerFetch(url, {
    ...init,
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {})
    }
  });
}

async function verifyCoinbaseHook(request: Request, raw: string, secret: string) {
  const signature = request.headers.get("x-hook0-signature") || "";
  const fields = Object.fromEntries(signature.split(",").map(part => {
    const separator = part.indexOf("=");
    return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
  }));
  const timestamp = Number(fields.t);
  const headerNames = String(fields.h || "");
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300 || !fields.v1) return false;
  const headerValues = headerNames.split(" ").filter(Boolean).map(name => request.headers.get(name) || "").join(".");
  const expected = await hmacHex("SHA-256", secret, `${fields.t}.${headerNames}.${headerValues}.${raw}`);
  return constantTimeEqual(expected, String(fields.v1).toLowerCase());
}

const coinbaseBusiness: PaymentProvider = {
  method: "CoinbaseBusiness",
  name: "Coinbase Business",
  icon: "◉",
  form: {
    coinbase_business_key_name: field("CDP API Key Name", "完整 Key Name，例如 organizations/.../apiKeys/...", { required: true }),
    coinbase_business_private_key: field("CDP ECDSA Private Key", "保留 BEGIN EC PRIVATE KEY 及换行", { type: "text", required: true }),
    coinbase_business_webhook_secret: field("Webhook Secret", "创建 Checkout webhook subscription 时返回的 secret", { required: true }),
    coinbase_business_environment: field("环境", "沙盒与生产配置完全隔离", {
      type: "select", default: "production",
      options: [{ label: "生产", value: "production" }, { label: "沙盒", value: "sandbox" }]
    })
  },
  validateConfig(config) {
    required(config, ["coinbase_business_key_name", "coinbase_business_private_key", "coinbase_business_webhook_secret"]);
    if (!["production", "sandbox"].includes(text(config, "coinbase_business_environment", "production"))) {
      throw new PaymentError("Coinbase Business 环境无效", 422);
    }
  },
  async createCheckout(context) {
    this.validateConfig(context.config);
    const url = coinbaseBusinessBase(context.config);
    const { raw } = await coinbaseBusinessRequest(context.config, "POST", url, {
      headers: { "x-idempotency-key": context.idempotencyKey },
      body: JSON.stringify({
        amount: decimal(context.amount),
        currency: context.currency,
        description: `${context.appName} - 订单 ${context.tradeNo}`,
        metadata: { orderId: context.tradeNo, userId: String(context.userId) },
        successRedirectUrl: context.returnUrl,
        failRedirectUrl: context.returnUrl
      })
    });
    const result = safeJson(raw);
    if (!/^[0-9a-f]{24}$/.test(String(result.id || "")) || !result.url) throw new PaymentError("Coinbase Business 创建 Checkout 失败", 502);
    return {
      type: 1,
      data: String(result.url),
      providerReference: String(result.id),
      expiresAt: result.expiresAt ? Math.floor(Date.parse(String(result.expiresAt)) / 1000) : undefined
    };
  },
  async verifyCallback(request, config) {
    this.validateConfig(config);
    const raw = await request.text();
    if (!await verifyCoinbaseHook(request, raw, text(config, "coinbase_business_webhook_secret"))) {
      throw new PaymentError("Coinbase Business 回调签名无效", 400);
    }
    const event = safeJson(raw);
    if (String(event.eventType || "") !== "checkout.payment.success") return { state: "ignored", responseText: "OK" };
    const reference = String(event.id || "");
    if (!reference) throw new PaymentError("Coinbase Checkout ID 缺失", 400);
    const url = coinbaseBusinessBase(config);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(reference)}`;
    const { raw: checkoutRaw } = await coinbaseBusinessRequest(config, "GET", url);
    const checkout = safeJson(checkoutRaw);
    if (String(checkout.id || "") !== reference) throw new PaymentError("Coinbase Checkout ID 不匹配", 400);
    if (String(checkout.status) !== "COMPLETED") return { state: "pending", responseText: "OK" };
    const expectedMode = text(config, "coinbase_business_environment", "production") === "sandbox" ? "test" : "prod";
    if (checkout.mode && ![expectedMode, text(config, "coinbase_business_environment")].includes(String(checkout.mode))) {
      throw new PaymentError("Coinbase Business 环境不匹配", 400);
    }
    return {
      state: "paid",
      tradeNo: String(checkout.metadata?.orderId || event.metadata?.orderId || ""),
      callbackNo: reference,
      providerReference: reference,
      amount: cents(checkout.amount),
      currency: String(checkout.currency || "").toUpperCase(),
      responseText: "OK"
    };
  }
};

const coinPayments: PaymentProvider = {
  method: "CoinPayments",
  name: "CoinPayments",
  icon: "💰",
  form: {
    coinpayments_merchant_id: field("Merchant ID", "Account Settings 中的 Merchant ID", { required: true }),
    coinpayments_ipn_secret: field("IPN Secret", "Merchant Settings 中配置的 IPN Secret", { required: true }),
    coinpayments_currency: field("货币代码", "三位大写结算货币代码", { required: true, default: "CNY" })
  },
  validateConfig(config) {
    required(config, ["coinpayments_merchant_id", "coinpayments_ipn_secret", "coinpayments_currency"]);
    if (!/^[A-Z0-9]{2,10}$/.test(text(config, "coinpayments_currency").toUpperCase())) throw new PaymentError("CoinPayments 货币代码无效", 422);
  },
  async createCheckout(context) {
    this.validateConfig(context.config);
    const returnOrigin = new URL(context.returnUrl).origin;
    const params = toSearchParams({
      cmd: "_pay_simple",
      reset: 1,
      merchant: text(context.config, "coinpayments_merchant_id"),
      item_name: context.tradeNo,
      item_number: context.tradeNo,
      want_shipping: 0,
      currency: text(context.config, "coinpayments_currency").toUpperCase(),
      amountf: decimal(context.amount),
      success_url: returnOrigin,
      cancel_url: context.returnUrl,
      ipn_url: context.notifyUrl
    });
    return { type: 1, data: `https://www.coinpayments.net/index.php?${params}` };
  },
  async verifyCallback(request, config) {
    this.validateConfig(config);
    const raw = await request.text();
    const expected = await hmacHex("SHA-512", text(config, "coinpayments_ipn_secret"), raw);
    if (!constantTimeEqual((request.headers.get("hmac") || "").toLowerCase(), expected)) throw new PaymentError("CoinPayments IPN 签名无效", 400);
    const params = searchObject(new URLSearchParams(raw));
    if (String(params.ipn_mode || "").toLowerCase() !== "hmac") throw new PaymentError("CoinPayments IPN mode 无效", 400);
    if (String(params.merchant || "") !== text(config, "coinpayments_merchant_id")) throw new PaymentError("CoinPayments Merchant ID 不匹配", 400);
    const status = Number(params.status);
    if (status < 0) throw new PaymentError("CoinPayments 支付失败", 400);
    if (!(status >= 100 || status === 2)) return { state: "pending", responseText: "IPN OK: pending" };
    return {
      state: "paid",
      tradeNo: String(params.item_number || ""),
      callbackNo: String(params.txn_id || ""),
      providerReference: String(params.txn_id || ""),
      amount: cents(params.amount1),
      currency: String(params.currency1 || "").toUpperCase(),
      responseText: "IPN OK"
    };
  }
};

const epay: PaymentProvider = {
  method: "EPay",
  name: "易支付",
  icon: "💳",
  form: {
    url: field("支付网关地址", "易支付 V1 网关 HTTPS 地址", { required: true }),
    pid: field("商户 ID", "易支付商户 ID", { required: true }),
    key: field("通信密钥", "易支付通信密钥", { required: true }),
    type: field("支付类型", "例如 alipay、wxpay、qqpay；留空由网关选择")
  },
  validateConfig(config) {
    required(config, ["url", "pid", "key"]);
    validGatewayUrl(text(config, "url"));
  },
  async createCheckout(context) {
    this.validateConfig(context.config);
    const params: Record<string, unknown> = {
      money: decimal(context.amount),
      name: context.tradeNo,
      notify_url: context.notifyUrl,
      return_url: context.returnUrl,
      out_trade_no: context.tradeNo,
      pid: text(context.config, "pid")
    };
    if (text(context.config, "type")) params.type = text(context.config, "type");
    const sign = md5(`${canonical(params)}${text(context.config, "key")}`);
    const url = joinUrl(text(context.config, "url"), "submit.php");
    url.search = toSearchParams({ ...params, sign, sign_type: "MD5" }).toString();
    return { type: 1, data: url.toString() };
  },
  async verifyCallback(request, config) {
    this.validateConfig(config);
    const params = request.method === "GET"
      ? searchObject(new URL(request.url).searchParams)
      : searchObject(new URLSearchParams(await request.text()));
    const expected = md5(`${canonical(params, ["sign", "sign_type"])}${text(config, "key")}`);
    if (!constantTimeEqual(String(params.sign || "").toLowerCase(), expected)) throw new PaymentError("易支付回调签名无效", 400);
    if (String(params.pid || "") !== text(config, "pid")) throw new PaymentError("易支付商户 ID 不匹配", 400);
    if (String(params.trade_status || "") !== "TRADE_SUCCESS") return { state: "ignored", responseText: "success" };
    if (text(config, "type") && String(params.type || "") !== text(config, "type")) throw new PaymentError("易支付类型不匹配", 400);
    return {
      state: "paid",
      tradeNo: String(params.out_trade_no || ""),
      callbackNo: String(params.trade_no || ""),
      providerReference: String(params.trade_no || ""),
      amount: cents(params.money),
      currency: String(params.currency || "CNY").toUpperCase(),
      responseText: "success"
    };
  }
};

const mgate: PaymentProvider = {
  method: "MGate",
  name: "MGate",
  icon: "🏛️",
  form: {
    mgate_url: field("API 地址", "MGate 支付网关 HTTPS 地址", { required: true }),
    mgate_app_id: field("App ID", "MGate 应用标识符", { required: true }),
    mgate_app_secret: field("App Secret", "MGate 应用密钥", { required: true }),
    mgate_source_currency: field("源货币", "默认使用站点货币")
  },
  validateConfig(config) {
    required(config, ["mgate_url", "mgate_app_id", "mgate_app_secret"]);
    validGatewayUrl(text(config, "mgate_url"));
  },
  async createCheckout(context) {
    this.validateConfig(context.config);
    const params: Record<string, unknown> = {
      out_trade_no: context.tradeNo,
      total_amount: context.amount,
      notify_url: context.notifyUrl,
      return_url: context.returnUrl,
      source_currency: (text(context.config, "mgate_source_currency") || context.currency).toUpperCase(),
      app_id: text(context.config, "mgate_app_id")
    };
    params.sign = md5(`${toSearchParams(Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))).toString()}${text(context.config, "mgate_app_secret")}`);
    const { raw } = await providerFetch(joinUrl(text(context.config, "mgate_url"), "v1/gateway/fetch"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "MGate" },
      body: toSearchParams(params)
    });
    const result = safeJson(raw);
    if (!result.data?.trade_no || !result.data?.pay_url) throw new PaymentError(String(result.message || "MGate 创建支付失败"), 502);
    return { type: 1, data: String(result.data.pay_url), providerReference: String(result.data.trade_no) };
  },
  async verifyCallback(request, config) {
    this.validateConfig(config);
    const params = request.method === "GET"
      ? searchObject(new URL(request.url).searchParams)
      : searchObject(new URLSearchParams(await request.text()));
    const sorted = Object.fromEntries(Object.entries(params).filter(([key]) => key !== "sign").sort(([a], [b]) => a.localeCompare(b)));
    const expected = md5(`${toSearchParams(sorted).toString()}${text(config, "mgate_app_secret")}`);
    if (!constantTimeEqual(String(params.sign || "").toLowerCase(), expected)) throw new PaymentError("MGate 回调签名无效", 400);
    if (String(params.app_id || "") !== text(config, "mgate_app_id")) throw new PaymentError("MGate App ID 不匹配", 400);
    if (!["paid", "success", "TRADE_SUCCESS", "2"].includes(String(params.status || ""))) {
      return { state: "ignored", responseText: "success" };
    }
    if (!String(params.source_currency || "").trim()) throw new PaymentError("MGate 回调缺少货币", 400);
    return {
      state: "paid",
      tradeNo: String(params.out_trade_no || ""),
      callbackNo: String(params.trade_no || ""),
      providerReference: String(params.trade_no || ""),
      amount: integerAmount(params.total_amount),
      currency: String(params.source_currency).toUpperCase(),
      responseText: "success"
    };
  }
};

function stripePaymentMethods(config: PaymentConfig) {
  return text(config, "stripe_payment_methods").split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
}

const stripeZeroDecimalCurrencies = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"
]);
const stripeThreeDecimalCurrencies = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

function stripeMinorAmount(amount: number, currency: string) {
  const code = currency.toUpperCase();
  if (stripeZeroDecimalCurrencies.has(code)) {
    if (amount % 100 !== 0) throw new PaymentError(`Stripe ${code} 金额不能包含小数`, 400);
    return amount / 100;
  }
  if (stripeThreeDecimalCurrencies.has(code)) return amount * 10;
  return amount;
}

function stripeXboardAmount(amount: number, currency: string) {
  const code = currency.toUpperCase();
  if (stripeZeroDecimalCurrencies.has(code)) return amount * 100;
  if (stripeThreeDecimalCurrencies.has(code)) return amount / 10;
  return amount;
}

async function stripeRequest(config: PaymentConfig, path: string, init: RequestInit = {}) {
  const url = new URL(path, "https://api.stripe.com");
  return providerFetch(url, {
    ...init,
    headers: {
      authorization: `Basic ${btoa(`${text(config, "stripe_secret_key")}:`)}`,
      "stripe-version": STRIPE_API_VERSION,
      ...(init.headers || {})
    }
  });
}

async function verifyStripeSignature(raw: string, header: string, secret: string) {
  const entries = header.split(",").map(part => part.trim().split("=", 2));
  const timestamp = Number(entries.find(([key]) => key === "t")?.[1]);
  const signatures = entries.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300 || !signatures.length) return false;
  const expected = await hmacHex("SHA-256", secret, `${timestamp}.${raw}`);
  return signatures.some(signature => constantTimeEqual(signature.toLowerCase(), expected));
}

const stripe: PaymentProvider = {
  method: "Stripe",
  name: "Stripe",
  icon: "S",
  form: {
    stripe_secret_key: field("Secret Key", "Stripe Secret Key（sk_test_ 或 sk_live_）", { required: true }),
    stripe_webhook_secret: field("Webhook Secret", "当前渠道对应 endpoint 的 whsec_ 密钥", { required: true }),
    stripe_payment_methods: field("支付方式", "逗号分隔；留空时由 Stripe Dashboard 自动管理"),
    stripe_statement_descriptor: field("账单描述", "可选，5-22 个受 Stripe 支持的字符")
  },
  validateConfig(config) {
    required(config, ["stripe_secret_key", "stripe_webhook_secret"]);
    if (!/^sk_(test|live)_/.test(text(config, "stripe_secret_key"))) throw new PaymentError("Stripe Secret Key 格式无效", 422);
    if (!/^whsec_/.test(text(config, "stripe_webhook_secret"))) throw new PaymentError("Stripe Webhook Secret 格式无效", 422);
    const descriptor = text(config, "stripe_statement_descriptor");
    if (descriptor && (descriptor.length < 5 || descriptor.length > 22
      || !/[A-Za-z]/.test(descriptor) || !/^[\x20-\x7e]+$/.test(descriptor) || /[<>'"*\\]/.test(descriptor))) {
      throw new PaymentError("Stripe 账单描述格式无效", 422);
    }
  },
  async createCheckout(context) {
    this.validateConfig(context.config);
    const params = new URLSearchParams({
      mode: "payment",
      client_reference_id: context.tradeNo,
      customer_email: context.userEmail,
      success_url: context.returnUrl,
      cancel_url: context.returnUrl,
      "metadata[order_id]": context.tradeNo,
      "metadata[user_id]": String(context.userId),
      "payment_intent_data[metadata][order_id]": context.tradeNo,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": context.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(stripeMinorAmount(context.amount, context.currency)),
      "line_items[0][price_data][product_data][name]": `${context.appName} - 订阅`
    });
    const descriptor = text(context.config, "stripe_statement_descriptor");
    if (descriptor) params.set("payment_intent_data[statement_descriptor_suffix]", descriptor);
    stripePaymentMethods(context.config).forEach((method, index) => params.set(`payment_method_types[${index}]`, method));
    const { raw } = await stripeRequest(context.config, "/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": context.idempotencyKey
      },
      body: params
    });
    const result = safeJson(raw);
    if (!result.id || !result.url) throw new PaymentError("Stripe 创建 Checkout Session 失败", 502);
    return {
      type: 1,
      data: String(result.url),
      providerReference: String(result.id),
      expiresAt: Number(result.expires_at || 0) || undefined
    };
  },
  async verifyCallback(request, config) {
    this.validateConfig(config);
    const raw = await request.text();
    if (!await verifyStripeSignature(raw, request.headers.get("stripe-signature") || "", text(config, "stripe_webhook_secret"))) {
      throw new PaymentError("Stripe webhook 签名无效", 400);
    }
    const event = safeJson(raw);
    if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(String(event.type || ""))) {
      return { state: "ignored", responseText: "OK" };
    }
    const eventSession = event.data?.object || {};
    const reference = String(eventSession.id || "");
    if (!reference) throw new PaymentError("Stripe Checkout Session ID 缺失", 400);
    const { raw: sessionRaw } = await stripeRequest(config, `/v1/checkout/sessions/${encodeURIComponent(reference)}`);
    const session = safeJson(sessionRaw);
    if (String(session.id || "") !== reference) throw new PaymentError("Stripe Checkout Session ID 不匹配", 400);
    if (String(session.payment_status) !== "paid") return { state: "pending", responseText: "OK" };
    if (!session.payment_intent) throw new PaymentError("Stripe PaymentIntent 缺失", 400);
    const expectsLive = text(config, "stripe_secret_key").startsWith("sk_live_");
    if (Boolean(session.livemode) !== expectsLive) throw new PaymentError("Stripe 测试与生产环境不匹配", 400);
    const tradeNo = String(session.client_reference_id || session.metadata?.order_id || "");
    if (session.metadata?.order_id && String(session.metadata.order_id) !== tradeNo) throw new PaymentError("Stripe 订单元数据不匹配", 400);
    return {
      state: "paid",
      tradeNo,
      callbackNo: String(event.id || reference),
      providerReference: reference,
      amount: stripeXboardAmount(Number(session.amount_total), String(session.currency || "")),
      currency: String(session.currency || "").toUpperCase(),
      responseText: "OK"
    };
  }
};

export const paymentProviders: ReadonlyMap<string, PaymentProvider> = new Map([
  alipay, btcpay, coinbase, coinbaseBusiness, coinPayments, epay, mgate, stripe
].map(provider => [provider.method, provider]));

export const paymentMethodNames = [...paymentProviders.keys()];

export const __test = {
  canonical,
  rawJsonObjectMember,
  verifyCoinbaseHook,
  verifyStripeSignature,
  stripeMinorAmount,
  stripeXboardAmount,
  validGatewayUrl,
  STRIPE_API_VERSION
};
