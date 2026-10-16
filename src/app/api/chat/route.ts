// ============ /api/chat 主对话接口 ============
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { seedIfEmpty } from "@/lib/bank/seed";
import { handleUserTurn } from "@/lib/bank/agent/orchestrator";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { message, sessionId } = (await req.json()) as { message: string; sessionId?: string };
    if (!message || typeof message !== "string" || message.length > 2000) {
      return NextResponse.json({ error: "invalid message" }, { status: 400 });
    }
    // 确保种子数据
    const { userId } = await seedIfEmpty();
    // 会话（无则创建；"new" 强制新建——供测试隔离使用）
    let sid = sessionId;
    if (!sid || sid === "new") {
      if (!sid) {
        const s = await db.chatSession.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
        sid = s?.id ?? (await db.chatSession.create({ data: { userId } })).id;
      } else {
        sid = (await db.chatSession.create({ data: { userId } })).id;
      }
    } else {
      const s = await db.chatSession.findFirst({ where: { id: sid, userId } });
      if (!s) return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    const traceId = crypto.randomUUID();
    const result = await handleUserTurn(userId, sid, message, traceId);
    await db.chatSession.update({ where: { id: sid }, data: { updatedAt: new Date() } });
    return NextResponse.json({ sessionId: sid, traceId, ...result });
  } catch (e) {
    console.error("[chat] error:", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
