import { now } from "../compat";
import { freshSettings } from "../db";
import type { D1Database } from "../types";

type PlanEnv = {
  XBOARD_DB: D1Database;
};

export type PlanDeps<E extends PlanEnv> = {
  parseJsonArray: (value: unknown) => any[];
  parseJsonObject: (value: unknown) => Record<string, any>;
  pickSetting: (all: Record<string, any>, key: string, fallback?: any) => any;
  orderPeriods: Record<string, string>;
};

export async function planById(env: PlanEnv, id: unknown) {
  if (!id) return null;
  return env.XBOARD_DB.prepare("SELECT id, name FROM v2_plan WHERE id = ?").bind(id).first();
}

export async function adminPlanRows<E extends PlanEnv>(env: E, deps: PlanDeps<E>) {
  const current = now();
  const [planResult, groupResult, countResult] = await Promise.all([
    env.XBOARD_DB.prepare("SELECT * FROM v2_plan ORDER BY sort ASC, id ASC LIMIT 1000").all<Record<string, any>>(),
    env.XBOARD_DB.prepare("SELECT id, name FROM v2_server_group").all<{ id: number; name: string }>(),
    env.XBOARD_DB.prepare(`SELECT plan_id, COUNT(*) AS users_count,
        SUM(CASE WHEN expired_at IS NULL OR expired_at > ? THEN 1 ELSE 0 END) AS active_users_count
        FROM v2_user WHERE plan_id IS NOT NULL GROUP BY plan_id`).bind(current).all<{ plan_id: number; users_count: number; active_users_count: number }>()
  ]);
  const groups = new Map((groupResult.results || []).map(group => [Number(group.id), group]));
  const counts = new Map((countResult.results || []).map(row => [Number(row.plan_id), row]));
  return (planResult.results || []).map((plan): Record<string, any> => {
    const count = counts.get(Number(plan.id));
    return {
      ...plan,
      group: groups.get(Number(plan.group_id)) || null,
      users_count: Number(count?.users_count || 0),
      active_users_count: Number(count?.active_users_count || 0),
      prices: typeof plan.prices === "string" ? (() => { try { return JSON.parse(plan.prices || "{}"); } catch { return {}; } })() : plan.prices,
      tags: deps.parseJsonArray(plan.tags)
    } as Record<string, any>;
  });
}

function requestLanguage(request: Request) {
  const language = (request.headers.get("content-language") || request.headers.get("accept-language") || "").toLowerCase();
  if (language.startsWith("ru")) return "ru";
  if (language.startsWith("zh")) return "zh";
  return "en";
}

export async function publicPlanRows<E extends PlanEnv>(request: Request, env: E, deps: PlanDeps<E>) {
  const all = await freshSettings(env.XBOARD_DB);
  const language = requestLanguage(request);
  const text = {
    en: { unlimited: "No Limit", soldOut: "Sold out", reset: ["First Day of Month", "Monthly", "Never", "First Day of Year", "Yearly"] },
    zh: { unlimited: "无限制", soldOut: "已售罄", reset: ["每月1号", "按月重置", "不重置", "每年1月1日", "按年重置"] },
    ru: { unlimited: "Без ограничений", soldOut: "Распродано", reset: ["Первый день месяца", "Ежемесячно", "Никогда", "Первый день года", "Ежегодно"] }
  }[language];
  return (await adminPlanRows(env, deps)).map(plan => {
    const prices = deps.parseJsonObject(plan.prices);
    const resetMethod = plan.reset_traffic_method === null || plan.reset_traffic_method === undefined
      ? Number(deps.pickSetting(all, "reset_traffic_method", 1))
      : Number(plan.reset_traffic_method);
    const replacements: Record<string, unknown> = {
      "{{transfer}}": plan.transfer_enable,
      "{{speed}}": plan.speed_limit === null || plan.speed_limit === undefined ? text.unlimited : plan.speed_limit,
      "{{devices}}": plan.device_limit === null || plan.device_limit === undefined ? text.unlimited : plan.device_limit,
      "{{reset_method}}": text.reset[resetMethod] || text.reset[1]
    };
    let content = String(plan.content || "");
    for (const [key, value] of Object.entries(replacements)) content = content.replaceAll(key, String(value));
    return {
      id: plan.id, group_id: plan.group_id, name: plan.name, tags: deps.parseJsonArray(plan.tags), content,
      ...Object.fromEntries(Object.entries(deps.orderPeriods).map(([legacy, current]) => {
        const value = prices[current];
        return [legacy, value === null || value === undefined || value === "" ? null : Number(value) * 100];
      })),
      capacity_limit: plan.capacity_limit === null || plan.capacity_limit === undefined
        ? null
        : Number(plan.capacity_limit) <= 0 ? text.soldOut : Number(plan.capacity_limit),
      transfer_enable: plan.transfer_enable, speed_limit: plan.speed_limit, device_limit: plan.device_limit,
      show: Boolean(Number(plan.show)), sell: Boolean(Number(plan.sell)), renew: Boolean(Number(plan.renew)),
      reset_traffic_method: plan.reset_traffic_method, sort: plan.sort, created_at: plan.created_at, updated_at: plan.updated_at
    };
  });
}
