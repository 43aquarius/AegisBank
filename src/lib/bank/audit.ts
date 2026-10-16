// ============ AegisBank 审计日志 ============
// 赛题要求：所有关键操作需记录完整的决策链路与执行日志

import { db } from "@/lib/db";
import { AuditEntry } from "./types";

export async function audit(
  userId: string,
  traceId: string,
  entry: AuditEntry
) {
  try {
    await db.auditLog.create({
      data: {
        userId,
        traceId,
        stage: entry.stage,
        action: entry.action,
        riskLevel: entry.riskLevel ?? null,
        decision: entry.decision,
        detail: JSON.stringify(entry.detail ?? {}),
      },
    });
  } catch (e) {
    // 审计失败不应阻断主流程，但必须 console 留痕
    console.error("[AUDIT-FAIL]", traceId, entry.action, e);
  }
}

/** 按 traceId 拉取完整决策链路（安全中心展示用） */
export async function getTraceChain(traceId: string) {
  return db.auditLog.findMany({
    where: { traceId },
    orderBy: { createdAt: "asc" },
  });
}
