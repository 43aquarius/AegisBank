// ============ 工具层：理财操作域 ============
// 能力：产品推荐、产品对比、风险测评、申购、赎回、持仓查询

import { db } from "@/lib/db";
import { ToolResult } from "../types";
import { audit } from "../audit";

export async function recommendProducts(userId: string, p: { horizon?: string; amount?: number } = {}): Promise<ToolResult> {
  const user = await db.user.findUnique({ where: { id: userId } });
  const products = await db.financeProduct.findMany({ where: { active: true } });
  const riskLevel = user?.riskLevel ?? 0;
  let matched = products;
  let riskNote = "";
  if (riskLevel === 0) {
    riskNote = "您尚未完成风险测评，以下仅展示 R1-R2 低风险产品，建议先完成风险测评（发送\"风险测评\"）";
    matched = products.filter((x) => x.riskLevel <= 2);
  } else {
    // 适当性管理：只推荐不高于用户风险等级的产品
    matched = products.filter((x) => x.riskLevel <= riskLevel);
    riskNote = `已按您的风险测评等级（R${riskLevel}）进行适当性匹配，仅展示 R${riskLevel} 及以下产品`;
  }
  return {
    ok: true,
    data: {
      userRiskLevel: riskLevel,
      riskNote,
      products: matched.map((x) => ({
        code: x.code,
        name: x.name,
        type: x.type,
        riskLevel: x.riskLevel,
        minAmount: x.minAmount,
        expectedRet: x.expectedRet,
        lockDays: x.lockDays,
        tags: x.tags.split(",").filter(Boolean),
        desc: x.desc,
      })),
    },
    evidence: { source: "FinanceProduct", snapshot: matched.map((x) => x.code).join(",") },
  };
}

export async function compareProducts(userId: string, p: { codes?: string[]; names?: string[] }): Promise<ToolResult> {
  const products = await db.financeProduct.findMany({ where: { active: true } });
  const target = products.filter((x) => {
    const codeHit = p.codes?.includes(x.code);
    const nameHit = p.names?.some(
      (n) => x.name.includes(n) || n.includes(x.name) || normalizeName(x.name).includes(normalizeName(n))
    );
    return codeHit || nameHit;
  });
  if (target.length < 2) {
    return { ok: false, error: "对比至少需要两款产品，请指定产品名称（如：对比活期+和稳利90天）" };
  }
  return {
    ok: true,
    data: {
      products: target.map((x) => ({
        code: x.code,
        name: x.name,
        riskLevel: x.riskLevel,
        expectedRet: x.expectedRet,
        minAmount: x.minAmount,
        lockDays: x.lockDays,
        type: x.type,
        desc: x.desc,
      })),
      dimensions: ["风险等级", "预期年化", "起购金额", "锁定期"],
    },
    evidence: { source: "FinanceProduct", snapshot: target.map((x) => x.code).join(",") },
  };
}

/** 风险测评（8题精简为对话式4题，答案映射1-5级） */
export const RISK_QUESTIONS = [
  { q: "1/4 您的年龄范围？", options: [["30岁以下", 5], ["30-45岁", 4], ["46-60岁", 3], ["60岁以上", 2]] },
  { q: "2/4 可用于理财的资金占您总资产的比例？", options: [["70%以上", 5], ["50%-70%", 4], ["30%-50%", 3], ["30%以下", 2]] },
  { q: "3/4 若持有的理财产品一个月内亏损达到 10%，您会？", options: [["加仓摊低成本", 5], ["继续持有观察", 4], ["部分赎回", 3], ["立即全部赎回", 2]] },
  { q: "4/4 您期望的投资期限？", options: [["3年以上", 5], ["1-3年", 4], ["半年-1年", 3], ["半年以内", 2]] },
] as const;

export async function saveRiskAssessment(userId: string, answers: number[], traceId: string): Promise<ToolResult> {
  const avg = answers.reduce((s, a) => s + a, 0) / answers.length;
  const level = Math.max(1, Math.min(5, Math.round(avg)));
  await db.user.update({ where: { id: userId }, data: { riskLevel: level } });
  await audit(userId, traceId, {
    stage: "EXECUTE",
    action: "finance.risk_assess",
    riskLevel: "YELLOW",
    decision: "ALLOW",
    detail: { answers, level },
  });
  const NAMES: Record<number, string> = { 1: "保守型", 2: "稳健型", 3: "平衡型", 4: "成长型", 5: "进取型" };
  return {
    ok: true,
    data: {
      level,
      levelName: NAMES[level],
      suggestion:
        level <= 2
          ? "建议以 R1-R2 低风险产品为主（现金管理类、短债），控制权益类仓位"
          : level === 3
            ? "可配置 R1-R3 组合：现金管理打底 + 固收增强"
            : "可适当配置 R3-R4 产品，注意单品类上限与锁定期安排",
    },
    evidence: { source: "User", snapshot: String(level) },
  };
}

export function normalizeName(s: string): string {
  return s.replace(/[\s·・-]/g, "");
}

export async function purchaseProduct(
  userId: string,
  p: { code?: string; name?: string; amount: number; traceId: string }
): Promise<ToolResult> {
  const products = await db.financeProduct.findMany({ where: { active: true } });
  const prod = products.find(
    (x) =>
      (p.code && x.code === p.code) ||
      (p.name && (x.name.includes(p.name) || p.name.includes(x.name) || normalizeName(x.name).includes(normalizeName(p.name))))
  );
  if (!prod) return { ok: false, error: "未找到该理财产品，可发送\"理财产品推荐\"查看在售产品" };

  const user = await db.user.findUnique({ where: { id: userId } });
  // 适当性校验：产品风险等级不得高于用户等级（未测评只允许R1）
  const userLevel = user?.riskLevel ?? 0;
  if (prod.riskLevel > Math.max(userLevel, 1)) {
    return {
      ok: false,
      error: `适当性管理拦截：产品风险等级 R${prod.riskLevel} 高于您的测评等级 R${userLevel}，${userLevel === 0 ? "请先完成风险测评" : "不匹配您的风险承受能力"}`,
    };
  }
  if (p.amount < prod.minAmount) {
    return { ok: false, error: `起购金额 ¥${prod.minAmount}，当前 ¥${p.amount}` };
  }
  const account = await db.account.findFirst({ where: { userId, type: "DEBIT" } });
  if (!account) return { ok: false, error: "未找到可用账户" };
  const usable = account.balance - account.lockedAmt;
  if (p.amount > usable) {
    return { ok: false, error: `可用余额不足（可用 ¥${usable.toFixed(2)}）` };
  }
  const confirmNo = "VD" + Date.now().toString().slice(-8);
  await db.$transaction(async (tx) => {
    await tx.account.update({ where: { id: account.id }, data: { balance: { decrement: p.amount } } });
    await tx.holding.create({
      data: {
        userId,
        productId: prod.id,
        amount: p.amount,
        redeemable: prod.lockDays
          ? new Date(Date.now() + prod.lockDays * 24 * 3600 * 1000)
          : new Date(),
      },
    });
    await tx.transaction.create({
      data: {
        userId,
        accountId: account.id,
        type: "FINANCE_BUY",
        amount: p.amount,
        direction: "OUT",
        category: "理财",
        merchant: prod.name,
        remark: `申购确认单 ${confirmNo}`,
        occurredAt: new Date(),
      },
    });
  });
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "finance.purchase",
    riskLevel: "RED",
    decision: "ALLOW",
    detail: { product: prod.name, amount: p.amount, confirmNo },
  });
  return {
    ok: true,
    data: {
      confirmNo,
      product: prod.name,
      amount: p.amount,
      expectedRet: prod.expectedRet,
      lockDays: prod.lockDays,
      balanceAfter: Number((account.balance - p.amount).toFixed(2)),
    },
    evidence: { source: "Holding", snapshot: confirmNo },
  };
}

export async function redeemProduct(
  userId: string,
  p: { code?: string; name?: string; amount?: number; traceId: string }
): Promise<ToolResult> {
  const holdings = await db.holding.findMany({
    where: { userId, status: "HELD" },
    include: { product: true },
  });
  const target = holdings.filter(
    (h) =>
      (p.code && h.product.code === p.code) ||
      (p.name &&
        (h.product.name.includes(p.name) ||
          p.name.includes(h.product.name) ||
          normalizeName(h.product.name).includes(normalizeName(p.name))))
  );
  if (target.length === 0) return { ok: false, error: "未找到该产品持仓" };
  const h = target[0];
  if (h.redeemable && h.redeemable > new Date()) {
    return {
      ok: false,
      error: `锁定期未满，${h.redeemable.toLocaleDateString("zh-CN")} 后可赎回（提前赎回将损失收益，如确需请前往柜台办理）`,
    };
  }
  const amount = p.amount ?? h.amount;
  if (amount > h.amount) return { ok: false, error: `赎回金额超出持仓（持有 ¥${h.amount.toFixed(2)}）` };
  const account = await db.account.findFirst({ where: { userId, type: "DEBIT" } });
  if (!account) return { ok: false, error: "未找到可用账户" };
  const full = amount >= h.amount;
  await db.$transaction(async (tx) => {
    await tx.account.update({ where: { id: account.id }, data: { balance: { increment: amount } } });
    if (full) {
      await tx.holding.update({ where: { id: h.id }, data: { status: "REDEEMED" } });
    } else {
      await tx.holding.update({ where: { id: h.id }, data: { amount: { decrement: amount } } });
    }
    await tx.transaction.create({
      data: {
        userId,
        accountId: account.id,
        type: "FINANCE_SELL",
        amount,
        direction: "IN",
        category: "理财",
        merchant: h.product.name,
        remark: "赎回到账（活期实时/次日）",
        occurredAt: new Date(),
      },
    });
  });
  const no = "VD" + Date.now().toString().slice(-8);
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "finance.redeem",
    riskLevel: "RED",
    decision: "ALLOW",
    detail: { product: h.product.name, amount },
  });
  return {
    ok: true,
    data: { confirmNo: no, product: h.product.name, amount, balanceAfter: Number((account.balance + amount).toFixed(2)) },
    evidence: { source: "Holding", snapshot: no },
  };
}

export async function queryPortfolio(userId: string): Promise<ToolResult> {
  const holdings = await db.holding.findMany({
    where: { userId, status: "HELD" },
    include: { product: true },
  });
  const total = holdings.reduce((s, h) => s + h.amount, 0);
  // 模拟收益（活期按日万分之一、定期按年化折算）
  const now = Date.now();
  let estProfit = 0;
  for (const h of holdings) {
    const days = Math.min((now - h.confirmedAt.getTime()) / 86400000, 365);
    estProfit += (h.amount * h.product.expectedRet / 100 / 365) * days;
  }
  return {
    ok: true,
    data: {
      total: Number(total.toFixed(2)),
      estProfit: Number(estProfit.toFixed(2)),
      holdings: holdings.map((h) => ({
        name: h.product.name,
        riskLevel: h.product.riskLevel,
        amount: h.amount,
        expectedRet: h.product.expectedRet,
        redeemable: h.redeemable?.toISOString() ?? null,
        daysHeld: Math.floor((now - h.confirmedAt.getTime()) / 86400000),
      })),
    },
    evidence: { source: "Holding", snapshot: total.toFixed(2) },
  };
}
