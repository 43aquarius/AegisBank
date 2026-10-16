// ============ 工具层：账单分析域 ============
// 能力：余额查询、流水查询、消费分类统计、异常交易识别、月度/年度账单报告

import { db } from "@/lib/db";
import { ToolResult } from "../types";

export async function queryBalance(userId: string): Promise<ToolResult> {
  const accounts = await db.account.findMany({ where: { userId } });
  const holdingVal = await db.holding.aggregate({
    where: { userId, status: "HELD" },
    _sum: { amount: true },
  });
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const locked = accounts.reduce((s, a) => s + a.lockedAmt, 0);
  return {
    ok: true,
    data: {
      total: Number(total.toFixed(2)),
      locked: Number(locked.toFixed(2)),
      usable: Number((total - locked).toFixed(2)),
      finance: Number((holdingVal._sum.amount ?? 0).toFixed(2)),
      accounts: accounts.map((a) => ({
        accountNo: a.accountNo.slice(-4),
        type: a.type === "DEBIT" ? "活期" : "定期锁定",
        balance: Number(a.balance.toFixed(2)),
        lockedAmt: a.lockedAmt,
      })),
    },
    evidence: { source: "Account", snapshot: accounts.map((a) => a.balance).join(",") },
  };
}

export async function queryTransactions(
  userId: string,
  p: { days?: number; category?: string; limit?: number } = {}
): Promise<ToolResult> {
  const days = p.days ?? 30;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const txs = await db.transaction.findMany({
    where: {
      userId,
      occurredAt: { gte: since },
      ...(p.category && p.category !== "全部" ? { category: p.category } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: p.limit ?? 50,
  });
  return {
    ok: true,
    data: txs.map((t) => ({
      id: t.id.slice(-8).toUpperCase(),
      type: t.type,
      direction: t.direction,
      amount: t.amount,
      category: t.category,
      merchant: t.merchant,
      remark: t.remark,
      status: t.status,
      time: t.occurredAt.toISOString(),
    })),
    evidence: { source: "Transaction", snapshot: txs.map((t) => t.id).join(",") },
  };
}

/** 消费分类统计（近 N 天） */
export async function categorizeSpending(userId: string, days = 30): Promise<ToolResult> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const txs = await db.transaction.findMany({
    where: { userId, direction: "OUT", occurredAt: { gte: since }, status: "SUCCESS" },
  });
  const byCat = new Map<string, { total: number; count: number }>();
  for (const t of txs) {
    const cur = byCat.get(t.category) ?? { total: 0, count: 0 };
    cur.total += t.amount;
    cur.count += 1;
    byCat.set(t.category, cur);
  }
  const totalOut = txs.reduce((s, t) => s + t.amount, 0);
  const cats = [...byCat.entries()]
    .map(([category, v]) => ({
      category,
      total: Number(v.total.toFixed(2)),
      count: v.count,
      ratio: totalOut > 0 ? Number(((v.total / totalOut) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.total - a.total);
  return {
    ok: true,
    data: { days, totalOut: Number(totalOut.toFixed(2)), txCount: txs.length, categories: cats },
    evidence: { source: "Transaction", snapshot: totalOut.toFixed(2) },
  };
}

/**
 * 异常交易识别（规则引擎，可解释）：
 *  R1 夜间交易（0:00-5:00 金额>200）
 *  R2 大额消费（单笔 > 日常均值×5 且 > 500）
 *  R3 重复扣费（同商户同金额 24h 内 ≥2 笔）
 *  R4 可疑商户（命中黑名单词：博彩/外汇/陌生境外）
 */
export async function detectAnomaly(userId: string, days = 30): Promise<ToolResult> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const txs = await db.transaction.findMany({
    where: { userId, direction: "OUT", occurredAt: { gte: since }, status: "SUCCESS" },
    orderBy: { occurredAt: "asc" },
  });
  const avg = txs.length ? txs.reduce((s, t) => s + t.amount, 0) / txs.length : 0;
  const BLACK = [/博彩/i, /外汇/i, /交易所/i, /跨境商城/i];
  const anomalies: { rule: string; desc: string; txId: string; amount: number; merchant: string; time: string; severity: string }[] = [];

  for (const t of txs) {
    const hour = t.occurredAt.getHours();
    if (hour >= 0 && hour < 5 && t.amount > 200) {
      anomalies.push({
        rule: "R1 夜间交易",
        desc: `凌晨 ${hour} 点发生 ¥${t.amount} 支出`,
        txId: t.id.slice(-8).toUpperCase(),
        amount: t.amount,
        merchant: t.merchant,
        time: t.occurredAt.toISOString(),
        severity: "中",
      });
    }
    if (t.amount > Math.max(avg * 5, 500)) {
      anomalies.push({
        rule: "R2 大额偏离",
        desc: `金额为近${days}天日均消费 ¥${avg.toFixed(0)} 的 ${(t.amount / Math.max(avg, 1)).toFixed(1)} 倍`,
        txId: t.id.slice(-8).toUpperCase(),
        amount: t.amount,
        merchant: t.merchant,
        time: t.occurredAt.toISOString(),
        severity: "高",
      });
    }
    if (BLACK.some((b) => b.test(t.merchant))) {
      anomalies.push({
        rule: "R4 可疑商户",
        desc: `商户「${t.merchant}」命中风控黑名单特征`,
        txId: t.id.slice(-8).toUpperCase(),
        amount: t.amount,
        merchant: t.merchant,
        time: t.occurredAt.toISOString(),
        severity: "高",
      });
    }
  }
  // R3 重复扣费
  const seen = new Map<string, typeof txs>();
  for (const t of txs) {
    const key = `${t.merchant}|${t.amount}`;
    seen.set(key, [...(seen.get(key) ?? []), t]);
  }
  for (const [key, group] of seen) {
    if (group.length >= 2) {
      const within24h =
        group[group.length - 1].occurredAt.getTime() - group[0].occurredAt.getTime() < 24 * 3600 * 1000;
      if (within24h) {
        anomalies.push({
          rule: "R3 重复扣费",
          desc: `「${key.split("|")[0]}」24 小时内出现 ${group.length} 笔相同金额 ¥${group[0].amount}`,
          txId: group[group.length - 1].id.slice(-8).toUpperCase(),
          amount: group[0].amount * group.length,
          merchant: key.split("|")[0],
          time: group[group.length - 1].occurredAt.toISOString(),
          severity: "中",
        });
      }
    }
  }
  return {
    ok: true,
    data: { days, avgDaily: Number(avg.toFixed(2)), count: anomalies.length, anomalies },
    evidence: { source: "Transaction", snapshot: anomalies.length.toString() },
  };
}

/** 月度/年度账单报告 */
export async function generateReport(userId: string, period: "month" | "year"): Promise<ToolResult> {
  const now = new Date();
  const since =
    period === "month"
      ? new Date(now.getFullYear(), now.getMonth() - 1, 1)
      : new Date(now.getFullYear(), 0, 1);
  const until = period === "month" ? new Date(now.getFullYear(), now.getMonth(), 1) : now;
  const txs = await db.transaction.findMany({
    where: { userId, occurredAt: { gte: since, lt: until } },
  });
  const outs = txs.filter((t) => t.direction === "OUT");
  const ins = txs.filter((t) => t.direction === "IN");
  const totalOut = outs.reduce((s, t) => s + t.amount, 0);
  const totalIn = ins.reduce((s, t) => s + t.amount, 0);
  const byCat = new Map<string, number>();
  for (const t of outs) byCat.set(t.category, (byCat.get(t.category) ?? 0) + t.amount);
  const topCats = [...byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, total]) => ({ category, total: Number(total.toFixed(2)) }));
  const byMerchant = new Map<string, number>();
  for (const t of outs) byMerchant.set(t.merchant, (byMerchant.get(t.merchant) ?? 0) + t.amount);
  const topMerchants = [...byMerchant.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([merchant, total]) => ({ merchant, total: Number(total.toFixed(2)) }));
  const title = period === "month"
    ? `${since.getFullYear()} 年 ${since.getMonth() + 1} 月账单`
    : `${since.getFullYear()} 年度账单`;
  return {
    ok: true,
    data: {
      title,
      period,
      totalIn: Number(totalIn.toFixed(2)),
      totalOut: Number(totalOut.toFixed(2)),
      net: Number((totalIn - totalOut).toFixed(2)),
      txCount: txs.length,
      topCategories: topCats,
      topMerchants: topMerchants,
      insight:
        totalOut > totalIn
          ? "本期支出大于收入，建议关注消费结构中占比最高的类别"
          : "本期收支健康，收入覆盖支出，可考虑将结余进行稳健理财",
    },
    evidence: { source: "Transaction", snapshot: `${totalIn.toFixed(2)}|${totalOut.toFixed(2)}` },
  };
}
