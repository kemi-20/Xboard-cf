import { cachedData } from "../cache";
import { now } from "../compat";
import type { D1Database } from "../types";

type StatisticsEnv = { XBOARD_DB: D1Database };

export type StatisticsDeps<E extends StatisticsEnv> = {
  dayStart: (timestamp?: number) => number;
  monthStart: (timestamp?: number) => number;
  adminServerRows: (env: E) => Promise<Record<string, any>[]>;
  liveOnlineSummary: (env: E) => Promise<{ users: number; devices: number } | null>;
  firstNumber: (env: E, sql: string) => Promise<number>;
};

const APP_TIMEZONE_OFFSET = 8 * 3600;

function dateString(timestamp: number) {
  return new Date((timestamp + APP_TIMEZONE_OFFSET) * 1000).toISOString().slice(0, 10);
}

export async function adminStats<E extends StatisticsEnv>(env: E, deps: StatisticsDeps<E>) {
  const current = now();
  const today = deps.dayStart();
  const yesterday = today - 86400;
  const month = deps.monthStart();
  const lastMonth = deps.monthStart(month - 1);
  const twoMonthsAgo = deps.monthStart(lastMonth - 1);
  const nodes = await deps.adminServerRows(env);
  const liveOnline = await deps.liveOnlineSummary(env);
  const totalUsers = await deps.firstNumber(env, "SELECT COUNT(*) AS c FROM v2_user");
  const activeUsers = await deps.firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE expired_at IS NULL OR expired_at >= ${current}`);
  const currentMonthNewUsers = await deps.firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE created_at >= ${month} AND created_at < ${current}`);
  const lastMonthNewUsers = await deps.firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE created_at >= ${lastMonth} AND created_at < ${month}`);
  const todayIncome = await deps.firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${today} AND created_at < ${current} AND status NOT IN (0,2)`);
  const yesterdayIncome = await deps.firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${yesterday} AND created_at < ${today} AND status NOT IN (0,2)`);
  const currentMonthIncome = await deps.firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${month} AND created_at < ${current} AND status NOT IN (0,2)`);
  const lastMonthIncome = await deps.firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${lastMonth} AND created_at < ${month} AND status NOT IN (0,2)`);
  const twoMonthsAgoIncome = await deps.firstNumber(env, `SELECT COALESCE(SUM(total_amount), 0) AS c FROM v2_order WHERE created_at >= ${twoMonthsAgo} AND created_at < ${lastMonth} AND status NOT IN (0,2)`);
  const currentMonthCommissionPayout = await deps.firstNumber(env, `SELECT COALESCE(SUM(get_amount), 0) AS c FROM v2_commission_log WHERE created_at >= ${month} AND created_at < ${current}`);
  const lastMonthCommissionPayout = await deps.firstNumber(env, `SELECT COALESCE(SUM(get_amount), 0) AS c FROM v2_commission_log WHERE created_at >= ${lastMonth} AND created_at < ${month}`);
  const twoMonthsAgoCommission = await deps.firstNumber(env, `SELECT COALESCE(SUM(get_amount), 0) AS c FROM v2_commission_log WHERE created_at >= ${twoMonthsAgo} AND created_at < ${lastMonth}`);
  const monthUpload = await deps.firstNumber(env, `SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server WHERE record_at >= ${month} AND record_at < ${current}`);
  const monthDownload = await deps.firstNumber(env, `SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server WHERE record_at >= ${month} AND record_at < ${current}`);
  const todayUpload = await deps.firstNumber(env, `SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server WHERE record_at >= ${today} AND record_at < ${current}`);
  const todayDownload = await deps.firstNumber(env, `SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server WHERE record_at >= ${today} AND record_at < ${current}`);
  const totalUpload = await deps.firstNumber(env, "SELECT COALESCE(SUM(u), 0) AS c FROM v2_stat_server");
  const totalDownload = await deps.firstNumber(env, "SELECT COALESCE(SUM(d), 0) AS c FROM v2_stat_server");
  const growth = (value: number, previous: number) => previous > 0 ? Math.round(((value - previous) / previous) * 1000) / 10 : 0;
  return {
    todayIncome,
    dayIncomeGrowth: growth(todayIncome, yesterdayIncome),
    currentMonthIncome,
    lastMonthIncome,
    monthIncomeGrowth: growth(currentMonthIncome, lastMonthIncome),
    lastMonthIncomeGrowth: growth(lastMonthIncome, twoMonthsAgoIncome),
    currentMonthCommissionPayout,
    lastMonthCommissionPayout,
    commissionGrowth: growth(lastMonthCommissionPayout, twoMonthsAgoCommission),
    ticketPendingTotal: await deps.firstNumber(env, "SELECT COUNT(*) AS c FROM v2_ticket WHERE status = 0"),
    commissionPendingTotal: await deps.firstNumber(env, "SELECT COUNT(*) AS c FROM v2_order WHERE commission_status = 0 AND invite_user_id IS NOT NULL AND status = 3 AND commission_balance > 0"),
    currentMonthNewUsers,
    userGrowth: growth(currentMonthNewUsers, lastMonthNewUsers),
    totalUsers,
    activeUsers,
    onlineUsers: liveOnline?.users ?? await deps.firstNumber(env, `SELECT COUNT(*) AS c FROM v2_user WHERE online_count > 0 AND last_online_at >= ${current - 600}`),
    onlineDevices: liveOnline?.devices ?? await deps.firstNumber(env, `SELECT COALESCE(SUM(online_count), 0) AS c FROM v2_user WHERE online_count > 0 AND last_online_at >= ${current - 600}`),
    onlineNodes: nodes.filter(node => Number(node.available_status) > 0).length,
    todayTraffic: { upload: todayUpload, download: todayDownload, total: todayUpload + todayDownload },
    monthTraffic: { upload: monthUpload, download: monthDownload, total: monthUpload + monthDownload },
    totalTraffic: { upload: totalUpload, download: totalDownload, total: totalUpload + totalDownload }
  };
}

export async function orderStats(env: StatisticsEnv, url: URL) {
  const start = url.searchParams.get("start_date");
  const end = url.searchParams.get("end_date");
  const type = url.searchParams.get("type");
  const allowedTypes = new Set(["paid_total", "paid_count", "commission_total", "commission_count"]);
  const clauses = ["record_type = 'd'"];
  const bindings: number[] = [];
  if (start) {
    clauses.push("record_at >= ?");
    bindings.push(Math.floor(Date.parse(`${start}T00:00:00+08:00`) / 1000));
  }
  if (end) {
    clauses.push("record_at <= ?");
    bindings.push(Math.floor(Date.parse(`${end}T23:59:59+08:00`) / 1000));
  }
  const result = await env.XBOARD_DB.prepare(`SELECT record_at,paid_total,paid_count,commission_total,commission_count FROM v2_stat WHERE ${clauses.join(" AND ")} ORDER BY record_at DESC`)
    .bind(...bindings).all<Record<string, any>>();
  const rows = result.results || [];
  const dailyStats = rows.map(row => {
    const date = dateString(Number(row.record_at || 0));
    if (type && allowedTypes.has(type)) {
      const labels: Record<string, string> = { paid_total: "收款金额", paid_count: "收款笔数", commission_total: "佣金金额", commission_count: "佣金笔数" };
      return { date, value: Number(row[type] || 0), type: labels[type] };
    }
    const paidTotal = Number(row.paid_total || 0);
    const paidCount = Number(row.paid_count || 0);
    const commissionTotal = Number(row.commission_total || 0);
    const commissionCount = Number(row.commission_count || 0);
    return {
      date,
      paid_total: paidTotal,
      paid_count: paidCount,
      commission_total: commissionTotal,
      commission_count: commissionCount,
      avg_order_amount: paidCount > 0 ? Math.round(paidTotal / paidCount * 100) / 100 : 0,
      avg_commission_amount: commissionCount > 0 ? Math.round(commissionTotal / commissionCount * 100) / 100 : 0
    };
  });
  const list = [...dailyStats].reverse();
  const fullRows = rows.map(row => ({
    paid_total: Number(row.paid_total || 0),
    paid_count: Number(row.paid_count || 0),
    commission_total: Number(row.commission_total || 0),
    commission_count: Number(row.commission_count || 0)
  }));
  const paidTotal = fullRows.reduce((sum, item) => sum + item.paid_total, 0);
  const paidCount = fullRows.reduce((sum, item) => sum + item.paid_count, 0);
  const commissionTotal = fullRows.reduce((sum, item) => sum + item.commission_total, 0);
  const commissionCount = fullRows.reduce((sum, item) => sum + item.commission_count, 0);
  return {
    summary: {
      start_date: start || (rows.length ? dateString(Number(rows.at(-1)?.record_at || 0)) : dateString(now())),
      end_date: end || (rows.length ? dateString(Number(rows[0]?.record_at || 0)) : dateString(now())),
      paid_total: paidTotal,
      paid_count: paidCount,
      commission_total: commissionTotal,
      commission_count: commissionCount,
      avg_paid_amount: paidCount ? Math.round(paidTotal / paidCount * 100) / 100 : 0,
      avg_commission_amount: commissionCount ? Math.round(commissionTotal / commissionCount * 100) / 100 : 0,
      commission_rate: paidTotal ? Math.round(commissionTotal / paidTotal * 10000) / 100 : 0
    },
    list
  };
}

export async function trafficRank(env: StatisticsEnv, url: URL) {
  const type = String(url.searchParams.get("type"));
  const start = Number(url.searchParams.get("start_time") || now() - 7 * 86400);
  const end = Number(url.searchParams.get("end_time") || now());
  const startBucket = Math.floor(start / 300);
  const endBucket = Math.floor(end / 300);
  return cachedData(`traffic-rank:${type}:${startBucket}:${endBucket}`, 300, async () => {
    const previousStart = start - Math.max(0, end - start);
    const calculateChange = (value: number, previousValue: number) => previousValue > 0
      ? Math.round(((value - previousValue) / previousValue) * 1000) / 10
      : 0;
    const table = type === "node" ? "v2_stat_server" : "v2_stat_user";
    const idColumn = type === "node" ? "server_id" : "user_id";
    const relationTable = type === "node" ? "v2_server" : "v2_user";
    const relationAlias = type === "node" ? "s" : "u";
    const nameColumn = type === "node" ? "name" : "email";
    try {
      const rankedRows = await env.XBOARD_DB.prepare(
        `WITH traffic AS (
           SELECT ${idColumn} AS id,
             SUM(CASE WHEN record_at >= ? AND record_at <= ? THEN u + d ELSE 0 END) AS value,
             SUM(CASE WHEN record_at >= ? AND record_at < ? THEN u + d ELSE 0 END) AS previousValue
           FROM ${table}
           WHERE record_at >= ? AND record_at <= ? AND COALESCE(record_type, 'd') = 'd'
           GROUP BY ${idColumn}
         )
         SELECT traffic.id, ${relationAlias}.${nameColumn} AS name, COALESCE(traffic.value, 0) AS value, COALESCE(traffic.previousValue, 0) AS previousValue
         FROM traffic LEFT JOIN ${relationTable} ${relationAlias} ON ${relationAlias}.id = traffic.id
         WHERE traffic.value > 0 ORDER BY traffic.value DESC LIMIT 10`
      ).bind(start, end, previousStart, start, previousStart, end).all<{ id: number; name: string; value: number; previousValue: number }>();
      return (rankedRows.results || []).map(row => {
        const value = Number(row.value || 0);
        const previousValue = Number(row.previousValue || 0);
        return {
          id: String(row.id),
          name: row.name || `${type === "node" ? "Node" : "User"} ${row.id}`,
          value,
          previousValue,
          change: calculateChange(value, previousValue),
          timestamp: new Date(end * 1000).toISOString()
        };
      });
    } catch {
      return [];
    }
  });
}
