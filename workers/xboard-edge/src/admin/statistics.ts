import { cachedData } from "../cache";
import { now, ONLINE_RETENTION_SECONDS } from "../compat";
import type { D1Database } from "../types";

const ORDER_STAT_LABELS: Record<string, string> = {
  paid_total: "收款金额",
  paid_count: "收款笔数",
  commission_total: "佣金金额",
  commission_count: "佣金笔数"
};

type StatisticsEnv = { XBOARD_DB: D1Database };

export type StatisticsDeps<E extends StatisticsEnv> = {
  dayStart: (timestamp?: number) => number;
  monthStart: (timestamp?: number) => number;
  adminServerRows: (env: E) => Promise<Record<string, any>[]>;
  liveOnlineSummary: (env: E) => Promise<{ users: number; devices: number } | null>;
};

const APP_TIMEZONE_OFFSET = 8 * 3600;

function dateString(timestamp: number) {
  return new Date((timestamp + APP_TIMEZONE_OFFSET) * 1000).toISOString().slice(0, 10);
}

function growthRate(value: number, previous: number) {
  return previous > 0 ? Math.round(((value - previous) / previous) * 1000) / 10 : 0;
}

export async function adminStats<E extends StatisticsEnv>(env: E, deps: StatisticsDeps<E>) {
  const current = now();
  const today = deps.dayStart();
  const yesterday = today - 86400;
  const month = deps.monthStart();
  const lastMonth = deps.monthStart(month - 1);
  const twoMonthsAgo = deps.monthStart(lastMonth - 1);
  const metricsPromise = env.XBOARD_DB.batch([
    env.XBOARD_DB.prepare(`SELECT COUNT(*) AS total_users,
      COALESCE(SUM(CASE WHEN expired_at IS NULL OR expired_at >= ? THEN 1 ELSE 0 END), 0) AS active_users,
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS current_month_new_users,
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS last_month_new_users,
      COALESCE(SUM(CASE WHEN online_count > 0 AND last_online_at >= ? THEN 1 ELSE 0 END), 0) AS online_users,
      COALESCE(SUM(CASE WHEN online_count > 0 AND last_online_at >= ? THEN online_count ELSE 0 END), 0) AS online_devices
      FROM v2_user`).bind(current, month, current, lastMonth, month, current - ONLINE_RETENTION_SECONDS, current - ONLINE_RETENTION_SECONDS),
    env.XBOARD_DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? AND status NOT IN (0,2) THEN total_amount ELSE 0 END), 0) AS today_income,
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? AND status NOT IN (0,2) THEN total_amount ELSE 0 END), 0) AS yesterday_income,
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? AND status NOT IN (0,2) THEN total_amount ELSE 0 END), 0) AS current_month_income,
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? AND status NOT IN (0,2) THEN total_amount ELSE 0 END), 0) AS last_month_income,
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? AND status NOT IN (0,2) THEN total_amount ELSE 0 END), 0) AS two_months_ago_income,
      COALESCE(SUM(CASE WHEN commission_status = 0 AND invite_user_id IS NOT NULL AND status = 3 AND commission_balance > 0 THEN 1 ELSE 0 END), 0) AS commission_pending_total
      FROM v2_order`).bind(today, current, yesterday, today, month, current, lastMonth, month, twoMonthsAgo, lastMonth),
    env.XBOARD_DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN get_amount ELSE 0 END), 0) AS current_month_commission_payout,
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN get_amount ELSE 0 END), 0) AS last_month_commission_payout,
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN get_amount ELSE 0 END), 0) AS two_months_ago_commission
      FROM v2_commission_log`).bind(month, current, lastMonth, month, twoMonthsAgo, lastMonth),
    env.XBOARD_DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN record_at >= ? AND record_at < ? THEN u ELSE 0 END), 0) AS month_upload,
      COALESCE(SUM(CASE WHEN record_at >= ? AND record_at < ? THEN d ELSE 0 END), 0) AS month_download,
      COALESCE(SUM(CASE WHEN record_at >= ? AND record_at < ? THEN u ELSE 0 END), 0) AS today_upload,
      COALESCE(SUM(CASE WHEN record_at >= ? AND record_at < ? THEN d ELSE 0 END), 0) AS today_download,
      COALESCE(SUM(u), 0) AS total_upload, COALESCE(SUM(d), 0) AS total_download
      FROM v2_stat_server`).bind(month, current, month, current, today, current, today, current),
    env.XBOARD_DB.prepare("SELECT COUNT(*) AS ticket_pending_total FROM v2_ticket WHERE status = 0")
  ]);
  const [nodes, liveOnline, metricResults] = await Promise.all([
    deps.adminServerRows(env),
    deps.liveOnlineSummary(env),
    metricsPromise
  ]);
  const row = (index: number) => (metricResults[index]?.results?.[0] || {}) as Record<string, any>;
  const users = row(0), orders = row(1), commissions = row(2), traffic = row(3), tickets = row(4);
  const totalUsers = Number(users.total_users || 0);
  const activeUsers = Number(users.active_users || 0);
  const currentMonthNewUsers = Number(users.current_month_new_users || 0);
  const lastMonthNewUsers = Number(users.last_month_new_users || 0);
  const todayIncome = Number(orders.today_income || 0);
  const yesterdayIncome = Number(orders.yesterday_income || 0);
  const currentMonthIncome = Number(orders.current_month_income || 0);
  const lastMonthIncome = Number(orders.last_month_income || 0);
  const twoMonthsAgoIncome = Number(orders.two_months_ago_income || 0);
  const currentMonthCommissionPayout = Number(commissions.current_month_commission_payout || 0);
  const lastMonthCommissionPayout = Number(commissions.last_month_commission_payout || 0);
  const twoMonthsAgoCommission = Number(commissions.two_months_ago_commission || 0);
  const monthUpload = Number(traffic.month_upload || 0), monthDownload = Number(traffic.month_download || 0);
  const todayUpload = Number(traffic.today_upload || 0), todayDownload = Number(traffic.today_download || 0);
  const totalUpload = Number(traffic.total_upload || 0), totalDownload = Number(traffic.total_download || 0);
  return {
    todayIncome,
    dayIncomeGrowth: growthRate(todayIncome, yesterdayIncome),
    currentMonthIncome,
    lastMonthIncome,
    monthIncomeGrowth: growthRate(currentMonthIncome, lastMonthIncome),
    lastMonthIncomeGrowth: growthRate(lastMonthIncome, twoMonthsAgoIncome),
    currentMonthCommissionPayout,
    lastMonthCommissionPayout,
    commissionGrowth: growthRate(lastMonthCommissionPayout, twoMonthsAgoCommission),
    ticketPendingTotal: Number(tickets.ticket_pending_total || 0),
    commissionPendingTotal: Number(orders.commission_pending_total || 0),
    currentMonthNewUsers,
    userGrowth: growthRate(currentMonthNewUsers, lastMonthNewUsers),
    totalUsers,
    activeUsers,
    onlineUsers: Math.max(Number(users.online_users || 0), Number(liveOnline?.users || 0)),
    onlineDevices: Math.max(Number(users.online_devices || 0), Number(liveOnline?.devices || 0)),
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
  let totalPaidAmount = 0;
  let totalPaidCount = 0;
  let totalCommissionAmount = 0;
  let totalCommissionCount = 0;
  const list = rows.map(row => {
    const date = dateString(Number(row.record_at || 0));
    totalPaidAmount += Number(row.paid_total || 0);
    totalPaidCount += Number(row.paid_count || 0);
    totalCommissionAmount += Number(row.commission_total || 0);
    totalCommissionCount += Number(row.commission_count || 0);
    if (type && allowedTypes.has(type)) {
      return { date, value: Number(row[type] || 0), type: ORDER_STAT_LABELS[type] };
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
  }).reverse();
  return {
    summary: {
      start_date: start || (rows.length ? dateString(Number(rows.at(-1)?.record_at || 0)) : dateString(now())),
      end_date: end || (rows.length ? dateString(Number(rows[0]?.record_at || 0)) : dateString(now())),
      paid_total: totalPaidAmount,
      paid_count: totalPaidCount,
      commission_total: totalCommissionAmount,
      commission_count: totalCommissionCount,
      avg_paid_amount: totalPaidCount ? Math.round(totalPaidAmount / totalPaidCount * 100) / 100 : 0,
      avg_commission_amount: totalCommissionCount ? Math.round(totalCommissionAmount / totalCommissionCount * 100) / 100 : 0,
      commission_rate: totalPaidAmount ? Math.round(totalCommissionAmount / totalPaidAmount * 10000) / 100 : 0
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
          change: growthRate(value, previousValue),
          timestamp: new Date(end * 1000).toISOString()
        };
      });
    } catch {
      return [];
    }
  });
}
