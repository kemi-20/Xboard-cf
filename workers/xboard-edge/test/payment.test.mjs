import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import initSqlJs from "sql.js";
import { redactAuditValue } from "../src/audit.ts";
import { invalidateSettingsCache } from "../src/db.ts";
import { md5 } from "../src/compat.ts";
import { coinbaseJwt, hmacHex, rsa2Sign, rsa2Verify } from "../src/payment/crypto.ts";
import { paymentMethodNames, paymentProviders, __test as providerTest } from "../src/payment/providers.ts";
import {
  checkoutPayment,
  handleAdminPayment,
  handlePaymentCallback,
  __test as paymentTest
} from "../src/payment/index.ts";
import { settleOrder } from "../src/payment/settlement.ts";

const context = {
  config: {},
  tradeNo: "ORDER-20260729",
  amount: 12345,
  currency: "CNY",
  userId: 7,
  userEmail: "user@example.com",
  appName: "XBoard",
  planName: "Smart",
  period: "yearly",
  notifyUrl: "https://panel.example.com/api/v1/guest/payment/notify/Test/uuid",
  returnUrl: "https://panel.example.com/#/order/ORDER-20260729",
  idempotencyKey: "9f12cf5a-9e7e-4b20-8e65-c5daac5bc0f9"
};

function base64UrlBytes(value) {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return Promise.resolve(run()).finally(() => { globalThis.fetch = original; });
}

test("the fixed registry exposes only the eight native payment providers", () => {
  assert.deepEqual(paymentMethodNames, [
    "AlipayF2F", "BTCPay", "Coinbase", "CoinbaseBusiness",
    "CoinPayments", "EPay", "MGate", "Stripe"
  ]);
  assert.equal(paymentProviders.has("Creem"), false);
});

test("disabling a payment method blocks new checkout without discarding an in-flight callback", () => {
  const source = readFileSync(new URL("../src/payment/index.ts", import.meta.url), "utf8");
  const edgeSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /SELECT \* FROM v2_payment WHERE payment=\? AND uuid=\? LIMIT 2/);
  assert.doesNotMatch(source, /SELECT \* FROM v2_payment WHERE payment=\? AND uuid=\? AND enable=1/);
  assert.match(source, /Number\(order\.payment_id \|\| 0\) !== Number\(payment\.id\)/);
  assert.match(edgeSource, /return new Response\("invalid payment callback path", \{ status: 400 \}\)/);
});

test("payment credentials are recursively removed from audit data", () => {
  const source = {
    name: "Stripe",
    config: {
      stripe_secret_key: "sk_live_private",
      stripe_webhook_secret: "whsec_private",
      nested: [{ api_key: "api-private", public_key: "public", key: "epay-private" }]
    },
    access_token: "token-private",
    handling_fee_fixed: 100
  };
  const redacted = redactAuditValue(source);
  assert.equal(redacted.config.stripe_secret_key, "[REDACTED]");
  assert.equal(redacted.config.stripe_webhook_secret, "[REDACTED]");
  assert.equal(redacted.config.nested[0].api_key, "[REDACTED]");
  assert.equal(redacted.config.nested[0].key, "[REDACTED]");
  assert.equal(redacted.config.nested[0].public_key, "public");
  assert.equal(redacted.access_token, "[REDACTED]");
  assert.equal(redacted.handling_fee_fixed, 100);
  assert.doesNotMatch(JSON.stringify(redacted), /private/);
});

test("RSA2 and Coinbase ES256 helpers use standard signatures", async () => {
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" }
  });
  const payload = "app_id=123&out_trade_no=ORDER";
  const signature = await rsa2Sign(payload, rsa.privateKey);
  assert.equal(await rsa2Verify(payload, signature, rsa.publicKey), true);
  assert.equal(await rsa2Verify(`${payload}-tampered`, signature, rsa.publicKey), false);

  const ec = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "sec1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const url = new URL("https://business.coinbase.com/api/v1/checkouts");
  const jwt = await coinbaseJwt("organizations/test/apiKeys/key", ec.privateKey, "POST", url, 1_700_000_000);
  const [header, body, jwtSignature] = jwt.split(".");
  assert.equal(verify("sha256", Buffer.from(`${header}.${body}`), {
    key: ec.publicKey,
    dsaEncoding: "ieee-p1363"
  }, base64UrlBytes(jwtSignature)), true);
  assert.deepEqual(JSON.parse(base64UrlBytes(body).toString()), {
    iss: "cdp",
    nbf: 1_700_000_000,
    exp: 1_700_000_120,
    sub: "organizations/test/apiKeys/key",
    uri: "POST business.coinbase.com/api/v1/checkouts"
  });
});

test("Alipay signs requests, verifies responses, and binds callbacks to out_trade_no", async () => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const provider = paymentProviders.get("AlipayF2F");
  const config = { app_id: "2026000000000000", private_key: keys.privateKey, public_key: keys.publicKey };
  const result = await withFetch(async (_input, init) => {
    const params = Object.fromEntries(new URLSearchParams(String(init.body)));
    const requestSignature = params.sign;
    delete params.sign;
    assert.equal(verify("RSA-SHA256", Buffer.from(providerTest.canonical(params)), keys.publicKey, Buffer.from(requestSignature, "base64")), true);
    assert.equal(JSON.parse(params.biz_content).timeout_express, "30m");
    const responseBody = JSON.stringify({ code: "10000", msg: "Success", out_trade_no: context.tradeNo, qr_code: "https://qr.example/pay" });
    const responseSignature = sign("RSA-SHA256", Buffer.from(responseBody), keys.privateKey).toString("base64");
    return new Response(`{"alipay_trade_precreate_response":${responseBody},"sign":"${responseSignature}"}`);
  }, () => provider.createCheckout({ ...context, config }));
  assert.equal(result.type, 0);
  assert.equal(result.data, "https://qr.example/pay");
  assert.equal(result.providerReference, context.tradeNo);
  assert.ok(result.expiresAt > Math.floor(Date.now() / 1000) + 29 * 60);

  const callback = {
    app_id: config.app_id,
    out_trade_no: context.tradeNo,
    trade_no: "2026072900001",
    trade_status: "TRADE_SUCCESS",
    total_amount: "123.45",
    sign_type: "RSA2"
  };
  callback.sign = await rsa2Sign(providerTest.canonical(callback, ["sign", "sign_type"]), keys.privateKey);
  const verified = await provider.verifyCallback(new Request("https://panel.example.com/notify", {
    method: "POST",
    body: new URLSearchParams(callback)
  }), config);
  assert.equal(verified.tradeNo, context.tradeNo);
  assert.equal(verified.callbackNo, callback.trade_no);
  assert.equal(verified.providerReference, context.tradeNo);
  assert.equal(verified.amount, 12345);
});

test("BTCPay uses idempotency, validates HMAC, and re-reads the settled invoice", async () => {
  const provider = paymentProviders.get("BTCPay");
  const config = {
    btcpay_url: "https://btcpay.example.com/",
    btcpay_storeId: "store-1",
    btcpay_api_key: "api-key",
    btcpay_webhook_key: "webhook-secret"
  };
  let createSeen = false;
  const result = await withFetch(async (input, init = {}) => {
    const url = new URL(input);
    if (init.method === "POST") {
      createSeen = true;
      assert.equal(new Headers(init.headers).get("idempotency-key"), context.idempotencyKey);
      assert.equal(JSON.parse(String(init.body)).metadata.orderId, context.tradeNo);
      return Response.json({ id: "invoice-1", checkoutLink: "https://btcpay.example.com/i/invoice-1", expirationTime: 2000000000 });
    }
    assert.equal(url.pathname.endsWith("/invoices/invoice-1"), true);
    return Response.json({
      id: "invoice-1", storeId: "store-1", status: "Settled",
      amount: "123.45", currency: "CNY", metadata: { orderId: context.tradeNo }
    });
  }, async () => {
    const created = await provider.createCheckout({ ...context, config });
    const raw = JSON.stringify({ type: "InvoiceSettled", storeId: "store-1", invoiceId: "invoice-1" });
    const signature = `sha256=${await hmacHex("SHA-256", config.btcpay_webhook_key, raw)}`;
    const verified = await provider.verifyCallback(new Request("https://panel.example.com/notify", {
      method: "POST", headers: { "btcpay-sig": signature }, body: raw
    }), config);
    return { created, verified };
  });
  assert.equal(createSeen, true);
  assert.equal(result.created.providerReference, "invoice-1");
  assert.equal(result.created.expiresAt, 2000000000);
  assert.equal(result.verified.tradeNo, context.tradeNo);
  assert.equal(result.verified.amount, 12345);
});

test("legacy Coinbase Commerce remains compatible and verifies the fetched Charge", async () => {
  const provider = paymentProviders.get("Coinbase");
  const config = {
    coinbase_url: "https://api.commerce.coinbase.com/charges",
    coinbase_api_key: "commerce-key",
    coinbase_webhook_key: "commerce-hook"
  };
  const chargeId = "charge-local";
  const result = await withFetch(async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-cc-api-key"), config.coinbase_api_key);
    assert.equal(headers.get("x-cc-version"), "2018-03-22");
    if (init.method === "POST") {
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.local_price.amount, "123.45");
      assert.equal(payload.metadata.outTradeNo, context.tradeNo);
      return Response.json({ data: { id: chargeId, hosted_url: "https://commerce.coinbase.com/charges/local", expires_at: "2033-05-18T03:33:20Z" } });
    }
    assert.equal(url.pathname.endsWith(`/charges/${chargeId}`), true);
    return Response.json({ data: {
      id: chargeId,
      timeline: [{ status: "COMPLETED" }],
      metadata: { outTradeNo: context.tradeNo },
      pricing: { local: { amount: "123.45", currency: "CNY" } }
    } });
  }, async () => {
    const created = await provider.createCheckout({ ...context, config });
    const raw = JSON.stringify({
      event: {
        id: "event-local", type: "charge:confirmed",
        data: { id: chargeId, metadata: { outTradeNo: context.tradeNo } }
      }
    });
    const signature = await hmacHex("SHA-256", config.coinbase_webhook_key, raw);
    const verified = await provider.verifyCallback(new Request("https://panel.example.com/notify", {
      method: "POST", headers: { "x-cc-webhook-signature": signature }, body: raw
    }), config);
    return { created, verified };
  });
  assert.equal(result.created.providerReference, chargeId);
  assert.equal(result.created.expiresAt, 2000000000);
  assert.equal(result.verified.callbackNo, "event-local");
  assert.equal(result.verified.providerReference, chargeId);
  assert.equal(result.verified.amount, 12345);
});

test("Coinbase Business uses a signed JWT, sandbox path, Hook0, and a verified checkout", async () => {
  const keys = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "sec1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const provider = paymentProviders.get("CoinbaseBusiness");
  const config = {
    coinbase_business_key_name: "organizations/test/apiKeys/key",
    coinbase_business_private_key: keys.privateKey,
    coinbase_business_webhook_secret: "hook-secret",
    coinbase_business_environment: "sandbox"
  };
  const checkoutId = "68f7a946db0529ea9b6d3a12";
  const result = await withFetch(async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.pathname.startsWith("/sandbox/api/v1/checkouts"), true);
    const bearer = new Headers(init.headers).get("authorization").replace("Bearer ", "");
    const [header, payload, signature] = bearer.split(".");
    assert.equal(verify("sha256", Buffer.from(`${header}.${payload}`), {
      key: keys.publicKey,
      dsaEncoding: "ieee-p1363"
    }, base64UrlBytes(signature)), true);
    if (init.method === "POST") {
      assert.equal(new Headers(init.headers).get("x-idempotency-key"), context.idempotencyKey);
      return Response.json({ id: checkoutId, url: "https://payments.coinbase.com/payment-links/test" });
    }
    return Response.json({
      id: checkoutId, status: "COMPLETED", amount: "123.45", currency: "USDC",
      settlement: { fiatAmount: "123.45", fiatCurrency: "CNY" },
      metadata: { orderId: context.tradeNo }
    });
  }, async () => {
    const created = await provider.createCheckout({ ...context, config });
    const raw = JSON.stringify({ id: checkoutId, eventType: "checkout.payment.success", metadata: { orderId: context.tradeNo } });
    const timestamp = Math.floor(Date.now() / 1000);
    const headerNames = "content-type x-hook0-id";
    const headerValues = "application/json.delivery-1";
    const signature = createHmac("sha256", config.coinbase_business_webhook_secret)
      .update(`${timestamp}.${headerNames}.${headerValues}.${raw}`).digest("hex");
    const verified = await provider.verifyCallback(new Request("https://panel.example.com/notify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hook0-id": "delivery-1",
        "x-hook0-signature": `t=${timestamp},h=${headerNames},v1=${signature}`
      },
      body: raw
    }), config);
    return { created, verified };
  });
  assert.equal(result.created.providerReference, checkoutId);
  assert.equal(result.verified.providerReference, checkoutId);
  assert.equal(result.verified.tradeNo, context.tradeNo);
  assert.equal(result.verified.amount, 12345);
  assert.equal(result.verified.currency, "CNY");
});

test("Coinbase Business accepts the documented top-level fiat amount pair", async () => {
  const keys = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "sec1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const provider = paymentProviders.get("CoinbaseBusiness");
  const checkoutId = "68f7a946db0529ea9b6d3a12";
  const config = {
    coinbase_business_key_name: `organizations/test/apiKeys/${crypto.randomUUID()}`,
    coinbase_business_private_key: keys.privateKey,
    coinbase_business_webhook_secret: "hook-secret",
    coinbase_business_environment: "sandbox"
  };
  const raw = JSON.stringify({
    id: checkoutId,
    eventType: "checkout.payment.success",
    metadata: { orderId: context.tradeNo }
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacHex("SHA-256", config.coinbase_business_webhook_secret, `${timestamp}...${raw}`);
  await withFetch(async () => Response.json({
    id: checkoutId,
    status: "COMPLETED",
    amount: "100.00",
    currency: "USDC",
    fiatAmount: "123.45",
    fiatCurrency: "CNY",
    metadata: { orderId: context.tradeNo }
  }), async () => {
    const verified = await provider.verifyCallback(new Request("https://panel.example.com/notify", {
      method: "POST",
      headers: { "x-hook0-signature": `t=${timestamp},h=,v1=${signature}` },
      body: raw
    }), config);
    assert.equal(verified.amount, 12345);
    assert.equal(verified.currency, "CNY");
  });
});

test("Stripe creates hosted Checkout and only accepts a paid, re-read Session", async () => {
  const provider = paymentProviders.get("Stripe");
  const config = {
    stripe_secret_key: "sk_test_local",
    stripe_webhook_secret: "whsec_local",
    stripe_payment_methods: "",
    stripe_statement_descriptor: "XBOARD SERVICE"
  };
  const sessionId = "cs_test_local";
  const result = await withFetch(async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).get("stripe-version"), providerTest.STRIPE_API_VERSION);
    if (init.method === "POST") {
      const params = new URLSearchParams(String(init.body));
      assert.equal(params.get("mode"), "payment");
      assert.equal(params.get("line_items[0][price_data][unit_amount]"), "12345");
      assert.equal(params.get("line_items[0][price_data][product_data][name]"), "XBoard - 订阅 - Smart（1年）");
      assert.equal(params.get("payment_intent_data[statement_descriptor_suffix]"), "XBOARD SERVICE");
      assert.equal(new Headers(init.headers).get("idempotency-key"), context.idempotencyKey);
      return Response.json({ id: sessionId, url: "https://checkout.stripe.com/c/pay/local", expires_at: 1_800_000_000 });
    }
    assert.equal(url.pathname, `/v1/checkout/sessions/${sessionId}`);
    return Response.json({
      id: sessionId,
      mode: "payment",
      payment_status: "paid",
      livemode: false,
      client_reference_id: context.tradeNo,
      metadata: { order_id: context.tradeNo },
      amount_total: 12345,
      currency: "cny",
      payment_intent: "pi_local"
    });
  }, async () => {
    const created = await provider.createCheckout({ ...context, config });
    const raw = JSON.stringify({ id: "evt_local", type: "checkout.session.completed", data: { object: { id: sessionId } } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacHex("SHA-256", config.stripe_webhook_secret, `${timestamp}.${raw}`);
    const verified = await provider.verifyCallback(new Request("https://panel.example.com/notify", {
      method: "POST", headers: { "stripe-signature": `t=${timestamp},v1=${signature}` }, body: raw
    }), config);
    return { created, verified };
  });
  assert.equal(result.created.data, "https://checkout.stripe.com/c/pay/local");
  assert.equal(result.verified.callbackNo, "evt_local");
  assert.equal(result.verified.amount, 12345);
  assert.equal(await providerTest.verifyStripeSignature("{}", "t=1,v1=bad", "whsec_local"), false);
});

test("CoinPayments, EPay, and MGate preserve their signed callback contracts", async () => {
  const coinPayments = paymentProviders.get("CoinPayments");
  const coinConfig = {
    coinpayments_merchant_id: "merchant-1",
    coinpayments_ipn_secret: "ipn-secret",
    coinpayments_currency: "CNY"
  };
  const coinRaw = new URLSearchParams({
    ipn_mode: "hmac", merchant: "merchant-1", status: "100", item_number: context.tradeNo,
    txn_id: "coin-txn", amount1: "123.45", currency1: "CNY"
  }).toString();
  const coinHmac = await hmacHex("SHA-512", coinConfig.coinpayments_ipn_secret, coinRaw);
  const coinResult = await coinPayments.verifyCallback(new Request("https://panel.example.com/notify", {
    method: "POST", headers: { hmac: coinHmac }, body: coinRaw
  }), coinConfig);
  const coinCheckout = await coinPayments.createCheckout({ ...context, config: coinConfig });
  const coinCheckoutUrl = new URL(coinCheckout.data);
  assert.equal(coinCheckoutUrl.searchParams.get("item_number"), context.tradeNo);
  assert.equal(coinCheckoutUrl.searchParams.get("amountf"), "123.45");
  assert.equal(coinResult.amount, 12345);

  const epay = paymentProviders.get("EPay");
  const epayConfig = { url: "https://epay.example.com", pid: "1001", key: "epay-secret", type: "alipay" };
  const epayCheckout = await epay.createCheckout({ ...context, config: epayConfig });
  const epayCheckoutUrl = new URL(epayCheckout.data);
  const epayCreateParams = Object.fromEntries(epayCheckoutUrl.searchParams);
  assert.equal(epayCreateParams.money, "123.45");
  assert.equal(epayCreateParams.sign, md5(`${providerTest.canonical(epayCreateParams, ["sign", "sign_type"])}${epayConfig.key}`));
  const epayParams = {
    money: "123.45", out_trade_no: context.tradeNo, pid: "1001", trade_no: "epay-txn",
    trade_status: "TRADE_SUCCESS", type: "alipay"
  };
  epayParams.sign = md5(`${providerTest.canonical(epayParams, ["sign", "sign_type"])}${epayConfig.key}`);
  const epayResult = await epay.verifyCallback(new Request(`https://panel.example.com/notify?${new URLSearchParams(epayParams)}`), epayConfig);
  assert.equal(epayResult.providerReference, "epay-txn");
  assert.equal(epayResult.amount, 12345);

  const mgate = paymentProviders.get("MGate");
  const mgateConfig = {
    mgate_url: "https://mgate.example.com",
    mgate_app_id: "app-1",
    mgate_app_secret: "mgate-secret",
    mgate_source_currency: ""
  };
  const created = await withFetch(async (_input, init) => {
    const params = Object.fromEntries(new URLSearchParams(String(init.body)));
    assert.equal(params.source_currency, "CNY");
    return Response.json({ data: { trade_no: "mgate-txn", pay_url: "https://mgate.example.com/pay/local" } });
  }, () => mgate.createCheckout({ ...context, config: mgateConfig }));
  assert.equal(created.providerReference, "mgate-txn");
  const mgateParams = {
    app_id: "app-1", out_trade_no: context.tradeNo, source_currency: "CNY",
    status: "paid", total_amount: "12345", trade_no: "mgate-txn"
  };
  const sorted = Object.fromEntries(Object.entries(mgateParams).sort(([left], [right]) => left.localeCompare(right)));
  mgateParams.sign = md5(`${new URLSearchParams(sorted)}${mgateConfig.mgate_app_secret}`);
  const mgateResult = await mgate.verifyCallback(new Request("https://panel.example.com/notify", {
    method: "POST", body: new URLSearchParams(mgateParams)
  }), mgateConfig);
  assert.equal(mgateResult.amount, 12345);
  assert.equal(mgateResult.currency, "CNY");
  await withFetch(async (_input, init) => {
    const params = new URLSearchParams(String(init.body));
    assert.equal(params.get("source_currency"), "USD");
    return Response.json({ data: { trade_no: "mgate-usd", pay_url: "https://mgate.example.com/pay/usd" } });
  }, () => mgate.createCheckout({ ...context, currency: "USD", config: mgateConfig }));
});

test("forged or stale provider callbacks are rejected before settlement", async () => {
  const stripe = paymentProviders.get("Stripe");
  await assert.rejects(() => stripe.verifyCallback(new Request("https://panel.example.com/notify", {
    method: "POST",
    headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=forged` },
    body: "{}"
  }), {
    stripe_secret_key: "sk_test_local",
    stripe_webhook_secret: "whsec_local"
  }), /签名无效/);

  const coinbaseBusinessRaw = JSON.stringify({ id: "68f7a946db0529ea9b6d3a12", eventType: "checkout.payment.success" });
  const stale = Math.floor(Date.now() / 1000) - 301;
  const coinbaseSignature = createHmac("sha256", "hook-secret")
    .update(`${stale}...${coinbaseBusinessRaw}`).digest("hex");
  assert.equal(await providerTest.verifyCoinbaseHook(new Request("https://panel.example.com/notify", {
    headers: { "x-hook0-signature": `t=${stale},h=,v1=${coinbaseSignature}` }
  }), coinbaseBusinessRaw, "hook-secret"), false);

  const coinPayments = paymentProviders.get("CoinPayments");
  const raw = "ipn_mode=hmac&merchant=attacker&status=100";
  const hmac = await hmacHex("SHA-512", "ipn-secret", raw);
  await assert.rejects(() => coinPayments.verifyCallback(new Request("https://panel.example.com/notify", {
    method: "POST", headers: { hmac }, body: raw
  }), {
    coinpayments_merchant_id: "merchant-1",
    coinpayments_ipn_secret: "ipn-secret",
    coinpayments_currency: "CNY"
  }), /Merchant ID/);
});

test("provider callbacks reject malformed amounts and incomplete merchant fields", async () => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const alipay = paymentProviders.get("AlipayF2F");
  const alipayConfig = { app_id: "2026000000000000", private_key: keys.privateKey, public_key: keys.publicKey };
  const alipayParams = {
    app_id: alipayConfig.app_id,
    out_trade_no: context.tradeNo,
    trade_no: "bad-amount",
    trade_status: "TRADE_SUCCESS",
    total_amount: "123.45junk",
    sign_type: "RSA2"
  };
  alipayParams.sign = await rsa2Sign(providerTest.canonical(alipayParams, ["sign", "sign_type"]), keys.privateKey);
  const malformed = await alipay.verifyCallback(new Request("https://panel.example.com/notify", {
    method: "POST",
    body: new URLSearchParams(alipayParams)
  }), alipayConfig);
  assert.equal(malformed.amount, undefined);

  const epay = paymentProviders.get("EPay");
  const epayConfig = { url: "https://epay.example.com", pid: "1001", key: "epay-secret", type: "alipay" };
  const epayParams = {
    money: "123.45", out_trade_no: context.tradeNo, pid: "1001", trade_no: "epay-txn",
    trade_status: "TRADE_SUCCESS"
  };
  epayParams.sign = md5(`${providerTest.canonical(epayParams, ["sign", "sign_type"])}${epayConfig.key}`);
  await assert.rejects(() => epay.verifyCallback(new Request(`https://panel.example.com/notify?${new URLSearchParams(epayParams)}`), epayConfig), /类型不匹配/);

  const mgate = paymentProviders.get("MGate");
  const mgateConfig = {
    mgate_url: "https://mgate.example.com",
    mgate_app_id: "app-1",
    mgate_app_secret: "mgate-secret",
    mgate_source_currency: "CNY"
  };
  const mgateParams = {
    out_trade_no: context.tradeNo, source_currency: "CNY",
    status: "paid", total_amount: "12345", trade_no: "mgate-txn"
  };
  const sorted = Object.fromEntries(Object.entries(mgateParams).sort(([left], [right]) => left.localeCompare(right)));
  mgateParams.sign = md5(`${new URLSearchParams(sorted)}${mgateConfig.mgate_app_secret}`);
  await assert.rejects(() => mgate.verifyCallback(new Request("https://panel.example.com/notify", {
    method: "POST", body: new URLSearchParams(mgateParams)
  }), mgateConfig), /App ID/);

  const stripe = paymentProviders.get("Stripe");
  assert.throws(() => stripe.validateConfig({
    stripe_secret_key: "sk_test_local",
    stripe_webhook_secret: "whsec_local",
    stripe_statement_descriptor: "12345"
  }), /账单描述/);
  assert.throws(() => stripe.validateConfig({
    stripe_secret_key: "sk_test_local",
    stripe_webhook_secret: "whsec_local",
    stripe_statement_descriptor: "XBOARD\\PAY"
  }), /账单描述/);
});

test("callback and checkout URL guards reject oversized or executable input", async () => {
  await assert.rejects(() => paymentTest.boundedCallbackRequest(new Request("https://panel.example.com/notify", {
    method: "POST",
    headers: { "content-length": String(512 * 1024 + 1) },
    body: "small"
  })), /正文过大/);
  assert.throws(() => paymentTest.safeCheckoutUrl("javascript:alert(1)"), /不安全/);
  assert.throws(() => paymentTest.safeCheckoutUrl("https://127.0.0.1/pay"), /不安全/);
  assert.throws(() => paymentTest.safeCheckoutUrl("https://[fd00::1]/pay"), /不安全/);
  assert.throws(() => paymentTest.safeCheckoutUrl("https://[::ffff:127.0.0.1]/pay"), /不安全/);
  assert.throws(() => paymentProviders.get("BTCPay").validateConfig({
    btcpay_url: "https://[fe80::1]",
    btcpay_storeId: "store",
    btcpay_api_key: "key",
    btcpay_webhook_key: "hook"
  }), /本地或私有/);
  assert.equal(paymentTest.safeAppOrigin("http://127.0.0.1:8787/path"), "http://127.0.0.1:8787");
  assert.throws(() => paymentTest.safeAppOrigin("http://panel.example.com"), /HTTPS/);
  assert.equal(paymentTest.safeNotificationOrigin("http://127.0.0.1:8787/path"), "http://127.0.0.1:8787");
  assert.throws(() => paymentTest.safeNotificationOrigin("https://127.0.0.1"), /公开可访问/);
  assert.equal(paymentTest.safeNotificationOrigin("https://panel.example.com/path"), "https://panel.example.com");
});

test("migration keeps unsupported payment warnings non-fatal", () => {
  const source = readFileSync(new URL("../src/migration.ts", import.meta.url), "utf8");
  assert.match(source, /const sourceMismatches: string\[\] = \[\]/);
  assert.match(source, /if \(sourceMismatches\.length \|\| targetMismatches\.length\)/);
  assert.doesNotMatch(source, /if \(warnings\.length \|\| targetMismatches\.length\)/);
});

test("payment migration preserves credentials and disables only unsupported providers", () => {
  const source = readFileSync(new URL("../src/migration.ts", import.meta.url), "utf8");
  const exportBody = source.slice(source.indexOf("function exportRow"), source.indexOf("async function exactRows"));
  assert.doesNotMatch(exportBody, /table === "v2_payment"/);
  assert.match(source, /if \(table === "v2_payment" && !supportedPaymentMethods\.has\(String\(row\.payment \|\| ""\)\)\) row\.enable = 0/);
  assert.match(source, /UPDATE v2_payment SET enable=0,updated_at=\? WHERE uuid IS NULL OR TRIM\(uuid\)=''/);
  assert.match(source, /GROUP BY payment,uuid HAVING COUNT\(\*\)>1/);
  assert.match(source, /渠道 \$\{row\.payment\} 存在重复回调 UUID，相关配置已保留并停用/);
  const prepare = source.slice(source.indexOf("async function prepareMigration"), source.indexOf("async function importBatch"));
  const rollback = source.slice(source.indexOf("async function finishRollback"), source.indexOf("async function finishMigration"));
  assert.match(prepare, /DELETE FROM \$\{PAYMENT_TRANSACTION_TABLE\}/);
  assert.match(rollback, /DELETE FROM \$\{PAYMENT_TRANSACTION_TABLE\}/);
  assert.match(rollback, /DELETE FROM sqlite_sequence WHERE name = \?/);
});

class SqlStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) { return new SqlStatement(this.database, this.sql, bindings); }
  async run() { return this.database.execute(this); }
  async all() { return this.database.query(this); }
  async first() { return (await this.database.query(this)).results[0] || null; }
}

class SqlD1 {
  constructor(db) {
    this.db = db;
    this.failBatch = false;
  }
  prepare(sql) { return new SqlStatement(this, sql); }
  query(statement) {
    const prepared = this.db.prepare(statement.sql);
    try {
      prepared.bind(statement.bindings);
      const results = [];
      while (prepared.step()) results.push(prepared.getAsObject());
      return { results, success: true, meta: { changes: 0 } };
    } finally {
      prepared.free();
    }
  }
  execute(statement) {
    this.db.run(statement.sql, statement.bindings);
    return { results: [], success: true, meta: { changes: this.db.getRowsModified() } };
  }
  async batch(statements) {
    this.db.run("BEGIN");
    try {
      const results = statements.map(statement => /^\s*SELECT/i.test(statement.sql)
        ? this.query(statement)
        : this.execute(statement));
      if (this.failBatch) throw new Error("simulated D1 batch failure");
      this.db.run("COMMIT");
      return results;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }
}

async function settlementDatabase() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run(`
    CREATE TABLE v2_settings(name TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE v2_order(
      id INTEGER PRIMARY KEY,user_id INTEGER,plan_id INTEGER,period TEXT,trade_no TEXT,status INTEGER,type INTEGER,
      surplus_order_ids TEXT,surplus_credit INTEGER,total_amount INTEGER,paid_at INTEGER,callback_no TEXT,updated_at INTEGER
    );
    CREATE TABLE v2_plan(id INTEGER PRIMARY KEY,group_id INTEGER,transfer_enable INTEGER,speed_limit INTEGER,device_limit INTEGER,reset_traffic_method INTEGER);
    CREATE TABLE v2_user(
      id INTEGER PRIMARY KEY,plan_id INTEGER,group_id INTEGER,transfer_enable INTEGER,speed_limit INTEGER,device_limit INTEGER,
      expired_at INTEGER,u INTEGER,d INTEGER,balance INTEGER,last_reset_at INTEGER,next_reset_at INTEGER,reset_count INTEGER,updated_at INTEGER
    );
    CREATE TABLE v2_traffic_reset_logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,reset_type TEXT,old_u INTEGER,old_d INTEGER,old_upload INTEGER,
      old_download INTEGER,old_total INTEGER,new_upload INTEGER,new_download INTEGER,new_total INTEGER,trigger_source TEXT,
      metadata TEXT,reset_time INTEGER,created_at INTEGER
    );
    INSERT INTO v2_settings VALUES ('new_order_event_id','1'),('reset_traffic_method','0');
    INSERT INTO v2_plan VALUES (2,3,100,50,4,0);
    INSERT INTO v2_user VALUES (7,NULL,1,0,NULL,NULL,1700000000,10,20,0,NULL,NULL,0,0);
    INSERT INTO v2_order VALUES (9,7,2,'monthly','ORDER-20260729',0,1,'[]',0,12345,NULL,NULL,0);
  `);
  return { raw, d1: new SqlD1(raw) };
}

const settlementDeps = bumps => ({
  parseJsonArray: value => {
    try { return JSON.parse(String(value || "[]")); } catch { return []; }
  },
  pickSetting: (values, key, fallback) => values[key] ?? fallback,
  addOrderMonths: (timestamp, months) => timestamp + months * 2_592_000,
  nextResetAt: () => 1_800_000_000,
  bump: async (_kv, key) => { bumps.push(key); }
});

const emptyKv = { get: async () => null, put: async () => {}, delete: async () => {} };

async function paymentDatabase() {
  paymentTest.resetPaymentSchema();
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run(`
    CREATE TABLE v2_settings(name TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE v2_payment(
      id INTEGER PRIMARY KEY,name TEXT,payment TEXT,config TEXT,enable INTEGER,uuid TEXT,icon TEXT,
      handling_fee_fixed INTEGER,handling_fee_percent REAL,notify_domain TEXT,sort INTEGER,created_at INTEGER,updated_at INTEGER
    );
    CREATE TABLE v2_order(
      id INTEGER PRIMARY KEY,user_id INTEGER,trade_no TEXT,status INTEGER,total_amount INTEGER,
      payment_id INTEGER,handling_amount INTEGER,updated_at INTEGER
    );
    INSERT INTO v2_settings VALUES
      ('app_url','https://panel.example.com'),('app_name','XBoard'),('currency','CNY');
    INSERT INTO v2_order VALUES (9,7,'ORDER-20260729',0,1000,NULL,0,0);
  `);
  raw.run(`INSERT INTO v2_payment VALUES (1,'Stripe','Stripe',?,1,'stripeuuid','S',100,0,NULL,1,0,0)`, [
    JSON.stringify({ stripe_secret_key: "sk_test_local", stripe_webhook_secret: "whsec_local" })
  ]);
  return { raw, d1: new SqlD1(raw) };
}

test("payment channels validate migrated configuration before activation", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  raw.run("UPDATE v2_payment SET enable=0,config='{}' WHERE id=1");
  const toggle = () => handleAdminPayment(new Request("https://panel.example.com/api/v1/admin/payment/show", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1 })
  }), env, "/payment/show");

  const invalid = await toggle();
  assert.equal(invalid.status, 422);
  assert.equal(raw.exec("SELECT enable FROM v2_payment WHERE id=1")[0].values[0][0], 0);

  raw.run("UPDATE v2_payment SET config=?,uuid=NULL WHERE id=1", [
    JSON.stringify({ stripe_secret_key: "sk_test_local", stripe_webhook_secret: "whsec_local" })
  ]);
  const missingUuid = await toggle();
  assert.equal(missingUuid.status, 422);

  raw.run("UPDATE v2_payment SET uuid='stripeuuid' WHERE id=1");
  raw.run(`INSERT INTO v2_payment VALUES (2,'Duplicate','Stripe',?,0,'stripeuuid','S',0,0,NULL,2,0,0)`, [
    JSON.stringify({ stripe_secret_key: "sk_test_other", stripe_webhook_secret: "whsec_other" })
  ]);
  const duplicate = await toggle();
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 409);

  raw.run("DELETE FROM v2_payment WHERE id=2");
  const enabled = await toggle();
  assert.equal(enabled.status, 200);
  assert.equal(raw.exec("SELECT enable FROM v2_payment WHERE id=1")[0].values[0][0], 1);

  raw.run("UPDATE v2_payment SET config='{}' WHERE id=1");
  const disabled = await toggle();
  assert.equal(disabled.status, 200);
  assert.equal(raw.exec("SELECT enable FROM v2_payment WHERE id=1")[0].values[0][0], 0);
});

test("checkout freezes amount and currency while active channels cannot be mutated or deleted", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  const order = { id: 9, trade_no: context.tradeNo, total_amount: 1000 };
  const user = { id: 7, email: "user@example.com" };
  const first = await withFetch(async () => Response.json({
    id: "cs_test_frozen",
    url: "https://checkout.stripe.com/c/pay/frozen",
    expires_at: Math.floor(Date.now() / 1000) + 3600
  }), () => checkoutPayment(new Request("https://panel.example.com/api/v1/user/order/checkout"), env, order, user, 1, async () => false));
  assert.equal(first.status, 200);
  assert.deepEqual(raw.exec("SELECT expected_amount,currency,status FROM v2_payment_transactions")[0].values[0], [1100, "CNY", "ready"]);
  assert.deepEqual(raw.exec("SELECT payment_id,handling_amount FROM v2_order WHERE id=9")[0].values[0], [1, 100]);

  raw.run("UPDATE v2_settings SET value='USD' WHERE name='currency'");
  raw.run("UPDATE v2_payment SET handling_fee_fixed=500 WHERE id=1");
  invalidateSettingsCache();
  let repeatedFetches = 0;
  const repeated = await withFetch(async () => {
    repeatedFetches++;
    throw new Error("a fresh provider session must not be created");
  }, () => checkoutPayment(new Request("https://panel.example.com/api/v1/user/order/checkout"), env, order, user, 1, async () => false));
  assert.equal(repeated.status, 200);
  assert.equal(repeatedFetches, 0);
  assert.deepEqual(raw.exec("SELECT expected_amount,currency FROM v2_payment_transactions")[0].values[0], [1100, "CNY"]);
  assert.deepEqual(raw.exec("SELECT handling_amount FROM v2_order WHERE id=9")[0].values[0], [100]);

  const changedConfig = await handleAdminPayment(new Request("https://panel.example.com/api/v1/admin/payment/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: 1,
      name: "Stripe",
      payment: "Stripe",
      config: { stripe_secret_key: "sk_test_changed", stripe_webhook_secret: "whsec_changed" },
      handling_fee_fixed: 500,
      handling_fee_percent: 0
    })
  }), env, "/payment/save");
  assert.equal(changedConfig.status, 409);

  const changedProvider = await handleAdminPayment(new Request("https://panel.example.com/api/v1/admin/payment/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: 1,
      name: "EPay",
      payment: "EPay",
      config: { url: "https://epay.example.com", pid: "1001", key: "secret" }
    })
  }), env, "/payment/save");
  assert.equal(changedProvider.status, 409);

  const dropped = await handleAdminPayment(new Request("https://panel.example.com/api/v1/admin/payment/drop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1 })
  }), env, "/payment/drop");
  assert.equal(dropped.status, 409);
});

test("enabled payment channels reject credential and callback-domain changes before their first checkout", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  const save = config => handleAdminPayment(new Request("https://panel.example.com/api/v1/admin/payment/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: 1,
      name: "Stripe",
      payment: "Stripe",
      config,
      notify_domain: "https://payments.example.com",
      handling_fee_fixed: 100,
      handling_fee_percent: 0
    })
  }), env, "/payment/save");

  const blocked = await save({ stripe_secret_key: "sk_test_changed", stripe_webhook_secret: "whsec_changed" });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).message, /先停用支付渠道/);
  assert.equal(JSON.parse(raw.exec("SELECT config FROM v2_payment WHERE id=1")[0].values[0][0]).stripe_secret_key, "sk_test_local");

  raw.run("UPDATE v2_payment SET enable=0 WHERE id=1");
  const saved = await save({ stripe_secret_key: "sk_test_changed", stripe_webhook_secret: "whsec_changed" });
  assert.equal(saved.status, 200);
  assert.deepEqual(raw.exec("SELECT enable,notify_domain FROM v2_payment WHERE id=1")[0].values[0], [0, "https://payments.example.com"]);
});

test("disabled payment channels can rotate credentials without losing paid history", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  raw.run("UPDATE v2_payment SET enable=0 WHERE id=1");
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  await paymentTest.ensurePaymentSchema(env);
  raw.run("UPDATE v2_order SET payment_id=1,handling_amount=100 WHERE id=9");
  raw.run("INSERT INTO v2_order VALUES (10,7,'ORDER-PAID',3,1000,1,100,0)");
  raw.run(`INSERT INTO v2_payment_transactions(
    order_id,trade_no,payment_id,provider,expected_amount,currency,idempotency_key,status,created_at,updated_at
  ) VALUES
    (9,'ORDER-20260729',1,'Stripe:1',1100,'CNY','pending-key','ready',1,1),
    (10,'ORDER-PAID',1,'Stripe:1',1100,'CNY','paid-key','paid',1,1)`);
  const response = await handleAdminPayment(new Request("https://panel.example.com/api/v1/admin/payment/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: 1,
      name: "Stripe",
      payment: "Stripe",
      config: { stripe_secret_key: "sk_test_race", stripe_webhook_secret: "whsec_race" },
      handling_fee_fixed: 100,
      handling_fee_percent: 0
    })
  }), env, "/payment/save");
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(raw.exec("SELECT config FROM v2_payment WHERE id=1")[0].values[0][0]).stripe_secret_key, "sk_test_race");
  assert.deepEqual(raw.exec("SELECT payment_id,handling_amount FROM v2_order WHERE id=9")[0].values[0], [null, 0]);
  assert.deepEqual(raw.exec("SELECT payment_id,handling_amount FROM v2_order WHERE id=10")[0].values[0], [1, 100]);
  assert.deepEqual(raw.exec("SELECT trade_no,status FROM v2_payment_transactions")[0].values, [["ORDER-PAID", "paid"]]);
});

test("checkout detects a channel change before provider I/O and removes its unused claim", async () => {
  invalidateSettingsCache();
  const { raw } = await paymentDatabase();
  class ChangedPaymentSqlD1 extends SqlD1 {
    changed = false;
    execute(statement) {
      const result = super.execute(statement);
      if (!this.changed && /INSERT OR IGNORE INTO v2_payment_transactions/.test(statement.sql)) {
        this.changed = true;
        this.db.run("UPDATE v2_payment SET config=?,updated_at=1 WHERE id=1", [
          JSON.stringify({ stripe_secret_key: "sk_test_new", stripe_webhook_secret: "whsec_new" })
        ]);
      }
      return result;
    }
  }
  paymentTest.resetPaymentSchema();
  let providerCalls = 0;
  const response = await withFetch(async () => {
    providerCalls++;
    throw new Error("provider must not be called with stale credentials");
  }, () => checkoutPayment(
    new Request("https://panel.example.com/api/v1/user/order/checkout"),
    { XBOARD_DB: new ChangedPaymentSqlD1(raw), XBOARD_KV: emptyKv },
    { id: 9, trade_no: context.tradeNo, total_amount: 1000 },
    { id: 7, email: "user@example.com" },
    1,
    async () => false
  ));
  assert.equal(response.status, 409);
  assert.equal(providerCalls, 0);
  assert.equal(raw.exec("SELECT COUNT(*) FROM v2_payment_transactions")[0].values[0][0], 0);
  assert.deepEqual(raw.exec("SELECT payment_id,handling_amount FROM v2_order WHERE id=9")[0].values[0], [null, 0]);
});

test("a statically incompatible payment currency leaves no transaction or order binding", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  raw.run("UPDATE v2_settings SET value='USD' WHERE name='currency'");
  raw.run("UPDATE v2_payment SET payment='EPay',config=? WHERE id=1", [
    JSON.stringify({ url: "https://epay.example.com", pid: "1001", key: "secret" })
  ]);
  paymentTest.resetPaymentSchema();
  const response = await checkoutPayment(
    new Request("https://panel.example.com/api/v1/user/order/checkout"),
    { XBOARD_DB: d1, XBOARD_KV: emptyKv },
    { id: 9, trade_no: context.tradeNo, total_amount: 1000 },
    { id: 7, email: "user@example.com" },
    1,
    async () => false
  );
  assert.equal(response.status, 400);
  assert.equal(raw.exec("SELECT COUNT(*) FROM v2_payment_transactions")[0].values[0][0], 0);
  assert.deepEqual(raw.exec("SELECT payment_id,handling_amount FROM v2_order WHERE id=9")[0].values[0], [null, 0]);
});

test("a canceled order cannot receive a reused hosted checkout URL", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  const order = { id: 9, trade_no: context.tradeNo, total_amount: 1000 };
  const user = { id: 7, email: "user@example.com" };
  const created = await withFetch(async () => Response.json({
    id: "cs_test_reused",
    url: "https://checkout.stripe.com/c/pay/reused",
    expires_at: 2000000000
  }), () => checkoutPayment(
    new Request("https://panel.example.com/api/v1/user/order/checkout"),
    { XBOARD_DB: d1, XBOARD_KV: emptyKv }, order, user, 1, async () => false
  ));
  assert.equal(created.status, 200);
  class CancelBeforeRebindD1 extends SqlD1 {
    canceled = false;
    execute(statement) {
      if (!this.canceled && /UPDATE v2_order SET payment_id=\?,handling_amount=\?,updated_at=\? WHERE id=\? AND status=0/.test(statement.sql)) {
        this.canceled = true;
        this.db.run("UPDATE v2_order SET status=2 WHERE id=9");
      }
      return super.execute(statement);
    }
  }
  const response = await checkoutPayment(
    new Request("https://panel.example.com/api/v1/user/order/checkout"),
    { XBOARD_DB: new CancelBeforeRebindD1(raw), XBOARD_KV: emptyKv },
    order, user, 1, async () => false
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /订单状态已变化/);
  assert.equal(raw.exec("SELECT status FROM v2_order WHERE id=9")[0].values[0][0], 2);
});

test("checkout refuses migrated channels without a callback UUID", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  raw.run("UPDATE v2_payment SET uuid=NULL WHERE id=1");
  let providerCalls = 0;
  const response = await withFetch(async () => {
    providerCalls++;
    throw new Error("provider must not be called");
  }, () => checkoutPayment(
    new Request("https://panel.example.com/api/v1/user/order/checkout"),
    { XBOARD_DB: d1, XBOARD_KV: emptyKv },
    { id: 9, trade_no: context.tradeNo, total_amount: 1000 },
    { id: 7, email: "user@example.com" },
    1,
    async () => false
  ));
  assert.equal(response.status, 409);
  assert.equal(providerCalls, 0);
});

test("callbacks use the frozen transaction currency and preserve the first event id", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  const order = { id: 9, trade_no: context.tradeNo, total_amount: 1000 };
  await withFetch(async () => Response.json({
    id: "cs_test_callback",
    url: "https://checkout.stripe.com/c/pay/callback",
    expires_at: Math.floor(Date.now() / 1000) + 3600
  }), () => checkoutPayment(new Request("https://panel.example.com/api/v1/user/order/checkout"), env, order, {
    id: 7, email: "user@example.com"
  }, 1, async () => false));
  raw.run("UPDATE v2_settings SET value='USD' WHERE name='currency'");
  invalidateSettingsCache();

  let settleCalls = 0;
  const send = async eventId => {
    const rawEvent = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_callback" } }
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacHex("SHA-256", "whsec_local", `${timestamp}.${rawEvent}`);
    return withFetch(async () => Response.json({
      id: "cs_test_callback",
      mode: "payment",
      payment_status: "paid",
      livemode: false,
      client_reference_id: context.tradeNo,
      metadata: { order_id: context.tradeNo },
      amount_total: 1100,
      currency: "cny",
      payment_intent: "pi_frozen"
    }), () => handlePaymentCallback(new Request("https://panel.example.com/api/v1/guest/payment/notify/Stripe/stripeuuid", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: rawEvent
    }), env, "Stripe", "stripeuuid", async () => {
      settleCalls++;
      return true;
    }));
  };
  assert.equal((await send("evt_first")).status, 200);
  assert.equal((await send("evt_second")).status, 200);
  assert.equal(settleCalls, 2);
  assert.deepEqual(raw.exec("SELECT status,event_id,currency,expected_amount FROM v2_payment_transactions")[0].values[0], [
    "paid", "evt_first", "CNY", 1100
  ]);

  raw.run("INSERT INTO v2_order VALUES (10,7,'ORDER-REPLAY',0,1000,1,100,0)");
  raw.run(`INSERT INTO v2_payment_transactions(
    order_id,trade_no,payment_id,provider,provider_reference,expected_amount,currency,idempotency_key,status,created_at,updated_at
  ) VALUES (10,'ORDER-REPLAY',1,'Stripe','cs_test_replay',1100,'CNY','replay-key','ready',1,1)`);
  const replayRaw = JSON.stringify({
    id: "evt_first",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_replay" } }
  });
  const replayTimestamp = Math.floor(Date.now() / 1000);
  const replaySignature = await hmacHex("SHA-256", "whsec_local", `${replayTimestamp}.${replayRaw}`);
  const replay = await withFetch(async () => Response.json({
    id: "cs_test_replay",
    mode: "payment",
    payment_status: "paid",
    livemode: false,
    client_reference_id: "ORDER-REPLAY",
    metadata: { order_id: "ORDER-REPLAY" },
    amount_total: 1100,
    currency: "cny",
    payment_intent: "pi_replay"
  }), () => handlePaymentCallback(new Request("https://panel.example.com/api/v1/guest/payment/notify/Stripe/stripeuuid", {
    method: "POST",
    headers: { "stripe-signature": `t=${replayTimestamp},v1=${replaySignature}` },
    body: replayRaw
  }), env, "Stripe", "stripeuuid", async () => true));
  assert.equal(replay.status, 409);
  assert.equal(raw.exec("SELECT status FROM v2_order WHERE id=10")[0].values[0][0], 0);
});

test("ambiguous migrated payment callback UUIDs fail closed before verification", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  raw.run(`INSERT INTO v2_payment VALUES (2,'Stripe duplicate','Stripe',?,1,'stripeuuid','S',0,0,NULL,2,0,0)`, [
    JSON.stringify({ stripe_secret_key: "sk_test_other", stripe_webhook_secret: "whsec_other" })
  ]);
  let settled = false;
  const response = await handlePaymentCallback(new Request(
    "https://panel.example.com/api/v1/guest/payment/notify/Stripe/stripeuuid",
    { method: "POST", body: "{}" }
  ), { XBOARD_DB: d1, XBOARD_KV: emptyKv }, "Stripe", "stripeuuid", async () => {
    settled = true;
    return true;
  });
  assert.equal(response.status, 409);
  assert.equal(await response.text(), "ambiguous payment method");
  assert.equal(settled, false);
});

test("stale checkout claims recover while unsafe provider URLs fail closed", async () => {
  invalidateSettingsCache();
  const recovered = await paymentDatabase();
  const recoveredEnv = { XBOARD_DB: recovered.d1, XBOARD_KV: emptyKv };
  const order = { id: 9, trade_no: context.tradeNo, total_amount: 1000 };
  await recoveredEnv.XBOARD_DB.prepare(`CREATE TABLE IF NOT EXISTS v2_payment_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL,trade_no TEXT NOT NULL,payment_id INTEGER NOT NULL,
    provider TEXT NOT NULL,provider_reference TEXT,expected_amount INTEGER NOT NULL,currency TEXT NOT NULL,
    checkout_url TEXT,idempotency_key TEXT NOT NULL,event_id TEXT,status TEXT NOT NULL DEFAULT 'pending',
    expires_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    UNIQUE(order_id,payment_id),UNIQUE(provider,provider_reference),UNIQUE(provider,event_id),UNIQUE(idempotency_key)
  )`).run();
  recovered.raw.run(`INSERT INTO v2_payment_transactions(
    order_id,trade_no,payment_id,provider,expected_amount,currency,idempotency_key,status,created_at,updated_at
  ) VALUES (9,'ORDER-20260729',1,'Stripe',1100,'CNY','stale-key','creating',1,1)`);
  const response = await withFetch(async (_input, init) => {
    assert.equal(new Headers(init.headers).get("idempotency-key"), "stale-key");
    return Response.json({
      id: "cs_test_recovered",
      url: "https://checkout.stripe.com/c/pay/recovered",
      expires_at: Math.floor(Date.now() / 1000) + 3600
    });
  }, () => checkoutPayment(new Request("https://panel.example.com/api/v1/user/order/checkout"), recoveredEnv, order, {
    id: 7, email: "user@example.com"
  }, 1, async () => false));
  assert.equal(response.status, 200);
  assert.deepEqual(recovered.raw.exec("SELECT status,provider_reference FROM v2_payment_transactions")[0].values[0], [
    "ready", "cs_test_recovered"
  ]);

  invalidateSettingsCache();
  const unsafe = await paymentDatabase();
  const unsafeEnv = { XBOARD_DB: unsafe.d1, XBOARD_KV: emptyKv };
  const rejected = await withFetch(async () => Response.json({
    id: "cs_test_unsafe",
    url: "javascript:alert(1)"
  }), () => checkoutPayment(new Request("https://panel.example.com/api/v1/user/order/checkout"), unsafeEnv, order, {
    id: 7, email: "user@example.com"
  }, 1, async () => false));
  assert.equal(rejected.status, 502);
  assert.equal(unsafe.raw.exec("SELECT status FROM v2_payment_transactions")[0].values[0][0], "failed");
  assert.deepEqual(unsafe.raw.exec("SELECT payment_id,handling_amount FROM v2_order WHERE id=9")[0].values[0], [1, 100]);
});

test("expired hosted sessions require a new order instead of reusing an idempotency key", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  await env.XBOARD_DB.prepare(`CREATE TABLE IF NOT EXISTS v2_payment_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL,trade_no TEXT NOT NULL,payment_id INTEGER NOT NULL,
    provider TEXT NOT NULL,provider_reference TEXT,expected_amount INTEGER NOT NULL,currency TEXT NOT NULL,
    checkout_url TEXT,idempotency_key TEXT NOT NULL,event_id TEXT,status TEXT NOT NULL,expires_at INTEGER,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    UNIQUE(order_id,payment_id),UNIQUE(provider,provider_reference),UNIQUE(provider,event_id),UNIQUE(idempotency_key)
  )`).run();
  raw.run(`INSERT INTO v2_payment_transactions(
    order_id,trade_no,payment_id,provider,provider_reference,expected_amount,currency,checkout_url,idempotency_key,status,expires_at,created_at,updated_at
  ) VALUES (9,?,1,'Stripe:1','cs_expired',1100,'CNY','https://checkout.stripe.com/c/pay/expired','expired-key','ready',1,1,1)`, [context.tradeNo]);
  let providerCalls = 0;
  const response = await withFetch(async () => {
    providerCalls++;
    throw new Error("expired checkout must not call the provider");
  }, () => checkoutPayment(
    new Request("https://panel.example.com/api/v1/user/order/checkout"), env,
    { id: 9, trade_no: context.tradeNo, total_amount: 1000 },
    { id: 7, email: "user@example.com" }, 1, async () => false
  ));
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /取消当前订单后重新下单/);
  assert.equal(providerCalls, 0);
  assert.deepEqual(raw.exec("SELECT idempotency_key,status FROM v2_payment_transactions")[0].values[0], ["expired-key", "ready"]);
});

test("checkout binds the payment before an early provider callback can arrive", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  let callbackResponse;
  let settleCalls = 0;
  const checkout = await withFetch(async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions" && init.method === "POST") {
      assert.deepEqual(raw.exec("SELECT payment_id,handling_amount FROM v2_order WHERE id=9")[0].values[0], [1, 100]);
      const eventRaw = JSON.stringify({
        id: "evt_early",
        type: "checkout.session.completed",
        data: { object: { id: "cs_test_early" } }
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = await hmacHex("SHA-256", "whsec_local", `${timestamp}.${eventRaw}`);
      callbackResponse = await handlePaymentCallback(new Request(
        "https://panel.example.com/api/v1/guest/payment/notify/Stripe/stripeuuid",
        {
          method: "POST",
          headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
          body: eventRaw
        }
      ), env, "Stripe", "stripeuuid", async () => {
        settleCalls++;
        return true;
      });
      return Response.json({
        id: "cs_test_early",
        url: "https://checkout.stripe.com/c/pay/early",
        expires_at: Math.floor(Date.now() / 1000) + 3600
      });
    }
    if (url.pathname === "/v1/checkout/sessions/cs_test_early") {
      return Response.json({
        id: "cs_test_early",
        mode: "payment",
        payment_status: "paid",
        livemode: false,
        client_reference_id: context.tradeNo,
        metadata: { order_id: context.tradeNo },
        amount_total: 1100,
        currency: "cny",
        payment_intent: "pi_early"
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }, () => checkoutPayment(
    new Request("https://panel.example.com/api/v1/user/order/checkout"),
    env,
    { id: 9, trade_no: context.tradeNo, total_amount: 1000 },
    { id: 7, email: "user@example.com" },
    1,
    async () => false
  ));
  assert.equal(callbackResponse?.status, 200);
  assert.equal(checkout.status, 200);
  assert.equal(settleCalls, 1);
  assert.deepEqual(raw.exec("SELECT status,provider_reference,checkout_url FROM v2_payment_transactions")[0].values[0], [
    "paid", "cs_test_early", "https://checkout.stripe.com/c/pay/early"
  ]);
});

test("percentage and fixed payment fees are rounded once in integer cents", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  raw.run("UPDATE v2_payment SET handling_fee_fixed=3,handling_fee_percent=2.5 WHERE id=1");
  raw.run("UPDATE v2_order SET total_amount=1001 WHERE id=9");
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  const response = await withFetch(async (_input, init = {}) => {
    const params = new URLSearchParams(String(init.body || ""));
    assert.equal(params.get("line_items[0][price_data][unit_amount]"), "1029");
    return Response.json({
      id: "cs_fee_rounding",
      url: "https://checkout.stripe.com/c/pay/fee-rounding",
      expires_at: Math.floor(Date.now() / 1000) + 3600
    });
  }, () => checkoutPayment(
    new Request("https://panel.example.com/api/v1/user/order/checkout"), env,
    { id: 9, trade_no: context.tradeNo, total_amount: 1001 },
    { id: 7, email: "user@example.com" }, 1, async () => false
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(raw.exec("SELECT expected_amount FROM v2_payment_transactions")[0].values[0], [1029]);
  assert.deepEqual(raw.exec("SELECT handling_amount FROM v2_order WHERE id=9")[0].values[0], [28]);
});

test("separate merchant channels do not collide on provider references or event ids", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  raw.run(`INSERT INTO v2_payment VALUES (2,'Stripe 2','Stripe',?,1,'stripeuuid2','S',100,0,NULL,2,0,0)`, [
    JSON.stringify({ stripe_secret_key: "sk_test_other", stripe_webhook_secret: "whsec_other" })
  ]);
  raw.run("INSERT INTO v2_order VALUES (10,7,'ORDER-SECOND',0,1000,NULL,0,0)");
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  for (const [orderId, tradeNo, paymentId] of [[9, context.tradeNo, 1], [10, "ORDER-SECOND", 2]]) {
    const response = await withFetch(async () => Response.json({
      id: "cs_shared_reference",
      url: `https://checkout.stripe.com/c/pay/channel-${paymentId}`,
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }), () => checkoutPayment(
      new Request("https://panel.example.com/api/v1/user/order/checkout"), env,
      { id: orderId, trade_no: tradeNo, total_amount: 1000 },
      { id: 7, email: "user@example.com" }, paymentId, async () => false
    ));
    assert.equal(response.status, 200);
  }
  assert.deepEqual(raw.exec("SELECT provider FROM v2_payment_transactions ORDER BY payment_id")[0].values, [
    ["Stripe:1"], ["Stripe:2"]
  ]);

  let settles = 0;
  for (const [uuid, webhookSecret, tradeNo] of [
    ["stripeuuid", "whsec_local", context.tradeNo],
    ["stripeuuid2", "whsec_other", "ORDER-SECOND"]
  ]) {
    const eventRaw = JSON.stringify({
      id: "evt_shared_event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_shared_reference" } }
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacHex("SHA-256", webhookSecret, `${timestamp}.${eventRaw}`);
    const response = await withFetch(async () => Response.json({
      id: "cs_shared_reference",
      mode: "payment",
      payment_status: "paid",
      livemode: false,
      client_reference_id: tradeNo,
      metadata: { order_id: tradeNo },
      amount_total: 1100,
      currency: "cny",
      payment_intent: `pi_${tradeNo}`
    }), () => handlePaymentCallback(new Request(
      `https://panel.example.com/api/v1/guest/payment/notify/Stripe/${uuid}`,
      {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body: eventRaw
      }
    ), env, "Stripe", uuid, async () => {
      settles++;
      return true;
    }));
    assert.equal(response.status, 200);
  }
  assert.equal(settles, 2);
  assert.deepEqual(raw.exec("SELECT status,event_id FROM v2_payment_transactions ORDER BY payment_id")[0].values, [
    ["paid", "evt_shared_event"], ["paid", "evt_shared_event"]
  ]);
});

test("a verified late payment after cancellation is recorded without opening service", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await paymentDatabase();
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  const order = { id: 9, trade_no: context.tradeNo, total_amount: 1000 };
  await withFetch(async () => Response.json({
    id: "cs_test_canceled",
    url: "https://checkout.stripe.com/c/pay/canceled",
    expires_at: Math.floor(Date.now() / 1000) + 3600
  }), () => checkoutPayment(new Request("https://panel.example.com/api/v1/user/order/checkout"), env, order, {
    id: 7, email: "user@example.com"
  }, 1, async () => false));
  raw.run("UPDATE v2_order SET status=2 WHERE id=9");
  raw.run("UPDATE v2_payment_transactions SET status='canceled' WHERE order_id=9");

  const rawEvent = JSON.stringify({
    id: "evt_after_cancel",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_canceled" } }
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacHex("SHA-256", "whsec_local", `${timestamp}.${rawEvent}`);
  let settleCalls = 0;
  const response = await withFetch(async () => Response.json({
    id: "cs_test_canceled",
    mode: "payment",
    payment_status: "paid",
    livemode: false,
    client_reference_id: context.tradeNo,
    metadata: { order_id: context.tradeNo },
    amount_total: 1100,
    currency: "cny",
    payment_intent: "pi_canceled"
  }), () => handlePaymentCallback(new Request("https://panel.example.com/api/v1/guest/payment/notify/Stripe/stripeuuid", {
    method: "POST",
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
    body: rawEvent
  }), env, "Stripe", "stripeuuid", async () => {
    settleCalls++;
    return true;
  }));
  assert.equal(response.status, 200);
  assert.equal(settleCalls, 0);
  assert.equal(raw.exec("SELECT status FROM v2_order WHERE id=9")[0].values[0][0], 2);
  assert.deepEqual(raw.exec("SELECT status,event_id FROM v2_payment_transactions")[0].values[0], [
    "paid_unapplied", "evt_after_cancel"
  ]);
});

test("settlement is atomic, idempotent, and leaves no processing status", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await settlementDatabase();
  const bumps = [];
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  const order = { id: 9 };
  assert.equal(await settleOrder(env, order, "provider-callback", settlementDeps(bumps)), true);
  assert.deepEqual(raw.exec("SELECT status,callback_no FROM v2_order WHERE id=9")[0].values[0], [3, "provider-callback"]);
  assert.deepEqual(raw.exec("SELECT plan_id,group_id,u,d,reset_count FROM v2_user WHERE id=7")[0].values[0], [2, 3, 0, 0, 1]);
  assert.equal(raw.exec("SELECT COUNT(*) FROM v2_traffic_reset_logs")[0].values[0][0], 1);
  assert.deepEqual(bumps, ["user_version:7"]);
  assert.equal(await settleOrder(env, order, "duplicate", settlementDeps(bumps)), true);
  assert.equal(raw.exec("SELECT COUNT(*) FROM v2_traffic_reset_logs")[0].values[0][0], 1);
  assert.deepEqual(bumps, ["user_version:7"]);
});

test("concurrent settlement attempts apply business side effects only once", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await settlementDatabase();
  const bumps = [];
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  const results = await Promise.all([
    settleOrder(env, { id: 9 }, "callback-a", settlementDeps(bumps)),
    settleOrder(env, { id: 9 }, "callback-b", settlementDeps(bumps))
  ]);
  assert.deepEqual(results, [true, true]);
  assert.equal(raw.exec("SELECT status FROM v2_order WHERE id=9")[0].values[0][0], 3);
  assert.equal(raw.exec("SELECT reset_count FROM v2_user WHERE id=7")[0].values[0][0], 1);
  assert.equal(raw.exec("SELECT COUNT(*) FROM v2_traffic_reset_logs")[0].values[0][0], 1);
  assert.deepEqual(bumps, ["user_version:7"]);
});

test("a failed D1 settlement batch rolls back every business side effect", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await settlementDatabase();
  d1.failBatch = true;
  const env = { XBOARD_DB: d1, XBOARD_KV: emptyKv };
  await assert.rejects(() => settleOrder(env, { id: 9 }, "provider-callback", settlementDeps([])), /simulated D1/);
  assert.equal(raw.exec("SELECT status FROM v2_order WHERE id=9")[0].values[0][0], 0);
  assert.deepEqual(raw.exec("SELECT plan_id,u,d,reset_count FROM v2_user WHERE id=7")[0].values[0], [null, 10, 20, 0]);
  assert.equal(raw.exec("SELECT COUNT(*) FROM v2_traffic_reset_logs")[0].values[0][0], 0);
});

test("non-reset settlement never overwrites traffic that arrived after its initial read", async () => {
  invalidateSettingsCache();
  const { raw, d1 } = await settlementDatabase();
  raw.run("UPDATE v2_settings SET value='0' WHERE name='new_order_event_id'");
  raw.run("INSERT INTO v2_settings VALUES ('renew_order_event_id','0')");
  raw.run("UPDATE v2_order SET type=2 WHERE id=9");
  const batch = d1.batch.bind(d1);
  d1.batch = async statements => {
    raw.run("UPDATE v2_user SET u=777,d=888 WHERE id=7");
    return batch(statements);
  };
  assert.equal(await settleOrder({ XBOARD_DB: d1, XBOARD_KV: emptyKv }, { id: 9 }, "renewal", settlementDeps([])), true);
  assert.deepEqual(raw.exec("SELECT u,d,reset_count FROM v2_user WHERE id=7")[0].values[0], [777, 888, 0]);
  assert.equal(raw.exec("SELECT COUNT(*) FROM v2_traffic_reset_logs")[0].values[0][0], 0);
});

test("reset settlement logs the current traffic and cannot pay after its plan disappears", async () => {
  invalidateSettingsCache();
  const first = await settlementDatabase();
  const firstBatch = first.d1.batch.bind(first.d1);
  first.d1.batch = async statements => {
    first.raw.run("UPDATE v2_user SET u=111,d=222 WHERE id=7");
    return firstBatch(statements);
  };
  assert.equal(await settleOrder({ XBOARD_DB: first.d1, XBOARD_KV: emptyKv }, { id: 9 }, "reset", settlementDeps([])), true);
  assert.deepEqual(first.raw.exec("SELECT old_u,old_d,old_total FROM v2_traffic_reset_logs")[0].values[0], [111, 222, 333]);

  invalidateSettingsCache();
  const second = await settlementDatabase();
  const secondBatch = second.d1.batch.bind(second.d1);
  second.d1.batch = async statements => {
    second.raw.run("DELETE FROM v2_plan WHERE id=2");
    return secondBatch(statements);
  };
  assert.equal(await settleOrder({ XBOARD_DB: second.d1, XBOARD_KV: emptyKv }, { id: 9 }, "missing-plan", settlementDeps([])), false);
  assert.equal(second.raw.exec("SELECT status FROM v2_order WHERE id=9")[0].values[0][0], 0);
  assert.deepEqual(second.raw.exec("SELECT plan_id,u,d FROM v2_user WHERE id=7")[0].values[0], [null, 10, 20]);
});
