import { body, now } from "../compat";
import type { D1Database } from "../types";

type UserEnv = { XBOARD_DB: D1Database };

export type UserListDeps<E extends UserEnv> = {
  parseJsonArray: (value: unknown) => any[];
  parseJsonObject: (value: unknown) => Record<string, any>;
  safeUser: (row: Record<string, any>) => Record<string, any>;
  paginated: <T extends Record<string, any>>(data: T[], total: number, page: number, pageSize: number) => Record<string, any>;
  subscribeUrl: (request: Request, env: E, token: string) => Promise<string>;
  liveDeviceSnapshot: (env: E) => Promise<Record<string, string[]> | null>;
};

const adminUserFields: Record<string, string> = {
  id: "u.id", email: "u.email", plan_id: "u.plan_id", group_id: "u.group_id", banned: "u.banned", is_admin: "u.is_admin",
  is_staff: "u.is_staff", balance: "u.balance", commission_balance: "u.commission_balance", transfer_enable: "u.transfer_enable",
  u: "u.u", d: "u.d", total_used: "(COALESCE(u.u, 0) + COALESCE(u.d, 0))", created_at: "u.created_at", updated_at: "u.updated_at",
  expired_at: "u.expired_at", plan_name: "p.name", "plan.name": "p.name", group_name: "g.name", "group.name": "g.name",
  "invite_user.email": "iu.email", invite_user_id: "u.invite_user_id", group_ids: "u.group_id"
};

export function adminUserQuery(input: Record<string, any>, parseJsonArray: (value: unknown) => any[]) {
  const clauses: Array<{ sql: string; logic: "AND" | "OR" }> = [];
  const bindings: any[] = [];
  for (const filter of parseJsonArray(input.filter)) {
    const field = adminUserFields[String(filter?.id || "")];
    const value = filter?.value;
    if (!field || value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      clauses.push({ sql: `${field} IN (${value.map(() => "?").join(",")})`, logic: String(filter?.logic || "and").toLowerCase() === "or" ? "OR" : "AND" });
      bindings.push(...value);
      continue;
    }
    const nullOperator = String(value).toLowerCase();
    if (nullOperator === "null" || nullOperator === "notnull") {
      clauses.push({ sql: `${field} IS ${nullOperator === "notnull" ? "NOT " : ""}NULL`, logic: String(filter?.logic || "and").toLowerCase() === "or" ? "OR" : "AND" });
      continue;
    }
    const match = String(value).match(/^(eq|neq|gt|gte|lt|lte):(.*)$/s);
    if (match) {
      const operators: Record<string, string> = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
      clauses.push({ sql: `${field} ${operators[match[1]]} ?`, logic: String(filter?.logic || "and").toLowerCase() === "or" ? "OR" : "AND" });
      bindings.push(match[2]);
    } else {
      clauses.push({ sql: `${field} LIKE ?`, logic: String(filter?.logic || "and").toLowerCase() === "or" ? "OR" : "AND" });
      bindings.push(`%${String(value)}%`);
    }
  }
  const sort = parseJsonArray(input.sort)
    .map(item => ({ field: adminUserFields[String(item?.id || "")], direction: item?.desc ? "DESC" : "ASC" }))
    .filter(item => item.field);
  return {
    where: clauses.length ? ` WHERE ${clauses.map((clause, index) => `${index ? clause.logic : ""} (${clause.sql})`).join(" ")}` : "",
    bindings,
    order: [...sort.map(item => `${item.field} ${item.direction}`), "u.id DESC"].join(", ")
  };
}

export async function adminUserList<E extends UserEnv>(env: E, request: Request, deps: UserListDeps<E>) {
  const input = request.method === "POST" ? await body<Record<string, any>>(request.clone()) : {};
  const url = new URL(request.url);
  const page = Math.max(1, Number(input.page || input.current || url.searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(input.page_size || input.pageSize || input.limit || url.searchParams.get("page_size") || 20)));
  const query = adminUserQuery(input, deps.parseJsonArray);
  const [usersResult, countResult] = await Promise.all([
    env.XBOARD_DB.prepare(`SELECT u.* FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id LEFT JOIN v2_server_group g ON g.id = u.group_id LEFT JOIN v2_user iu ON iu.id = u.invite_user_id${query.where} ORDER BY ${query.order} LIMIT ? OFFSET ?`)
      .bind(...query.bindings, pageSize, (page - 1) * pageSize).all<Record<string, any>>(),
    env.XBOARD_DB.prepare(`SELECT COUNT(*) AS count FROM v2_user u LEFT JOIN v2_plan p ON p.id = u.plan_id LEFT JOIN v2_server_group g ON g.id = u.group_id LEFT JOIN v2_user iu ON iu.id = u.invite_user_id${query.where}`)
      .bind(...query.bindings).first<{ count: number }>()
  ]);
  const userRows = usersResult.results || [];
  const liveDevices = await deps.liveDeviceSnapshot(env);
  const inviterIds = [...new Set(userRows.map(row => Number(row.invite_user_id || 0)).filter(Boolean))];
  const planIds = [...new Set(userRows.map(row => Number(row.plan_id || 0)).filter(Boolean))];
  const groupIds = [...new Set(userRows.map(row => Number(row.group_id || 0)).filter(Boolean))];
  const inviters = new Map<number, { id: number; email: string }>();
  const [inviterRows, planRows, groupRows] = await Promise.all([
    inviterIds.length ? env.XBOARD_DB.prepare(`SELECT id, email FROM v2_user WHERE id IN (${inviterIds.map(() => "?").join(",")})`).bind(...inviterIds).all<any>() : Promise.resolve({ results: [] }),
    planIds.length ? env.XBOARD_DB.prepare(`SELECT * FROM v2_plan WHERE id IN (${planIds.map(() => "?").join(",")})`).bind(...planIds).all<any>() : Promise.resolve({ results: [] }),
    groupIds.length ? env.XBOARD_DB.prepare(`SELECT * FROM v2_server_group WHERE id IN (${groupIds.map(() => "?").join(",")})`).bind(...groupIds).all<any>() : Promise.resolve({ results: [] })
  ]);
  for (const inviter of inviterRows.results || []) inviters.set(Number(inviter.id), { id: Number(inviter.id), email: String(inviter.email || "") });
  const plans = new Map((planRows.results || []).map((row: any) => [Number(row.id), { ...row, prices: deps.parseJsonObject(row.prices), tags: deps.parseJsonArray(row.tags) }]));
  const groups = new Map((groupRows.results || []).map((row: any) => [Number(row.id), row]));
  const observedAt = now();
  const data = await Promise.all(userRows.map(async row => {
    const liveCount = liveDevices?.[String(row.id)]?.length || 0;
    const persistedCount = Number(row.last_online_at || 0) >= observedAt - 600 ? Number(row.online_count || 0) : 0;
    const usedTraffic = Number(row.u || 0) + Number(row.d || 0);
    return {
      ...deps.safeUser(row),
      balance: Number(row.balance || 0) / 100,
      commission_balance: Number(row.commission_balance || 0) / 100,
      commission_type: Number(row.commission_type ?? 0),
      total_used: usedTraffic,
      used_traffic: usedTraffic,
      subscribe_url: await deps.subscribeUrl(request, env, row.token),
      plan: plans.get(Number(row.plan_id || 0)) || null,
      group: groups.get(Number(row.group_id || 0)) || null,
      invite_user: inviters.get(Number(row.invite_user_id || 0)) || null,
      online_count: Math.max(liveCount, persistedCount),
      last_online_at: liveCount > 0 ? observedAt : row.last_online_at
    };
  }));
  return deps.paginated(data, Number(countResult?.count || 0), page, pageSize);
}
