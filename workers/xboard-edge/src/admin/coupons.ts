import { body, fail, json, now, ok, randomString } from "../compat.ts";
import type { D1Database } from "../types.ts";

type CouponEnv = { XBOARD_DB: D1Database };

export type CouponDeps = {
  parseJsonArray: (value: unknown) => any[];
  paginated: <T extends Record<string, any>>(data: T[], total: number, page: number, pageSize: number) => Record<string, any>;
  nullableNumber: (value: unknown) => number | null;
  boolNumber: (value: unknown, fallback?: number) => number;
  canonicalPeriod: (period: string) => string;
  formatDateTime: (value: unknown) => string;
};

function couponValue(input: Record<string, any>, key: string, deps: CouponDeps) {
  return ["limit_plan_ids", "limit_period"].includes(key) ? JSON.stringify(deps.parseJsonArray(input[key])) : input[key];
}

export function normalizeCouponPeriods(value: unknown, deps: Pick<CouponDeps, "parseJsonArray" | "canonicalPeriod">) {
  return deps.parseJsonArray(value).map(item => deps.canonicalPeriod(String(item || "")));
}

export function normalizeCouponResource(row: Record<string, any>, deps: Pick<CouponDeps, "parseJsonArray" | "canonicalPeriod"> & { legacyPeriod: (period: unknown) => string }) {
  const planIds = deps.parseJsonArray(row.limit_plan_ids).map(String);
  const periods = normalizeCouponPeriods(row.limit_period, deps).map(deps.legacyPeriod);
  return { ...row, limit_plan_ids: planIds.length ? planIds : null, limit_period: periods.length ? periods : null };
}

export async function handleAdminCoupon(request: Request, env: CouponEnv, route: string, deps: CouponDeps): Promise<Response | null> {
  if (!route.startsWith("/coupon/")) return null;
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  if (route === "/coupon/fetch") {
    const url = new URL(request.url);
    const current = Math.max(1, Number(input.current || url.searchParams.get("current") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(input.pageSize || url.searchParams.get("pageSize") || 10)));
    const couponFields = new Set(["id", "code", "name", "type", "value", "show", "limit_use", "limit_use_with_user", "started_at", "ended_at", "created_at", "updated_at"]);
    const clauses: string[] = [];
    const binds: any[] = [];
    for (const filter of deps.parseJsonArray(input.filter)) {
      const field = String(filter?.id || "");
      const value = filter?.value;
      if (!couponFields.has(field) || value === undefined || value === null || value === "") continue;
      if (Array.isArray(value) && value.length) {
        clauses.push(`${field} IN (${value.map(() => "?").join(",")})`);
        binds.push(...value);
      } else {
        clauses.push(`${field} LIKE ?`);
        binds.push(`%${String(value)}%`);
      }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sort = deps.parseJsonArray(input.sort)
      .map(item => ({ field: String(item?.id || ""), direction: item?.desc ? "DESC" : "ASC" }))
      .filter(item => couponFields.has(item.field));
    const order = [...sort.map(item => `${item.field} ${item.direction}`), "created_at DESC"].join(", ");
    const [result, totalResult] = await env.XBOARD_DB.batch<Record<string, any>>([
      env.XBOARD_DB.prepare(`SELECT * FROM v2_coupon${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, pageSize, (current - 1) * pageSize),
      env.XBOARD_DB.prepare(`SELECT COUNT(*) AS count FROM v2_coupon${where}`).bind(...binds)
    ]);
    const total = Number((totalResult.results?.[0] as any)?.count || 0);
    return json(deps.paginated((result.results || []).map(row => ({
      ...row,
      type: Math.trunc(Number.parseFloat(String(row.type ?? 0))),
      value: Number(row.value ?? 0),
      show: !!row.show,
      limit_plan_ids: deps.parseJsonArray(row.limit_plan_ids),
      limit_period: normalizeCouponPeriods(row.limit_period, deps)
    })), total, current, pageSize));
  }

  const id = deps.nullableNumber(input.id);
  if (route === "/coupon/generate") {
    const required = ["name", "type", "value", "started_at", "ended_at"];
    if (required.some(key => input[key] === undefined || input[key] === "")) return fail("优惠券参数不完整", 422, 422);
    const couponType = Math.trunc(Number.parseFloat(String(input.type ?? "")));
    if (![1, 2].includes(couponType)) return fail("类型格式有误", 422, 422);
    const existing = id ? await env.XBOARD_DB.prepare("SELECT id, code, show FROM v2_coupon WHERE id = ?").bind(id).first<Record<string, any>>() : null;
    if (id && !existing) return fail("优惠券不存在", 500, 500);
    const count = id ? 1 : Math.min(500, Math.max(1, Number(input.generate_count || 1)));
    const ts = now();
    const generatedCoupons: Array<Record<string, any>> = [];
    const statements = Array.from({ length: count }, (_, index) => {
      const code = count === 1 && input.code ? String(input.code) : id ? String(existing?.code || "") : randomString(8);
      const values = [code, String(input.name), couponType, Number(input.value), deps.boolNumber(input.show, id ? Number(existing?.show || 0) : 0), deps.nullableNumber(input.limit_use), deps.nullableNumber(input.limit_use_with_user), couponValue(input, "limit_plan_ids", deps), couponValue(input, "limit_period", deps), Number(input.started_at), Number(input.ended_at), ts, ts];
      generatedCoupons.push({ ...input, code, type: couponType, created_at: ts });
      if (id && index === 0) return env.XBOARD_DB.prepare("UPDATE v2_coupon SET code=?, name=?, type=?, value=?, show=?, limit_use=?, limit_use_with_user=?, limit_plan_ids=?, limit_period=?, started_at=?, ended_at=?, updated_at=? WHERE id=?").bind(...values.slice(0, 11), ts, id);
      return env.XBOARD_DB.prepare("INSERT INTO v2_coupon(code,name,type,value,show,limit_use,limit_use_with_user,limit_plan_ids,limit_period,started_at,ended_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...values);
    });
    try { await env.XBOARD_DB.batch(statements); } catch { return fail("优惠券代码已存在或参数无效", 400, 400); }
    if (!id && input.generate_count) {
      const csvValue = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const lines = ["名称,类型,金额或比例,开始时间,结束时间,可用次数,可用于订阅,券码,生成时间"];
      for (const coupon of generatedCoupons) {
        lines.push([
          coupon.name,
          coupon.type === 1 ? "金额" : "比例",
          coupon.type === 1 ? Number(coupon.value || 0) / 100 : Number(coupon.value || 0),
          deps.formatDateTime(coupon.started_at),
          deps.formatDateTime(coupon.ended_at),
          coupon.limit_use ?? "不限制",
          deps.parseJsonArray(coupon.limit_plan_ids).join("/") || "不限制",
          coupon.code,
          deps.formatDateTime(coupon.created_at)
        ].map(csvValue).join(","));
      }
      return new Response(`${lines.join("\r\n")}\r\n`, {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="coupons-${ts}.csv"` }
      });
    }
    return ok(true);
  }

  if (!id) return fail("优惠券ID不能为空", 422, 422);
  const exists = await env.XBOARD_DB.prepare("SELECT id, show FROM v2_coupon WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!exists) return fail("优惠券不存在", 400, 400202);
  if (route === "/coupon/drop") { await env.XBOARD_DB.prepare("DELETE FROM v2_coupon WHERE id = ?").bind(id).run(); return ok(true); }
  if (route === "/coupon/show") { await env.XBOARD_DB.prepare("UPDATE v2_coupon SET show = ?, updated_at = ? WHERE id = ?").bind(Number(exists.show) ? 0 : 1, now(), id).run(); return ok(true); }
  if (route === "/coupon/update") { await env.XBOARD_DB.prepare("UPDATE v2_coupon SET show = ?, updated_at = ? WHERE id = ?").bind(deps.boolNumber(input.show, Number(exists.show)), now(), id).run(); return ok(true); }
  return null;
}
