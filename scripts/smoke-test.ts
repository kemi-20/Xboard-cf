const base = process.env.XBOARD_EDGE_URL;
if (!base) {
  console.error("Set XBOARD_EDGE_URL before running smoke tests.");
  process.exit(1);
}

async function expectResponse(name: string, path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, base), init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} failed: ${response.status} ${text.slice(0, 500)}`);
  if (!text.trim()) throw new Error(`${name} returned an empty response`);
  console.log(`${name}: ${response.status}`);
  return { response, text };
}

const health = await expectResponse("health", "/health");
const healthData = JSON.parse(health.text);
if (healthData?.data?.service !== "xboard-edge") throw new Error("health returned an unexpected service name");

const root = await expectResponse("root", "/");
if (root.text.trim() !== "200") throw new Error("root did not return the expected 200 body");

const adminPath = String(process.env.XBOARD_ADMIN_PATH || "admin").replace(/^\/+|\/+$/g, "");
const admin = await expectResponse("admin shell", `/${adminPath}`);
if (!/<!doctype html|<html/i.test(admin.text)) throw new Error("admin shell did not return HTML");

const guestConfig = await expectResponse("guest config", "/api/v1/guest/comm/config");
const guestConfigData = JSON.parse(guestConfig.text);
if (!guestConfigData?.data || typeof guestConfigData.data !== "object") throw new Error("guest config response is incomplete");

const guestPlans = await expectResponse("guest plans", "/api/v1/guest/plan/fetch");
const guestPlanData = JSON.parse(guestPlans.text);
if (!Array.isArray(guestPlanData?.data)) throw new Error("guest plans did not return an array");

const adminEmail = process.env.XBOARD_ADMIN_EMAIL;
const adminPassword = process.env.XBOARD_ADMIN_PASSWORD;
if (adminEmail || adminPassword) {
  if (!adminEmail || !adminPassword) throw new Error("Set both XBOARD_ADMIN_EMAIL and XBOARD_ADMIN_PASSWORD");
  const login = await expectResponse("admin login", `/api/v2/${adminPath}/passport/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  const loginData = JSON.parse(login.text);
  const authorization = String(loginData?.data?.auth_data || "");
  if (!authorization.startsWith("Bearer ")) throw new Error("admin login did not return auth_data");
  const config = await expectResponse("admin config", `/api/v2/${adminPath}/config/fetch`, { headers: { authorization } });
  const configData = JSON.parse(config.text);
  if (!configData?.data?.site || !configData?.data?.server) throw new Error("admin config response is incomplete");
}

const subscribeToken = process.env.XBOARD_SUBSCRIBE_TOKEN;
if (subscribeToken) {
  const subscribePath = String(process.env.XBOARD_SUBSCRIBE_PATH || "s").replace(/^\/+|\/+$/g, "");
  await expectResponse("subscription", `/${subscribePath}/${encodeURIComponent(subscribeToken)}`);
}
