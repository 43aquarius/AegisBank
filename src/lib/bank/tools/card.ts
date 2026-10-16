// ============ 工具层：卡片管理域 ============
// 能力：卡申请（虚拟卡）、额度调整、交易限制开关、挂失/解挂、状态查询

import { db } from "@/lib/db";
import { ToolResult } from "../types";
import { audit } from "../audit";

function cardNo() {
  return "6225" + String(Math.floor(1e11 + Math.random() * 9e11));
}

export async function applyVirtualCard(
  userId: string,
  p: { purpose?: string; quota?: number; traceId: string }
): Promise<ToolResult> {
  const no = cardNo();
  await db.card.create({
    data: {
      userId,
      cardNo: no,
      type: "VIRTUAL",
      label: p.purpose ?? "网购虚拟卡",
      status: "ACTIVE",
      quota: p.quota ?? 2000,
      limitDay: p.quota ?? 2000,
      limitOnline: true,
      limitAbroad: false,
    },
  });
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "card.apply_virtual",
    riskLevel: "YELLOW",
    decision: "ALLOW",
    detail: { cardNo: no.slice(-4), purpose: p.purpose },
  });
  return {
    ok: true,
    data: {
      cardNo: no.slice(-4),
      label: p.purpose ?? "网购虚拟卡",
      quota: p.quota ?? 2000,
      note: "虚拟卡已开通，默认关闭境外交易；单日限额已同步设置",
    },
    evidence: { source: "Card", snapshot: no.slice(-4) },
  };
}

export async function adjustCardLimit(
  userId: string,
  p: { cardLabel?: string; cardNo?: string; newLimit: number; traceId: string }
): Promise<ToolResult> {
  const cards = await db.card.findMany({ where: { userId, status: "ACTIVE" } });
  const card = cards.find(
    (c) => (p.cardNo && c.cardNo.endsWith(p.cardNo)) || (p.cardLabel && c.label.includes(p.cardLabel))
  );
  if (!card) return { ok: false, error: "未找到该卡片，可先发送\"卡片状态\"查看名下卡片" };
  if (p.newLimit > 100000) return { ok: false, error: "单日限额上限为 ¥100,000，如需更高请前往柜台" };
  const old = card.limitDay;
  await db.card.update({ where: { id: card.id }, data: { limitDay: p.newLimit } });
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "card.adjust_limit",
    riskLevel: "RED",
    decision: "ALLOW",
    detail: { card: card.label, old, newLimit: p.newLimit },
  });
  return {
    ok: true,
    data: { card: card.label, cardNo: card.cardNo.slice(-4), oldLimit: old, newLimit: p.newLimit },
    evidence: { source: "Card", snapshot: String(p.newLimit) },
  };
}

export async function toggleCardRestriction(
  userId: string,
  p: { cardLabel?: string; cardNo?: string; what: "online" | "abroad"; on: boolean; traceId: string }
): Promise<ToolResult> {
  const cards = await db.card.findMany({ where: { userId, status: "ACTIVE" } });
  const card = cards.find(
    (c) => (p.cardNo && c.cardNo.endsWith(p.cardNo)) || (p.cardLabel && c.label.includes(p.cardLabel))
  );
  if (!card) return { ok: false, error: "未找到该卡片" };
  const field = p.what === "online" ? "limitOnline" : "limitAbroad";
  await db.card.update({ where: { id: card.id }, data: { [field]: p.on } });
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: "card.toggle_restriction",
    riskLevel: "YELLOW",
    decision: "ALLOW",
    detail: { card: card.label, what: p.what, on: p.on },
  });
  return {
    ok: true,
    data: {
      card: card.label,
      cardNo: card.cardNo.slice(-4),
      what: p.what === "online" ? "线上交易" : "境外交易",
      now: p.on ? "已开启" : "已关闭",
    },
    evidence: { source: "Card", snapshot: `${p.what}:${p.on}` },
  };
}

export async function reportCardLost(
  userId: string,
  p: { cardLabel?: string; cardNo?: string; op: "lost" | "unlost"; traceId: string }
): Promise<ToolResult> {
  const cards = await db.card.findMany({ where: { userId } });
  const card = cards.find(
    (c) => (p.cardNo && c.cardNo.endsWith(p.cardNo)) || (p.cardLabel && c.label.includes(p.cardLabel))
  );
  if (!card) return { ok: false, error: "未找到该卡片" };
  if (p.op === "lost") {
    if (card.status === "LOST") return { ok: false, error: "该卡已处于挂失状态" };
    await db.card.update({ where: { id: card.id }, data: { status: "LOST" } });
  } else {
    if (card.status !== "LOST") return { ok: false, error: "该卡未挂失，无需解挂" };
    await db.card.update({ where: { id: card.id }, data: { status: "ACTIVE" } });
  }
  await audit(userId, p.traceId, {
    stage: "EXECUTE",
    action: `card.${p.op}`,
    riskLevel: "RED",
    decision: "ALLOW",
    detail: { card: card.label, op: p.op },
  });
  return {
    ok: true,
    data: {
      card: card.label,
      cardNo: card.cardNo.slice(-4),
      op: p.op === "lost" ? "挂失" : "解挂",
      effect: p.op === "lost" ? "该卡全部交易立即冻结，绑定该卡的代扣将暂停" : "该卡交易能力已恢复",
    },
    evidence: { source: "Card", snapshot: `${p.op}` },
  };
}

export async function queryCardStatus(userId: string): Promise<ToolResult> {
  const cards = await db.card.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return {
    ok: true,
    data: cards.map((c) => ({
      cardNo: c.cardNo.slice(-4),
      label: c.label,
      type: c.type === "DEBIT" ? "储蓄卡" : c.type === "VIRTUAL" ? "虚拟卡" : "信用卡",
      status: c.status === "ACTIVE" ? "正常" : c.status === "LOST" ? "已挂失" : c.status === "FROZEN" ? "已冻结" : c.status,
      limitDay: c.limitDay,
      limitOnline: c.limitOnline,
      limitAbroad: c.limitAbroad,
    })),
    evidence: { source: "Card", snapshot: cards.map((c) => c.status).join(",") },
  };
}
