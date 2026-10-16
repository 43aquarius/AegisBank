// ============ /api/verify 强验证码提交 ============
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { seedIfEmpty } from "@/lib/bank/seed";
import { completeVerify } from "@/lib/bank/agent/orchestrator";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { code, sessionId } = (await req.json()) as { code: string; sessionId: string };
    if (!code || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "验证码格式不正确（6位数字）" }, { status: 400 });
    }
    const { userId } = await seedIfEmpty();
    const s = await db.chatSession.findFirst({ where: { id: sessionId, userId } });
    if (!s) return NextResponse.json({ error: "session not found" }, { status: 404 });
    const traceId = crypto.randomUUID();
    const result = await completeVerify(userId, sessionId, code, traceId);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[verify] error:", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
