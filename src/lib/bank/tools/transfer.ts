// ============ 工具层：智能转账域 ============
// 能力：按人名/手机号/备注找收款人、转账、定时转账、AA收款、进度查询

import { db } from "@/lib/db";
import { ToolResult } from "../types";
import { audit } from "../audit";

function txNo() {
  return "TX" + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10);
}

/** 收款人解析：支持人名/手机号/备注模糊匹配 */
export async function queryPayee(userId: string, keyword: string): Promise<ToolResult> {
  const payees = await db.payee.findMany({
    where: {
      userId,
      OR: [
        { name: { contains: keyword } },
        { remark: { contains: keyword } },
        { phone: { contains: keyword } },
      ],
    },
    orderBy: { frequent: "desc" },
  });
  return {
    ok: true,
    data: payees.map((p) => ({
      name: p.name,
      remark: p.remark,
      phone: p.phone,
      bank: p.bank,
      accountNo: p.accountNo.slice(-4).padStart(8, "****"),
    })),
    evidence: { source: "Payee", snapshot: JSON.stringify(payees.map((p) => p.id)) },
  };
}

/** 收款人智能解析：精确 → 拆括号 → 模糊，多候选报歧义 */
async function resolvePayee(userId: string, payeeName: string) {
  // 1. 精确（name / remark / phone）
  let p = await db.payee.findFirst({
    where: { userId, OR: [{ name: payeeName }, { remark: payeeName }, { phone: payeeName }] },
  });
  if (p) return { payee: p, ambiguity: null as string | null };
  // 2. 拆掉括号与常见连接："张伟(室友)" → "张伟" / "室友"
  const parts = payeeName.split(/[（）()·,，\s]+/).filter(Boolean);
  for (const part of parts) {
    p = await db.payee.findFirst({
      where: { userId, OR: [{ name: part }, { remark: part }, { phone: part }] },
    });
    if (p) return { payee: p, ambiguity: null };
  }
  // 3. 模糊包含
  const fuzzy = await db.payee.findMany({
    where: {
      userId,
      OR: [
        { name: { contains: payeeName } },
        { remark: { contains: payeeName } },
        { phone: { contains: payeeName } },
        { name: { contains: parts[0] ?? payeeName } },
        { remark: { contains: parts[0] ?? payeeName } },
      ],
    },
    orderBy: { frequent: "desc" },
  });
  if (fuzzy.length === 1) return { payee: fuzzy[0], ambiguity: null };
  if (fuzzy.length > 1) {
    return {
      payee: null,
      ambiguity: `「${payeeName}」匹配到多位收款人：${fuzzy.map((f) => f.name + (f.remark ? `(${f.remark})` : "")).join("、")}，请指明全名`,
    };
  }
  return { payee: null, ambiguity: null };
}

/** 转账执行（已被权限引擎放行/确认/强验证后调用） */
export async function executeTransfer(
  userId: string,
  p: {
    payeeName: string;
    amount: number;
    remark?: string;
    channel?: string;
    traceId: string;
  }
): Promise<ToolResult> {
  const { payee, ambiguity } = await resolvePayee(userId, p.payeeName);
  if (!payee) {
    return {
      ok: false,
      error: ambiguity ?? `未找到收款人「${p.payeeName}」，请先确认收款人信息`,
    };
  }

  const account = await db.account.findFirst({ where: { userId, type: "DEBIT" } });
  if (!account) return { ok: false, error: "未找到可用账户" };

  const usable = account.balance - account.lockedAmt;
  if (p.amount > usable) {
    return { ok: false, error: `可用余额不足（可用 ¥${usable.toFixed(2)}，需 ¥${p.amount.toFixed(2)}）` };
  }

  const no = txNo();
  await db.$transaction(async (tx) => {
    await tx.account.update({
      where: { id: account.id },
      data: { balance: { decrement: p.amount } },
    });
    await tx.transaction.create({
      data: {
        userId,
        accountId: account.id,
        type: "TRANSFER_OUT",
        amount: p.amount,
        direction: "OUT",
        category: "转账",
        merchant: payee.name + (payee.remark ? `（${payee.remark}）` : ""),
        counterparty: payee.accountNo.slice(-4),
        remark: p.remark ?? "",
        status: "SUCCESS",
        occurredAt: new Date(),
      },
    });
    await tx.payee.update({
      where: { id: payee.id },
      data: { frequent: { increment: 1 } },
    });
  });

  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "transfer.execute",
    riskLevel: "RED",
    decision: "ALLOW",
    detail: { payee: payee.name, amount: p.amount, txNo: no, balanceAfter: account.balance - p.amount },
  });

  return {
    ok: true,
    data: {
      txNo: no,
      payee: payee.name,
      remark: p.remark ?? "",
      amount: p.amount,
      balanceAfter: Number((account.balance - p.amount).toFixed(2)),
      arrived: "实时到账",
    },
    evidence: { source: "Transaction", snapshot: no },
  };
}

/** 定时转账（创建计划任务，到点自动执行） */
export async function scheduleTransfer(
  userId: string,
  p: { payeeName: string; amount: number; runAt: string; remark?: string; traceId: string }
): Promise<ToolResult> {
  const { payee, ambiguity } = await resolvePayee(userId, p.payeeName);
  if (!payee) {
    return { ok: false, error: ambiguity ?? `未找到收款人「${p.payeeName}」` };
  }
  const runAt = new Date(p.runAt);
  if (runAt.getTime() < Date.now() + 60_000) {
    return { ok: false, error: "定时时间至少在 1 分钟之后" };
  }
  await db.scheduledTask.create({
    data: {
      userId,
      kind: "SCHEDULED_TRANSFER",
      payload: JSON.stringify({ payeeName: payee.name, amount: p.amount, remark: p.remark ?? "" }),
      runAt,
    },
  });
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "transfer.schedule",
    riskLevel: "YELLOW",
    decision: "ALLOW",
    detail: { payee: payee.name, amount: p.amount, runAt: runAt.toISOString() },
  });
  return {
    ok: true,
    data: {
      payee: payee.name,
      amount: p.amount,
      runAt: runAt.toISOString(),
      note: "到期自动执行；执行时若触发大额阈值将要求补强验证",
    },
    evidence: { source: "ScheduledTask", snapshot: runAt.toISOString() },
  };
}

/** AA 收款：创建收款单，返回每人人均金额 */
export async function aaCollect(
  userId: string,
  p: { participants: string[]; total: number; note?: string; traceId: string }
): Promise<ToolResult> {
  if (p.participants.length < 2) return { ok: false, error: "AA 收款至少需要 2 名成员" };
  const per = Number((p.total / p.participants.length).toFixed(2));
  const orderNo = "OD" + Date.now().toString().slice(-8);
  await db.scheduledTask.create({
    data: {
      userId,
      kind: "AA_COLLECT",
      payload: JSON.stringify({ orderNo, participants: p.participants, total: p.total, per, note: p.note ?? "" }),
      runAt: new Date(Date.now() + 48 * 3600 * 1000), // 48h 收款窗口
    },
  });
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "transfer.aa_collect",
    riskLevel: "YELLOW",
    decision: "ALLOW",
    detail: { participants: p.participants, total: p.total, per },
  });
  return {
    ok: true,
    data: {
      orderNo,
      participants: p.participants,
      total: p.total,
      perPerson: per,
      note: p.note ?? "",
      window: "48 小时",
      link: `aegisbank://aa/${orderNo}`,
    },
    evidence: { source: "ScheduledTask", snapshot: orderNo },
  };
}

/** 转账/任务进度查询 */
export async function queryTransferStatus(userId: string): Promise<ToolResult> {
  const [recent, scheduled] = await Promise.all([
    db.transaction.findMany({
      where: { userId, type: { in: ["TRANSFER_OUT", "TRANSFER_IN"] } },
      orderBy: { occurredAt: "desc" },
      take: 5,
    }),
    db.scheduledTask.findMany({
      where: { userId, kind: { in: ["SCHEDULED_TRANSFER", "AA_COLLECT"] }, executed: false },
      orderBy: { runAt: "asc" },
      take: 5,
    }),
  ]);
  return {
    ok: true,
    data: {
      recent: recent.map((t) => ({
        txNo: "TX" + t.id.slice(-8),
        type: t.type === "TRANSFER_OUT" ? "转出" : "转入",
        amount: t.amount,
        merchant: t.merchant,
        status: t.status === "SUCCESS" ? "成功" : t.status,
        time: t.occurredAt.toISOString(),
      })),
      scheduled: scheduled.map((s) => ({
        kind: s.kind === "SCHEDULED_TRANSFER" ? "定时转账" : "AA收款",
        payload: JSON.parse(s.payload),
        runAt: s.runAt.toISOString(),
      })),
    },
    evidence: { source: "Transaction", snapshot: recent.map((t) => t.id).join(",") },
  };
}
