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
import { settleOrder } from "../src/payment/settlement.ts";

const context = {
  config: {},
  tradeNo: "ORDER-20260729",
  amount: 12345,
  currency: "CNY",
  userId: 7,
  userEmail: "user@example.com",
  appName: "XBoard",
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
  assert.match(source, /SELECT \* FROM v2_payment WHERE payment=\? AND uuid=\?/);
  assert.doesNotMatch(source, /SELECT \* FROM v2_payment WHERE payment=\? AND uuid=\? AND enable=1/);
  assert.match(source, /Number\(order\.payment_id \|\| 0\) !== Number\(payment\.id\)/);
});

test("payment credentials are recursively removed from audit data", () => {
  const source = {
    name: "Stripe",
    config: {
      stripe_secret_key: "sk_live_private",
      stripe_webhook_secret: "whsec_private",
      nested: [{ api_key: "api-private", public_key: "public" }]
    },
    access_token: "token-private",
    handling_fee_fixed: 100
  };
  const redacted = redactAuditValue(source);
  assert.equal(redacted.config.stripe_secret_key, "[REDACTED]");
  assert.equal(redacted.config.stripe_webhook_secret, "[REDACTED]");
  assert.equal(redacted.config.nested[0].api_key, "[REDACTED]");
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
    const responseBody = JSON.stringify({ code: "10000", msg: "Success", out_trade_no: context.tradeNo, qr_code: "https://qr.example/pay" });
    const responseSignature = sign("RSA-SHA256", Buffer.from(responseBody), keys.privateKey).toString("base64");
    return new Response(`{"alipay_trade_precreate_response":${responseBody},"sign":"${responseSignature}"}`);
  }, () => provider.createCheckout({ ...context, config }));
  assert.deepEqual(result, { type: 0, data: "https://qr.example/pay", providerReference: context.tradeNo });

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
      return Response.json({ id: "invoice-1", checkoutLink: "https://btcpay.example.com/i/invoice-1" });
    }
    assert.equal(url.pathname.endsWith("/invoices/invoice-1"), true);
    return Response.json({
      id: "invoice-1", storeId: "store-1", status: "Settled",
      amount: "123.45", currency: "CNY", metadata: { orderId: context.tradeNo }
    });
  }, async () => {
    const created = await provider.createCheckout({ ...context, config });
    const raw = JSON.stringify({ type: "InvoiceSettled", invoiceId: "invoice-1" });
    const signature = `sha256=${await hmacHex("SHA-256", config.btcpay_webhook_key, raw)}`;
    const verified = await provider.verifyCallback(new Request("https://panel.example.com/notify", {
      method: "POST", headers: { "btcpay-sig": signature }, body: raw
    }), config);
    return { created, verified };
  });
  assert.equal(createSeen, true);
  assert.equal(result.created.providerReference, "invoice-1");
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
      return Response.json({ data: { id: chargeId, hosted_url: "https://commerce.coinbase.com/charges/local" } });
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
      id: checkoutId, status: "COMPLETED", amount: "123.45", currency: "CNY",
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
    assert.equal(new Headers(init.headers).get("stripe-version"), providerTest.STRIPE_API_VERSION);
    if (init.method === "POST") {
      const params = new URLSearchParams(String(init.body));
      assert.equal(params.get("mode"), "payment");
      assert.equal(params.get("line_items[0][price_data][unit_amount]"), "12345");
      assert.equal(params.get("payment_intent_data[statement_descriptor_suffix]"), "XBOARD SERVICE");
      assert.equal(new Headers(init.headers).get("idempotency-key"), context.idempotencyKey);
      return Response.json({ id: sessionId, url: "https://checkout.stripe.com/c/pay/local", expires_at: 1_800_000_000 });
    }
    assert.equal(url.pathname, `/v1/checkout/sessions/${sessionId}`);
    return Response.json({
      id: sessionId,
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
