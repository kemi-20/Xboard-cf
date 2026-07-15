import { body, fail, json, now, ok, randomString } from "./compat";
import type { D1Database } from "./types";

type AnyRow = Record<string, any>;

const TYPE_NAMES: Record<number, string> = { 1: "通用礼品卡", 2: "套餐礼品卡", 3: "盲盒礼品卡" };
const STATUS_NAMES: Record<number, string> = { 0: "未使用", 1: "已使用", 2: "已过期", 3: "已禁用" };

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function encodeJson(value: unknown) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function asBoolean(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || value === "1" || value === "true";
}

function maskedEmail(value: unknown) {
  const email = String(value || "");
  return email ? `${email.slice(0, 3)}***@***` : null;
}

function pageInput(input: AnyRow, defaultSize = 15, maxSize = 500) {
  const page = Math.max(1, Number(input.page || 1));
  const perPage = Math.min(maxSize, Math.max(1, Number(input.per_page || input.page_size || defaultSize)));
  return { page, perPage, offset: (page - 1) * perPage };
}

async function requestInput(request: Request) {
  const url = new URL(request.url);
  const query: AnyRow = {};
  url.searchParams.forEach((value, key) => { query[key] = value; });
  if (request.method === "GET") return query;
  return { ...query, ...await body<AnyRow>(request) };
}

function templateRow(row: AnyRow) {
  return {
    ...row,
    type: Number(row.type),
    status: Boolean(Number(row.status)),
    type_name: TYPE_NAMES[Number(row.type)] || "未知类型",
    conditions: parseJson(row.conditions, null),
    rewards: parseJson(row.rewards, {}),
    limits: parseJson(row.limits, null),
    special_config: parseJson(row.special_config, null)
  };
}

function codeAvailable(code: AnyRow) {
  const status = Number(code.status);
  return status !== 2 && status !== 3 && (!code.expires_at || Number(code.expires_at) >= now()) && Number(code.usage_count || 0) < Number(code.max_usage || 1);
}

async function getCard(db: D1Database, codeValue: unknown) {
  const row = await db.prepare(`SELECT c.*, t.name AS template_name, t.description AS template_description,
    t.type AS template_type, t.status AS template_status, t.conditions, t.rewards, t.limits,
    t.special_config, t.icon, t.background_image, t.theme_color
    FROM v2_gift_card_code c JOIN v2_gift_card_template t ON t.id = c.template_id WHERE c.code = ?`)
    .bind(String(codeValue || "")).first<AnyRow>();
  if (!row) throw new Error("兑换码不存在");
  return row;
}

async function userEligibility(db: D1Database, card: AnyRow, user: AnyRow) {
  const rewards = parseJson<AnyRow>(card.rewards, {});
  const conditions = parseJson<AnyRow>(card.conditions, {});
  const limits = parseJson<AnyRow>(card.limits, {});
  const type = Number(card.template_type);
  if (type === 1 && (rewards.transfer_enable !== undefined || rewards.expire_days !== undefined || rewards.reset_package)) {
    if (!user.plan_id) return { can_redeem: false, reason: "您不满足此礼品卡的使用条件" };
  }
  const active = !Number(user.banned) && (user.expired_at === null || Number(user.expired_at) > now()) && user.plan_id !== null;
  if (type === 2 && active) return { can_redeem: false, reason: "您不满足此礼品卡的使用条件" };
  if (conditions.new_user_only && Number(user.created_at) < now() - Number(conditions.new_user_max_days ?? 7) * 86400) {
    return { can_redeem: false, reason: "您不满足此礼品卡的使用条件" };
  }
  if (conditions.paid_user_only) {
    const paid = await db.prepare("SELECT id FROM v2_order WHERE user_id = ? AND status IN ('3', 'completed') LIMIT 1").bind(user.id).first();
    if (!paid) return { can_redeem: false, reason: "您不满足此礼品卡的使用条件" };
  }
  const allowedPlans = Array.isArray(conditions.allowed_plans) ? conditions.allowed_plans.map(Number) : null;
  if (allowedPlans && user.plan_id && !allowedPlans.includes(Number(user.plan_id))) {
    return { can_redeem: false, reason: "您不满足此礼品卡的使用条件" };
  }
  if (conditions.require_invite && !user.invite_user_id) return { can_redeem: false, reason: "您不满足此礼品卡的使用条件" };
  if (limits.max_use_per_user !== undefined) {
    const used = await db.prepare("SELECT COUNT(*) AS c FROM v2_gift_card_usage WHERE template_id = ? AND user_id = ?")
      .bind(card.template_id, user.id).first<{ c: number }>();
    if (Number(used?.c || 0) >= Number(limits.max_use_per_user)) return { can_redeem: false, reason: "您已达到此礼品卡的使用限制" };
  }
  if (limits.cooldown_hours !== undefined) {
    const last = await db.prepare("SELECT created_at FROM v2_gift_card_usage WHERE template_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(card.template_id, user.id).first<{ created_at: number }>();
    if (last && now() < Number(last.created_at) + Number(limits.cooldown_hours) * 3600) return { can_redeem: false, reason: "您已达到此礼品卡的使用限制" };
  }
  return { can_redeem: true, reason: null };
}

function weightedRewards(base: AnyRow) {
  const options = Array.isArray(base.random_rewards) ? base.random_rewards : [];
  const total = options.reduce((sum, item) => sum + Math.max(0, Number(item.weight || 0)), 0);
  if (!total) return { ...base };
  let random = Math.floor(Math.random() * total) + 1;
  for (const option of options) {
    random -= Math.max(0, Number(option.weight || 0));
    if (random <= 0) {
      const result = { ...base, ...option };
      delete result.weight;
      return result;
    }
  }
  return { ...base };
}

function actualRewards(card: AnyRow) {
  let rewards = parseJson<AnyRow>(card.rewards, {});
  if (Number(card.template_type) === 3 && Array.isArray(rewards.random_rewards)) rewards = weightedRewards(rewards);
  const special = parseJson<AnyRow>(card.special_config, {});
  const activeBonus = special.festival_bonus !== undefined && special.start_time !== undefined && special.end_time !== undefined
    && now() >= Number(special.start_time) && now() <= Number(special.end_time);
  if (activeBonus && Number(special.festival_bonus) > 1) {
    const scalable = new Set(["balance", "transfer_enable", "expire_days", "plan_validity_days", "device_limit"]);
    rewards = Object.fromEntries(Object.entries(rewards).map(([key, value]) => [key,
      scalable.has(key) && typeof value === "number" ? Math.trunc(value * Number(special.festival_bonus)) : value]));
  }
  return rewards;
}

const SHANGHAI_OFFSET = 8 * 3600;

function shanghaiParts(ts: number) {
  const date = new Date((ts + SHANGHAI_OFFSET) * 1000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}

function shanghaiTimestamp(year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
  return Math.floor(Date.UTC(year, month, day, hour, minute, second) / 1000) - SHANGHAI_OFFSET;
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function calculateNextReset(expiredAt: unknown, method: number, from: number) {
  if (expiredAt === null || expiredAt === undefined || Number(expiredAt) <= 0 || method === 2) return null;
  const current = shanghaiParts(from);
  const expiry = shanghaiParts(Number(expiredAt));
  if (method === 0) return shanghaiTimestamp(current.year + (current.month === 11 ? 1 : 0), (current.month + 1) % 12, 1);
  if (method === 1) {
    const candidate = shanghaiTimestamp(current.year, current.month, Math.min(expiry.day, daysInMonth(current.year, current.month)), expiry.hour, expiry.minute, expiry.second);
    if (candidate > from) return candidate;
    const year = current.year + (current.month === 11 ? 1 : 0), month = (current.month + 1) % 12;
    return shanghaiTimestamp(year, month, Math.min(expiry.day, daysInMonth(year, month)), expiry.hour, expiry.minute, expiry.second);
  }
  if (method === 3) return shanghaiTimestamp(current.year + 1, 0, 1);
  if (method === 4) {
    const candidate = shanghaiTimestamp(current.year, expiry.month, Math.min(expiry.day, daysInMonth(current.year, expiry.month)), expiry.hour, expiry.minute, expiry.second);
    if (candidate > from) return candidate;
    return shanghaiTimestamp(current.year + 1, expiry.month, Math.min(expiry.day, daysInMonth(current.year + 1, expiry.month)), expiry.hour, expiry.minute, expiry.second);
  }
  return null;
}

function festivalMultiplier(card: AnyRow) {
  const special = parseJson<AnyRow>(card.special_config, {});
  return special.start_time !== undefined && special.end_time !== undefined && now() >= Number(special.start_time) && now() <= Number(special.end_time)
    ? Number(special.festival_bonus || 1) : 1;
}

async function planInfo(db: D1Database, planId: unknown) {
  if (!planId) return null;
  const plan = await db.prepare("SELECT * FROM v2_plan WHERE id = ?").bind(planId).first<AnyRow>();
  if (!plan) return null;
  return { ...plan, prices: parseJson(plan.prices, {}), tags: parseJson(plan.tags, []) };
}

async function redeem(db: D1Database, card: AnyRow, user: AnyRow, request: Request) {
  const rewards = actualRewards(card);
  const ts = now();
  const assignments: string[] = [];
  const updateValues: unknown[] = [];
  if (Number(rewards.balance || 0) > 0) { assignments.push("balance = COALESCE(balance, 0) + ?"); updateValues.push(Number(rewards.balance)); }
  if (Number(rewards.transfer_enable || 0) > 0) {
    assignments.push("transfer_enable = COALESCE(transfer_enable, 0) + ?");
    updateValues.push(Number(rewards.transfer_enable) * 1073741824);
  }
  if (Number(rewards.device_limit || 0) > 0) { assignments.push("device_limit = COALESCE(device_limit, 0) + ?"); updateValues.push(Number(rewards.device_limit)); }
  let resetMethod: number | null = null;
  let nextReset: number | null = null;
  if (rewards.reset_package && user.plan_id) {
    const plan = await db.prepare("SELECT reset_traffic_method FROM v2_plan WHERE id = ?").bind(user.plan_id).first<AnyRow>();
    const setting = await db.prepare("SELECT value FROM v2_settings WHERE name = 'reset_traffic_method'").first<{ value: string }>();
    resetMethod = plan?.reset_traffic_method === null || plan?.reset_traffic_method === undefined ? Number(setting?.value ?? 1) : Number(plan.reset_traffic_method);
    nextReset = calculateNextReset(user.expired_at, resetMethod, ts + 1);
    assignments.push("u = 0", "d = 0", "reset_count = COALESCE(reset_count, 0) + 1", "last_reset_at = ?", "next_reset_at = ?");
    updateValues.push(ts, nextReset);
  }
  if (rewards.plan_id !== undefined) {
    const plan = await db.prepare("SELECT * FROM v2_plan WHERE id = ?").bind(rewards.plan_id).first<AnyRow>();
    if (plan) {
      assignments.push("plan_id = ?", "group_id = ?", "transfer_enable = ?", "speed_limit = ?", "device_limit = ?");
      updateValues.push(plan.id, plan.group_id, Number(plan.transfer_enable || 0) * 1073741824, plan.speed_limit, plan.device_limit);
      if (Number(rewards.plan_validity_days || 0) > 0) { assignments.push("expired_at = ?"); updateValues.push(Math.max(Number(user.expired_at || ts), ts) + Number(rewards.plan_validity_days) * 86400); }
    }
  } else if (Number(rewards.expire_days || 0) > 0) {
    assignments.push("expired_at = ?");
    updateValues.push(Math.max(Number(user.expired_at || ts), ts) + Number(rewards.expire_days) * 86400);
  }

  let inviteRewards: AnyRow | null = null;
  if (user.invite_user_id && rewards.invite_reward_rate !== undefined) {
    const inviter = await db.prepare("SELECT * FROM v2_user WHERE id = ?").bind(user.invite_user_id).first<AnyRow>();
    if (inviter) {
      const rate = Number(rewards.invite_reward_rate ?? 0.2);
      inviteRewards = {};
      const balance = Math.trunc(Number(rewards.balance || 0) * rate);
      const transfer = Math.trunc(Number(rewards.transfer_enable || 0) * rate);
      if (balance > 0) inviteRewards.balance = balance;
      if (transfer > 0) inviteRewards.transfer_enable = transfer;
      if (!Object.keys(inviteRewards).length) inviteRewards = null;
    }
  }

  const plan = user.plan_id ? await db.prepare("SELECT sort FROM v2_plan WHERE id = ?").bind(user.plan_id).first<{ sort: number }>() : null;
  const nonce = randomString(32);
  const guard = "EXISTS (SELECT 1 FROM v2_gift_card_code WHERE id = ? AND redemption_nonce = ?)";
  const statements = [db.prepare(`UPDATE v2_gift_card_code SET status = CASE WHEN usage_count + 1 >= max_usage THEN 1 ELSE 0 END,
    user_id = ?, used_at = ?, usage_count = usage_count + 1, actual_rewards = ?, redemption_nonce = ?, updated_at = ?
    WHERE id = ? AND status NOT IN (2, 3) AND usage_count < max_usage AND (expires_at IS NULL OR expires_at >= ?)`)
    .bind(user.id, ts, Number(card.template_type) === 3 ? encodeJson(rewards) : card.actual_rewards, nonce, ts, card.id, ts)];
  if (assignments.length) statements.push(db.prepare(`UPDATE v2_user SET ${assignments.join(", ")}, updated_at = ? WHERE id = ? AND ${guard}`)
    .bind(...updateValues, ts, user.id, card.id, nonce));
  if (inviteRewards && user.invite_user_id) statements.push(db.prepare(`UPDATE v2_user SET balance = COALESCE(balance, 0) + ?,
    transfer_enable = COALESCE(transfer_enable, 0) + ?, updated_at = ? WHERE id = ? AND ${guard}`)
    .bind(Number(inviteRewards.balance || 0), Number(inviteRewards.transfer_enable || 0) * 1073741824, ts, user.invite_user_id, card.id, nonce));
  if (rewards.reset_package && user.plan_id) {
    const resetTypes: Record<number, string> = { 0: "first_day_month", 1: "monthly", 3: "first_day_year", 4: "yearly" };
    statements.push(db.prepare(`INSERT INTO v2_traffic_reset_logs(user_id, reset_type, old_u, old_d, old_upload, old_download,
      old_total, new_upload, new_download, new_total, trigger_source, metadata, reset_time, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'gift_card', ?, ?, ? WHERE ${guard}`)
      .bind(user.id, resetTypes[Number(resetMethod)] || "manual", Number(user.u || 0), Number(user.d || 0), Number(user.u || 0),
        Number(user.d || 0), Number(user.u || 0) + Number(user.d || 0), JSON.stringify({ trigger_source: "gift_card", next_reset_at: nextReset }), ts, ts, card.id, nonce));
  }
  statements.push(db.prepare(`INSERT INTO v2_gift_card_usage(code_id, template_id, user_id, invite_user_id, rewards_given, invite_rewards,
    user_level_at_use, plan_id_at_use, multiplier_applied, ip_address, user_agent, notes, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ? WHERE ${guard}`)
    .bind(card.id, card.template_id, user.id, user.invite_user_id, encodeJson(rewards), encodeJson(inviteRewards), plan?.sort ?? null,
      user.plan_id, festivalMultiplier(card), request.headers.get("cf-connecting-ip"), request.headers.get("user-agent"), ts, ts, card.id, nonce));
  const results = await db.batch(statements);
  if (Number((results[0]?.meta as any)?.changes || 0) !== 1) throw new Error("兑换码已被使用或已失效");
  return { rewards, invite_rewards: inviteRewards, template_name: card.template_name };
}

async function adminTemplates(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const { page, perPage, offset } = pageInput(input, 15, 1000);
  const where: string[] = [];
  const values: unknown[] = [];
  if (input.type !== undefined && input.type !== "") { where.push("t.type = ?"); values.push(Number(input.type)); }
  if (input.status !== undefined && input.status !== "") { where.push("t.status = ?"); values.push(Number(input.status)); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const result = await db.prepare(`SELECT t.*,
    (SELECT COUNT(*) FROM v2_gift_card_code c WHERE c.template_id = t.id) AS codes_count,
    (SELECT COUNT(*) FROM v2_gift_card_usage u WHERE u.template_id = t.id) AS used_count
    FROM v2_gift_card_template t ${clause} ORDER BY t.sort ASC, t.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...values, perPage, offset).all<AnyRow>();
  const total = await db.prepare(`SELECT COUNT(*) AS c FROM v2_gift_card_template t ${clause}`).bind(...values).first<{ c: number }>();
  return json({ data: (result.results || []).map(templateRow), total: Number(total?.c || 0), current_page: page, per_page: perPage });
}

async function createTemplate(request: Request, db: D1Database, adminId: number) {
  const input = await requestInput(request);
  if (!String(input.name || "").trim()) return fail("礼品卡名称不能为空", 422, 422);
  if (![1, 2, 3].includes(Number(input.type))) return fail("无效的礼品卡类型", 422, 422);
  if (!input.rewards || typeof input.rewards !== "object") return fail("奖励配置不能为空", 422, 422);
  if (input.theme_color && !/^#[0-9A-Fa-f]{6}$/.test(String(input.theme_color))) return fail("主题色格式不正确", 422, 422);
  if (input.background_image && (String(input.background_image).length > 255 || !/^https?:\/\//i.test(String(input.background_image)))) return fail("背景图片地址格式不正确", 422, 422);
  if (input.icon && String(input.icon).length > 255) return fail("图标长度不能超过255个字符", 422, 422);
  const ts = now();
  const result = await db.prepare(`INSERT INTO v2_gift_card_template(name, description, type, status, conditions, rewards, limits,
    special_config, icon, background_image, theme_color, sort, admin_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(String(input.name), input.description ?? null, Number(input.type), asBoolean(input.status, true) ? 1 : 0,
      encodeJson(input.conditions), encodeJson(input.rewards), encodeJson(input.limits), encodeJson(input.special_config), input.icon ?? null,
      input.background_image ?? null, String(input.theme_color || "#1890ff"), Number(input.sort || 0), adminId, ts, ts).run();
  const id = Number((result.meta as any)?.last_row_id || 0);
  return ok(templateRow(await db.prepare("SELECT * FROM v2_gift_card_template WHERE id = ?").bind(id).first<AnyRow>() || {}));
}

async function updateTemplate(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const id = Number(input.id);
  const existing = await db.prepare("SELECT * FROM v2_gift_card_template WHERE id = ?").bind(id).first<AnyRow>();
  if (!existing) return fail("模板不存在", 404, 404);
  if (input.type !== undefined && ![1, 2, 3].includes(Number(input.type))) return fail("无效的礼品卡类型", 422, 422);
  if (input.theme_color && !/^#[0-9A-Fa-f]{6}$/.test(String(input.theme_color))) return fail("主题色格式不正确", 422, 422);
  if (input.background_image && (String(input.background_image).length > 255 || !/^https?:\/\//i.test(String(input.background_image)))) return fail("背景图片地址格式不正确", 422, 422);
  if (input.icon && String(input.icon).length > 255) return fail("图标长度不能超过255个字符", 422, 422);
  const allowed = ["name", "description", "type", "status", "conditions", "rewards", "limits", "special_config", "icon", "background_image", "theme_color", "sort"];
  const entries = allowed.filter(key => input[key] !== undefined).map(key => [key, ["conditions", "rewards", "limits", "special_config"].includes(key) ? encodeJson(input[key]) : key === "status" ? (asBoolean(input[key]) ? 1 : 0) : input[key]] as const);
  if (entries.length) await db.prepare(`UPDATE v2_gift_card_template SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...entries.map(([, value]) => value), now(), id).run();
  return ok(templateRow(await db.prepare("SELECT * FROM v2_gift_card_template WHERE id = ?").bind(id).first<AnyRow>() || existing));
}

async function deleteTemplate(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const id = Number(input.id);
  if (!await db.prepare("SELECT id FROM v2_gift_card_template WHERE id = ?").bind(id).first()) return fail("模板不存在", 404, 404);
  if (await db.prepare("SELECT id FROM v2_gift_card_code WHERE template_id = ? LIMIT 1").bind(id).first()) return fail("该模板下存在兑换码，无法删除", 400, 400);
  await db.prepare("DELETE FROM v2_gift_card_template WHERE id = ?").bind(id).run();
  return ok(true);
}

function generatedCode(prefix: string) {
  return `${prefix}${randomString(12).toUpperCase()}`.slice(0, 32);
}

async function generateCodes(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const templateId = Number(input.template_id);
  const count = Number(input.count);
  const template = await db.prepare("SELECT * FROM v2_gift_card_template WHERE id = ?").bind(templateId).first<AnyRow>();
  if (!template) return fail("请选择礼品卡模板", 422, 422);
  if (!Number(template.status)) return fail("模板已被禁用", 400, 400);
  if (!Number.isInteger(count) || count < 1 || count > 10000) return fail("单次最多生成10000个兑换码", 422, 422);
  const prefix = String(input.prefix ?? "GC").toUpperCase();
  if (!/^[A-Z0-9]{0,10}$/.test(prefix)) return fail("前缀只能包含大写字母和数字", 422, 422);
  const batchId = `batch_${randomString(13)}`;
  const expiresAt = input.expires_hours ? now() + Number(input.expires_hours) * 3600 : null;
  const maxUsage = Math.min(1000, Math.max(1, Number(input.max_usage || 1)));
  const codes = new Set<string>();
  while (codes.size < count) {
    while (codes.size < count) codes.add(generatedCode(prefix));
    const candidates = [...codes];
    for (let start = 0; start < candidates.length; start += 100) {
      const chunk = candidates.slice(start, start + 100);
      const found = await db.prepare(`SELECT code FROM v2_gift_card_code WHERE code IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ code: string }>();
      for (const row of found.results || []) codes.delete(row.code);
    }
  }
  const values = [...codes];
  for (let start = 0; start < values.length; start += 50) {
    const chunk = values.slice(start, start + 50);
    const statements = chunk.map(code => db.prepare("INSERT INTO v2_gift_card_code(template_id, code, batch_id, status, expires_at, usage_count, max_usage, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)")
      .bind(templateId, code, batchId, expiresAt, maxUsage, now(), now()));
    await db.batch(statements);
  }
  if (asBoolean(input.download_csv)) {
    const lines = ["兑换码,前缀,有效期,最大使用次数,批次号,模板名称", ...values.map(code => [code, prefix, expiresAt || "长期有效", maxUsage, batchId, String(template.name).replaceAll('"', '""')].map(value => `"${value}"`).join(","))];
    return new Response(lines.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=\"gift_codes.csv\"" } });
  }
  return ok({ batch_id: batchId, count, message: "生成成功" });
}

async function adminCodes(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const { page, perPage, offset } = pageInput(input);
  const where: string[] = [];
  const values: unknown[] = [];
  for (const key of ["template_id", "batch_id", "status"]) {
    if (input[key] !== undefined && input[key] !== "") { where.push(`c.${key} = ?`); values.push(input[key]); }
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const result = await db.prepare(`SELECT c.*, t.name AS template_name, u.email AS user_email FROM v2_gift_card_code c
    LEFT JOIN v2_gift_card_template t ON t.id = c.template_id LEFT JOIN v2_user u ON u.id = c.user_id
    ${clause} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).bind(...values, perPage, offset).all<AnyRow>();
  const total = await db.prepare(`SELECT COUNT(*) AS c FROM v2_gift_card_code c ${clause}`).bind(...values).first<{ c: number }>();
  return json({ data: (result.results || []).map(row => ({ ...row, status: Number(row.status), status_name: STATUS_NAMES[Number(row.status)] || "未知状态", user_email: maskedEmail(row.user_email), actual_rewards: parseJson(row.actual_rewards, null), metadata: parseJson(row.metadata, null) })), total: Number(total?.c || 0), current_page: page, per_page: perPage });
}

async function toggleCode(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const code = await db.prepare("SELECT * FROM v2_gift_card_code WHERE id = ?").bind(input.id).first<AnyRow>();
  if (!code) return fail("兑换码不存在", 404, 404);
  const disable = input.action === "disable";
  if (!disable && input.action !== "enable") return fail("操作失败", 422, 422);
  await db.prepare("UPDATE v2_gift_card_code SET status = ?, updated_at = ? WHERE id = ?").bind(disable ? 3 : Number(code.status) === 3 ? 0 : Number(code.status), now(), code.id).run();
  return ok({ message: disable ? "已禁用" : "已启用" });
}

async function exportCodes(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const result = await db.prepare("SELECT code FROM v2_gift_card_code WHERE batch_id = ? ORDER BY created_at ASC").bind(input.batch_id).all<{ code: string }>();
  if (!(result.results || []).length) return fail("批次不存在", 422, 422);
  return new Response((result.results || []).map(row => row.code).join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="gift_cards_${String(input.batch_id)}.txt"` } });
}

async function adminUsages(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const { page, perPage, offset } = pageInput(input);
  const where: string[] = [];
  const values: unknown[] = [];
  for (const key of ["template_id", "user_id"]) if (input[key] !== undefined && input[key] !== "") { where.push(`g.${key} = ?`); values.push(input[key]); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const result = await db.prepare(`SELECT g.*, c.code, t.name AS template_name, u.email AS user_email, i.email AS invite_user_email
    FROM v2_gift_card_usage g LEFT JOIN v2_gift_card_code c ON c.id = g.code_id
    LEFT JOIN v2_gift_card_template t ON t.id = g.template_id LEFT JOIN v2_user u ON u.id = g.user_id
    LEFT JOIN v2_user i ON i.id = g.invite_user_id ${clause} ORDER BY g.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...values, perPage, offset).all<AnyRow>();
  const total = await db.prepare(`SELECT COUNT(*) AS c FROM v2_gift_card_usage g ${clause}`).bind(...values).first<{ c: number }>();
  return json({ data: (result.results || []).map(row => ({ ...row, invite_user_email: maskedEmail(row.invite_user_email), rewards_given: parseJson(row.rewards_given, {}), invite_rewards: parseJson(row.invite_rewards, null) })), total: Number(total?.c || 0), current_page: page, per_page: perPage });
}

async function statistics(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const end = String(input.end_date || new Date().toISOString().slice(0, 10));
  const start = String(input.start_date || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const counts = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM v2_gift_card_template) AS templates_count,
    (SELECT COUNT(*) FROM v2_gift_card_template WHERE status = 1) AS active_templates_count,
    (SELECT COUNT(*) FROM v2_gift_card_code) AS codes_count,
    (SELECT COUNT(*) FROM v2_gift_card_code WHERE status = 1) AS used_codes_count,
    (SELECT COUNT(*) FROM v2_gift_card_usage) AS usages_count`).first<AnyRow>();
  const daily = await db.prepare("SELECT date(created_at, 'unixepoch') AS date, COUNT(*) AS count FROM v2_gift_card_usage WHERE date(created_at, 'unixepoch') BETWEEN ? AND ? GROUP BY date ORDER BY date")
    .bind(start, end).all();
  const types = await db.prepare("SELECT t.name AS template_name, t.type, COUNT(*) AS count FROM v2_gift_card_usage u JOIN v2_gift_card_template t ON t.id = u.template_id GROUP BY u.template_id").all<AnyRow>();
  return ok({ total_stats: counts || {}, daily_usages: daily.results || [], type_stats: (types.results || []).map(row => ({ template_name: row.template_name, type_name: TYPE_NAMES[Number(row.type)] || "未知类型", count: Number(row.count || 0) })) });
}

async function updateCode(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const code = await db.prepare("SELECT * FROM v2_gift_card_code WHERE id = ?").bind(input.id).first<AnyRow>();
  if (!code) return fail("礼品卡不存在", 404, 404);
  if (input.max_usage !== undefined && (!Number.isInteger(Number(input.max_usage)) || Number(input.max_usage) < 1 || Number(input.max_usage) > 1000)) return fail("最大使用次数必须在1到1000之间", 422, 422);
  if (input.status !== undefined && ![0, 1, 2, 3].includes(Number(input.status))) return fail("无效的礼品卡状态", 422, 422);
  const entries = ["expires_at", "max_usage", "status"].filter(key => input[key] !== undefined).map(key => [key, input[key]] as const);
  if (entries.length) await db.prepare(`UPDATE v2_gift_card_code SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).bind(...entries.map(([, value]) => value), now(), code.id).run();
  const fresh = await db.prepare("SELECT * FROM v2_gift_card_code WHERE id = ?").bind(code.id).first<AnyRow>();
  return ok({ ...fresh, actual_rewards: parseJson(fresh?.actual_rewards, null), metadata: parseJson(fresh?.metadata, null) });
}

async function deleteCode(request: Request, db: D1Database) {
  const input = await requestInput(request);
  const code = await db.prepare("SELECT * FROM v2_gift_card_code WHERE id = ?").bind(input.id).first<AnyRow>();
  if (!code) return fail("礼品卡不存在", 404, 404);
  if (Number(code.status) === 1) return fail("该礼品卡已被使用，无法删除", 400, 400);
  if (await db.prepare("SELECT id FROM v2_gift_card_usage WHERE code_id = ? LIMIT 1").bind(code.id).first()) return fail("该礼品卡存在使用记录，无法删除", 400, 400);
  await db.prepare("DELETE FROM v2_gift_card_code WHERE id = ?").bind(code.id).run();
  return ok({ message: "删除成功" });
}

export async function handleAdminGiftCard(request: Request, db: D1Database, route: string, adminId: number) {
  if (route === "/gift-card/templates") return adminTemplates(request, db);
  if (route === "/gift-card/create-template") return createTemplate(request, db, adminId);
  if (route === "/gift-card/update-template") return updateTemplate(request, db);
  if (route === "/gift-card/delete-template") return deleteTemplate(request, db);
  if (route === "/gift-card/generate-codes") return generateCodes(request, db);
  if (route === "/gift-card/codes") return adminCodes(request, db);
  if (route === "/gift-card/toggle-code") return toggleCode(request, db);
  if (route === "/gift-card/export-codes") return exportCodes(request, db);
  if (route === "/gift-card/usages") return adminUsages(request, db);
  if (route === "/gift-card/statistics") return statistics(request, db);
  if (route === "/gift-card/types") return ok(TYPE_NAMES);
  if (route === "/gift-card/update-code") return updateCode(request, db);
  if (route === "/gift-card/delete-code") return deleteCode(request, db);
  return null;
}

export async function handleUserGiftCard(request: Request, db: D1Database, route: string, user: AnyRow) {
  if (route === "/gift-card/types" && request.method === "GET") return ok({ types: TYPE_NAMES });
  if (route === "/gift-card/check" && request.method === "POST") {
    const input = await requestInput(request);
    try {
      const card = await getCard(db, input.code);
      if (!Number(card.template_status)) return fail("该礼品卡类型已停用", 400, 400);
      if (!codeAvailable(card)) return fail(`兑换码不可用：${STATUS_NAMES[Number(card.status)] || "未知状态"}`, 400, 400);
      const eligibility = await userEligibility(db, card, user);
      const rewards = actualRewards(card);
      return ok({
        code_info: {
          code: card.code,
          template: { name: card.template_name, description: card.template_description, type: Number(card.template_type), type_name: TYPE_NAMES[Number(card.template_type)] || "未知类型", icon: card.icon, background_image: card.background_image, theme_color: card.theme_color },
          status: Number(card.status), status_name: STATUS_NAMES[Number(card.status)] || "未知状态", expires_at: card.expires_at,
          usage_count: Number(card.usage_count || 0), max_usage: Number(card.max_usage || 1),
          ...(Number(card.template_type) === 2 ? { plan_info: await planInfo(db, rewards.plan_id) } : {})
        },
        reward_preview: rewards,
        ...eligibility
      });
    } catch (error: any) {
      if (error?.message === "兑换码不存在") return fail("兑换码不存在", 400, 400);
      console.error("gift card check failed", error);
      return fail("查询失败，请稍后重试", 500, 500);
    }
  }
  if (route === "/gift-card/redeem" && request.method === "POST") {
    const input = await requestInput(request);
    const code = String(input.code || "");
    if (code.length < 8) return fail("兑换码长度不能少于8位", 422, 422);
    if (code.length > 32) return fail("兑换码长度不能超过32位", 422, 422);
    try {
      const card = await getCard(db, code);
      if (!Number(card.template_status)) return fail("该礼品卡类型已停用", 400, 400);
      if (!codeAvailable(card)) return fail(`兑换码不可用：${STATUS_NAMES[Number(card.status)] || "未知状态"}`, 400, 400);
      const eligibility = await userEligibility(db, card, user);
      if (!eligibility.can_redeem) return fail(String(eligibility.reason), 400, 400);
      const result = await redeem(db, card, user, request);
      return ok({ message: "兑换成功！", ...result });
    } catch (error: any) {
      if (["兑换码不存在", "兑换码已被使用或已失效"].includes(String(error?.message || ""))) return fail(String(error.message), 400, 400);
      console.error("gift card redeem failed", error);
      return fail("兑换失败，请稍后重试", 500, 500);
    }
  }
  if (route === "/gift-card/history" && request.method === "GET") {
    const input = await requestInput(request);
    const { page, perPage, offset } = pageInput(input, 15, 100);
    const result = await db.prepare(`SELECT g.*, c.code, t.name AS template_name, t.type AS template_type
      FROM v2_gift_card_usage g LEFT JOIN v2_gift_card_code c ON c.id = g.code_id
      LEFT JOIN v2_gift_card_template t ON t.id = g.template_id WHERE g.user_id = ? ORDER BY g.created_at DESC LIMIT ? OFFSET ?`)
      .bind(user.id, perPage, offset).all<AnyRow>();
    const total = await db.prepare("SELECT COUNT(*) AS c FROM v2_gift_card_usage WHERE user_id = ?").bind(user.id).first<{ c: number }>();
    const count = Number(total?.c || 0);
    return json({ data: (result.results || []).map(row => ({ id: row.id, code: row.code ? `${String(row.code).slice(0, 8)}****` : "", template_name: row.template_name || "", template_type: row.template_type || "", template_type_name: TYPE_NAMES[Number(row.template_type)] || "", rewards_given: parseJson(row.rewards_given, {}), invite_rewards: parseJson(row.invite_rewards, null), multiplier_applied: Number(row.multiplier_applied || 1), created_at: row.created_at })), pagination: { current_page: page, last_page: Math.max(1, Math.ceil(count / perPage)), per_page: perPage, total: count } });
  }
  if (route === "/gift-card/detail" && request.method === "GET") {
    const input = await requestInput(request);
    const row = await db.prepare(`SELECT g.*, c.code, t.name AS template_name, t.description AS template_description, t.type AS template_type,
      t.icon, t.theme_color, i.email AS invite_email FROM v2_gift_card_usage g
      LEFT JOIN v2_gift_card_code c ON c.id = g.code_id LEFT JOIN v2_gift_card_template t ON t.id = g.template_id
      LEFT JOIN v2_user i ON i.id = g.invite_user_id WHERE g.id = ? AND g.user_id = ?`).bind(input.id, user.id).first<AnyRow>();
    if (!row) return fail("记录不存在", 404, 404);
    return ok({ id: row.id, code: row.code || "", template: { name: row.template_name || "", description: row.template_description || "", type: row.template_type || "", type_name: TYPE_NAMES[Number(row.template_type)] || "", icon: row.icon || "", theme_color: row.theme_color || "" }, rewards_given: parseJson(row.rewards_given, {}), invite_rewards: parseJson(row.invite_rewards, null), invite_user: row.invite_user_id ? { id: row.invite_user_id, email: maskedEmail(row.invite_email) || "" } : null, user_level_at_use: row.user_level_at_use, plan_id_at_use: row.plan_id_at_use, multiplier_applied: Number(row.multiplier_applied || 1), notes: row.notes, created_at: row.created_at });
  }
  return null;
}
