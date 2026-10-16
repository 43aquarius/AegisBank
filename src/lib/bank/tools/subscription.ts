// ============ 工具层：订阅/代扣管理域 + 跨场景联动域 ============
// 订阅：自动识别订阅扣费、续费提醒、一键取消
// 跨场景：生日规划（锁定资金→定时→订购鲜花蛋糕）、自定义联动计划

import { db } from "@/lib/db";
import { ToolResult } from "../types";
import { audit } from "../audit";

/** 从交易流水中自动识别周期性扣费（连续3个月同商户同金额） */
export async function detectSubscriptions(userId: string): Promise<ToolResult> {
  const since = new Date(Date.now() - 120 * 24 * 3600 * 1000); // 近120天
  const txs = await db.transaction.findMany({
    where: { userId, direction: "OUT", occurredAt: { gte: since }, status: "SUCCESS" },
    orderBy: { occurredAt: "asc" },
  });
  // 按商户+金额分组，检查是否存在 ≈30天 间隔的 ≥3 笔
  const groups = new Map<string, typeof txs>();
  for (const t of txs) {
    const key = `${t.merchant}|${t.amount}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const detected: { merchant: string; amount: number; cycle: string; months: number; monthlyOut: number }[] = [];
  for (const [key, g] of groups) {
    if (g.length < 3) continue;
    const gaps: number[] = [];
    for (let i = 1; i < g.length; i++) {
      gaps.push(g[i].occurredAt.getTime() - g[i - 1].occurredAt.getTime());
    }
    const avgGap = gaps.reduce((s, x) => s + x, 0) / gaps.length;
    const day = 24 * 3600 * 1000;
    if (Math.abs(avgGap - 30 * day) < 5 * day) {
      detected.push({
        merchant: key.split("|")[0],
        amount: Number(key.split("|")[1]),
        cycle: "MONTHLY",
        months: g.length,
        monthlyOut: Number(key.split("|")[1]),
      });
    } else if (Math.abs(avgGap - 7 * day) < 2 * day && g.length >= 4) {
      detected.push({
        merchant: key.split("|")[0],
        amount: Number(key.split("|")[1]),
        cycle: "WEEKLY",
        months: g.length,
        monthlyOut: Number((Number(key.split("|")[1]) * 4.3).toFixed(2)),
      });
    }
  }
  // 与订阅表同步（登记识别结果）
  for (const d of detected) {
    const exist = await db.subscription.findFirst({
      where: { userId, merchant: d.merchant, amount: d.amount },
    });
    if (!exist) {
      await db.subscription.create({
        data: {
          userId,
          merchant: d.merchant,
          category: guessCategory(d.merchant),
          amount: d.amount,
          cycle: d.cycle,
          nextCharge: nextChargeDate(d.cycle),
          detected: true,
        },
      });
    } else {
      await db.subscription.update({ where: { id: exist.id }, data: { detected: true } });
    }
  }
  const monthlyTotal = detected.reduce((s, d) => s + d.monthlyOut, 0);
  return {
    ok: true,
    data: {
      count: detected.length,
      monthlyTotal: Number(monthlyTotal.toFixed(2)),
      annualTotal: Number((monthlyTotal * 12).toFixed(2)),
      subscriptions: detected,
    },
    evidence: { source: "Transaction", snapshot: detected.map((d) => d.merchant).join(",") },
  };
}

function guessCategory(merchant: string): string {
  if (/爱奇艺|腾讯视频|优酷|B站|哔哩/i.test(merchant)) return "视频会员";
  if (/网易云|QQ音乐|酷狗/i.test(merchant)) return "音乐会员";
  if (/iCloud|百度网盘|云盘/i.test(merchant)) return "云存储";
  if (/美团|饿了么|外卖/i.test(merchant)) return "外卖";
  if (/健身|keep|健身房/i.test(merchant)) return "健身";
  if (/WPS| office |钉钉|飞书/i.test(merchant)) return "办公软件";
  return "其他订阅";
}

function nextChargeDate(cycle: string): Date {
  const d = new Date();
  if (cycle === "WEEKLY") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

export async function listSubscriptions(userId: string): Promise<ToolResult> {
  const subs = await db.subscription.findMany({ where: { userId }, orderBy: { nextCharge: "asc" } });
  return {
    ok: true,
    data: subs.map((s) => ({
      merchant: s.merchant,
      category: s.category,
      amount: s.amount,
      cycle: s.cycle === "MONTHLY" ? "每月" : s.cycle === "WEEKLY" ? "每周" : "每年",
      nextCharge: s.nextCharge.toISOString(),
      active: s.active,
      autoRenew: s.autoRenew,
    })),
    evidence: { source: "Subscription", snapshot: subs.map((s) => s.merchant).join(",") },
  };
}

/** 取消订阅：登记取消意愿 + 创建到期自动拦截任务 */
export async function cancelSubscription(
  userId: string,
  p: { merchant: string; traceId: string }
): Promise<ToolResult> {
  const sub = await db.subscription.findFirst({
    where: { userId, merchant: { contains: p.merchant }, active: true },
  });
  if (!sub) return { ok: false, error: `未找到「${p.merchant}」的有效订阅，可发送「识别订阅」重新扫描` };
  await db.subscription.update({ where: { id: sub.id }, data: { active: false, autoRenew: false } });
  await db.scheduledTask.create({
    data: {
      userId,
      kind: "SUBSCRIPTION_CANCEL",
      payload: JSON.stringify({ merchant: sub.merchant, amount: sub.amount, subscriptionId: sub.id }),
      runAt: sub.nextCharge, // 到期时校验拦截
    },
  });
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "subscription.cancel",
    riskLevel: "YELLOW",
    decision: "ALLOW",
    detail: { merchant: sub.merchant },
  });
  return {
    ok: true,
    data: {
      merchant: sub.merchant,
      savedMonthly: sub.amount,
      savedAnnual: Number((sub.amount * 12).toFixed(2)),
      nextChargeDate: sub.nextCharge.toISOString(),
      note: "已设置到期自动拦截，扣费日将二次校验；如商户继续扣款，Agent 将自动发起争议处理",
    },
    evidence: { source: "Subscription", snapshot: sub.merchant },
  };
}

/** 设置续费提醒（提前 N 天） */
export async function setRenewReminder(
  userId: string,
  p: { merchant?: string; daysAhead?: number; traceId: string }
): Promise<ToolResult> {
  const subs = await db.subscription.findMany({ where: { userId, active: true } });
  const targets = p.merchant ? subs.filter((s) => s.merchant.includes(p.merchant)) : subs;
  if (targets.length === 0) return { ok: false, error: "没有可提醒的有效订阅" };
  const ahead = p.daysAhead ?? 3;
  for (const s of targets) {
    await db.scheduledTask.create({
      data: {
        userId,
        kind: "SUBSCRIPTION_REMIND",
        payload: JSON.stringify({ merchant: s.merchant, amount: s.amount, subscriptionId: s.id }),
        runAt: new Date(s.nextCharge.getTime() - ahead * 24 * 3600 * 1000),
      },
    });
  }
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "subscription.remind",
    riskLevel: "YELLOW",
    decision: "ALLOW",
    detail: { merchants: targets.map((t) => t.merchant), ahead },
  });
  return {
    ok: true,
    data: {
      ahead,
      subscriptions: targets.map((s) => ({
        merchant: s.merchant,
        amount: s.amount,
        remindDate: new Date(s.nextCharge.getTime() - ahead * 24 * 3600 * 1000).toISOString(),
      })),
    },
    evidence: { source: "ScheduledTask", snapshot: targets.map((t) => t.merchant).join(",") },
  };
}

// ============ 跨场景联动 ============

/**
 * 生日规划（赛题示例场景）：
 *  1. 锁定当月 ¥1000 活期资金（资金保护）
 *  2. 生日前 2 天自动订购鲜花 + 蛋糕（沙箱商户演示）
 * DAG: 锁资金 →(成功)→ 建订购任务 → 通知用户
 */
export async function createBirthdayPlan(
  userId: string,
  p: { person?: string; date?: string; budget?: number; traceId: string }
): Promise<ToolResult> {
  const account = await db.account.findFirst({ where: { userId, type: "DEBIT" } });
  if (!account) return { ok: false, error: "未找到可用账户" };
  const budget = p.budget ?? 1000;
  const usable = account.balance - account.lockedAmt;
  if (usable < budget) {
    return { ok: false, error: `可锁资金不足（可用 ¥${usable.toFixed(2)}，需 ¥${budget.toFixed(2)}）` };
  }
  // 锁定资金
  await db.account.update({ where: { id: account.id }, data: { lockedAmt: { increment: budget } } });
  await db.transaction.create({
    data: {
      userId,
      accountId: account.id,
      type: "LOCK",
      amount: budget,
      direction: "OUT",
      category: "资金锁定",
      merchant: `生日资金池（${p.person ?? "爱人"}）`,
      remark: `为 ${p.person ?? "爱人"} 的生日计划锁定`,
      occurredAt: new Date(),
    },
  });
  // 订购任务（鲜花+蛋糕前2天）
  await db.scheduledTask.create({
    data: {
      userId,
      kind: "BIRTHDAY_PLAN",
      payload: JSON.stringify({
        person: p.person ?? "爱人",
        budget,
        items: [
          { name: "鲜花·混合花束", price: 398, merchant: "花加" },
          { name: "蛋糕·8寸双层", price: 428, merchant: "幸福西饼" },
        ],
      }),
      runAt: new Date(p.date ?? new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString()),
    },
  });
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "cross.birthday_plan",
    riskLevel: "RED",
    decision: "ALLOW",
    detail: { person: p.person, budget, date: p.date },
  });
  return {
    ok: true,
    data: {
      person: p.person ?? "爱人",
      budget,
      locked: budget,
      balanceAfter: Number((account.balance - budget).toFixed(2)),
      items: [
        { name: "鲜花·混合花束", price: 398, merchant: "花加" },
        { name: "蛋糕·8寸双层", price: 428, merchant: "幸福西饼" },
      ],
      note: "已锁定资金并创建订购计划；订购执行前将再次向您确认，失败自动回补资金",
    },
    evidence: { source: "Account", snapshot: String(budget) },
  };
}

/** 自定义联动计划（条件→动作） */
export async function createCustomPlan(
  userId: string,
  p: { when: string; action: string; traceId: string }
): Promise<ToolResult> {
  await db.scheduledTask.create({
    data: {
      userId,
      kind: "CUSTOM_PLAN",
      payload: JSON.stringify({ when: p.when, action: p.action }),
      runAt: new Date(Date.now() + 24 * 3600 * 1000), // 默认次日评估
    },
  });
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "cross.custom_plan",
    riskLevel: "YELLOW",
    decision: "ALLOW",
    detail: p,
  });
  return {
    ok: true,
    data: {
      when: p.when,
      action: p.action,
      note: "联动计划已登记，触发时会先向您确认再执行（涉资金操作仍走分级管控）",
    },
    evidence: { source: "ScheduledTask", snapshot: p.when },
  };
}
