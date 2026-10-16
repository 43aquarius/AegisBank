// ============ AegisBank 权限分级引擎 ============
// 核心安全设计："低风险自动、高风险确认、极高风险强验证"
// 赛题要求（实现优先级：高）

import { db } from "@/lib/db";
import { RiskLevel, INTENT_RISK } from "./types";
import { audit } from "./audit";

// 每日小额/大额转账阈值（赛题规定）
const DAILY_SMALL_LIMIT = 1000;

export interface PermissionDecision {
  risk: RiskLevel;
  policy: "AUTO" | "CONFIRM" | "STRONG_VERIFY";
  allow: boolean;
  reason: string;
  dynamic?: {
    dailyTransferred?: number;   // 今日已转出累计
    overThreshold?: boolean;     // 是否超日累计阈值
  };
}

/** 计算当日转出累计（含已执行+待执行 scheduled） */
export async function getDailyTransferred(userId: string, excludeTxId?: string): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const txs = await db.transaction.findMany({
    where: {
      userId,
      direction: "OUT",
      type: { in: ["TRANSFER_OUT"] },
      occurredAt: { gte: todayStart },
      status: { in: ["SUCCESS", "SCHEDULED"] },
      ...(excludeTxId ? { NOT: { id: excludeTxId } } : {}),
    },
  });
  return txs.reduce((s, t) => s + t.amount, 0);
}

/**
 * 权限判定主入口。
 * 规则：
 *  - GREEN: 纯查询 → 自动执行
 *  - YELLOW: 小额转账(单笔+日累计≤1000)、订阅取消、虚拟卡申请、限制开关、订阅提醒、风险测评 → 用户确认
 *  - RED: 大额转账(单笔>1000 或 转账后日累计>1000)、理财申购/赎回、额度调整、挂失解挂、密码修改、跨场景资金锁定 → 强验证
 *
 * 动态升级规则：一笔 800 元转账本身是黄色，但当日已累计转出 500 元，
 * 800+500=1300 > 1000 → 本次自动升级为红色强验证（防止拆分规避）。
 */
export async function judgePermission(
  userId: string,
  intent: string,
  slots: Record<string, unknown>,
  traceId: string
): Promise<PermissionDecision> {
  const base = INTENT_RISK[intent] ?? "RED"; // 未知意图一律按最高风险处理（fail-safe）
  let risk = base as RiskLevel;
  let reason = "";
  const dynamic: PermissionDecision["dynamic"] = {};

  // ---- 转账类动态升级判定 ----
  if (intent === "transfer.execute" || intent === "transfer.schedule") {
    const amount = Number(slots.amount ?? 0);
    const daily = await getDailyTransferred(userId);
    dynamic.dailyTransferred = daily;
    // 余额预检（体验与安全兼顾：提前拦截，不进入确认/验证流程）
    const account = await db.account.findFirst({ where: { userId, type: "DEBIT" } });
    if (account) {
      const usable = account.balance - account.lockedAmt;
      if (amount > usable) {
        const d: PermissionDecision = {
          risk: "RED",
          policy: "STRONG_VERIFY",
          allow: false,
          reason: `可用余额不足（可用 ¥${usable.toFixed(2)}，本次需 ¥${amount.toFixed(2)}），已提前拦截`,
          dynamic,
        };
        await audit(userId, traceId, {
          stage: "PERMISSION",
          action: `intent.${intent}`,
          riskLevel: "RED",
          decision: "DENY",
          detail: { slots, reason: d.reason },
        });
        return d;
      }
    }
    const afterTotal = daily + amount;
    if (amount > DAILY_SMALL_LIMIT || afterTotal > DAILY_SMALL_LIMIT) {
      risk = "RED";
      dynamic.overThreshold = true;
      reason =
        amount > DAILY_SMALL_LIMIT
          ? `单笔金额 ¥${amount} 超过小额阈值 ¥${DAILY_SMALL_LIMIT}`
          : `今日已累计转出 ¥${daily.toFixed(2)}，叠加本次 ¥${amount} 后将超日累计限额 ¥${DAILY_SMALL_LIMIT}（防拆分升级）`;
    } else {
      risk = "YELLOW";
      reason = `小额转账（单笔 ¥${amount}，今日累计转出 ¥${daily.toFixed(2)}，未超 ¥${DAILY_SMALL_LIMIT}）`;
    }
  }

  // ---- AA 收款金额分级 ----
  if (intent === "transfer.aa_collect") {
    const total = Number(slots.total ?? 0);
    if (total > DAILY_SMALL_LIMIT) {
      risk = "RED";
      reason = `AA 收款总额 ¥${total} 超过 ¥${DAILY_SMALL_LIMIT}，涉及大额资金归集`;
    } else {
      risk = "YELLOW";
      reason = "AA 收款为收款行为，金额较小，仅需确认发起";
    }
  }

  // ---- 挂失/解挂：解挂视同高风险 ----
  if (intent === "card.report_lost") {
    risk = "RED";
    reason = slots.op === "unlost" ? "卡片解挂恢复交易能力，属高风险操作" : "卡片挂失影响支付能力，属高风险操作";
  }

  // ---- 超范围请求：直接拒绝（不进入任何执行） ----
  if (intent === "out_of_scope") {
    const d: PermissionDecision = {
      risk: "RED",
      policy: "STRONG_VERIFY",
      allow: false,
      reason: "超出银行 Agent 服务范围的请求，安全策略直接拒绝",
    };
    await audit(userId, traceId, {
      stage: "PERMISSION",
      action: `intent.${intent}`,
      riskLevel: "RED",
      decision: "DENY",
      detail: { slots, reason: d.reason },
    });
    return d;
  }

  const policy: PermissionDecision["policy"] =
    risk === "GREEN" ? "AUTO" : risk === "YELLOW" ? "CONFIRM" : "STRONG_VERIFY";

  if (!reason) {
    reason =
      risk === "GREEN"
        ? "纯查询类操作，无资金与信息安全风险"
        : risk === "YELLOW"
          ? "涉及账户变更但影响可控，需用户明确确认"
          : "涉及大额资金/核心账户安全，需多因子强验证";
  }

  const decision: PermissionDecision = {
    risk,
    policy,
    allow: true,
    reason,
    dynamic,
  };

  await audit(userId, traceId, {
    stage: "PERMISSION",
    action: `intent.${intent}`,
    riskLevel: risk,
    decision: risk === "GREEN" ? "ALLOW" : "PENDING",
    detail: { slots, reason, dynamic },
  });

  return decision;
}

/** 生成强验证（短信验证码——演示环境同时将验证码回传给"手机"面板） */
export async function createStrongVerify(
  userId: string,
  traceId: string,
  target: string
): Promise<{ method: "SMS"; code: string; expiredAt: Date; demoCode: string }> {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiredAt = new Date(Date.now() + 5 * 60 * 1000);
  await db.verifyRecord.create({
    data: { userId, traceId, method: "SMS", code, target, expiredAt },
  });
  await audit(userId, traceId, {
    stage: "VERIFY",
    action: "verify.sms_send",
    riskLevel: "RED",
    decision: "PENDING",
    detail: { target, expiredAt: expiredAt.toISOString() },
  });
  // demoCode: 前端"模拟手机"面板展示，还原真实短信验证体验
  return { method: "SMS", code, expiredAt, demoCode: code };
}

/** 校验强验证码 */
export async function checkStrongVerify(
  userId: string,
  traceId: string,
  code: string
): Promise<{ ok: boolean; message: string }> {
  const rec = await db.verifyRecord.findFirst({
    where: { userId, traceId, used: false },
    orderBy: { createdAt: "desc" },
  });
  if (!rec) return { ok: false, message: "未找到有效的验证记录，请重新发起操作" };
  if (rec.expiredAt < new Date()) return { ok: false, message: "验证码已过期（5分钟有效期），请重新获取" };
  if (rec.code !== code.trim()) {
    // 失败计数 → 熔断联动
    const user = await db.user.update({
      where: { id: userId },
      data: { failCount: { increment: 1 } },
    });
    await audit(userId, traceId, {
      stage: "VERIFY",
      action: "verify.sms_check",
      riskLevel: "RED",
      decision: "BLOCKED",
      detail: { failCount: user.failCount },
    });
    if (user.failCount >= 3) {
      await fuseLock(userId, traceId, "连续 3 次强验证失败");
      return { ok: false, message: "验证码错误次数过多，账户已被安全锁定，请前往柜台或联系客服解锁" };
    }
    return { ok: false, message: `验证码错误（剩余 ${3 - user.failCount} 次机会）` };
  }
  await db.verifyRecord.update({ where: { id: rec.id }, data: { used: true } });
  await db.user.update({ where: { id: userId }, data: { failCount: 0 } });
  await audit(userId, traceId, {
    stage: "VERIFY",
    action: "verify.sms_check",
    riskLevel: "RED",
    decision: "VERIFIED",
    detail: { target: rec.target },
  });
  return { ok: true, message: "强验证通过" };
}

/** 异常熔断：锁定账户 30 分钟（演示） */
export async function fuseLock(userId: string, traceId: string, why: string) {
  const lockUntil = new Date(Date.now() + 30 * 60 * 1000);
  await db.user.update({ where: { id: userId }, data: { status: "LOCKED", lockUntil } });
  await audit(userId, traceId, {
    stage: "FUSE",
    action: "fuse.lock",
    riskLevel: "RED",
    decision: "BLOCKED",
    detail: { why, lockUntil: lockUntil.toISOString() },
  });
}

/** 检查熔断状态 */
export async function checkFuse(userId: string): Promise<{ locked: boolean; message?: string }> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { locked: false };
  if (user.status === "LOCKED") {
    if (user.lockUntil && user.lockUntil < new Date()) {
      await db.user.update({
        where: { id: userId },
        data: { status: "ACTIVE", failCount: 0 },
      });
      return { locked: false };
    }
    return {
      locked: true,
      message: `账户处于安全锁定中（${user.lockUntil?.toLocaleTimeString("zh-CN")} 自动解锁），期间暂停所有资金操作`,
    };
  }
  return { locked: false };
}
