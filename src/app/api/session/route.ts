// ============ /api/session 会话与历史 ============
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { seedIfEmpty } from "@/lib/bank/seed";

export const dynamic = "force-dynamic";

// GET: 拉取会话历史 + 用户资产概览（进入APP时的首屏数据）
export async function GET(req: NextRequest) {
  try {
    const { userId } = await seedIfEmpty();
    const sessionId = req.nextUrl.searchParams.get("sessionId");
    let session;
    if (sessionId) {
      session = await db.chatSession.findFirst({ where: { id: sessionId, userId } });
    } else {
      session = await db.chatSession.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
    }
    if (!session) {
      session = await db.chatSession.create({ data: { userId } });
    }
    const messages = await db.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
    });
    // 资产概览（顶部卡片）
    const accounts = await db.account.findMany({ where: { userId } });
    const holdings = await db.holding.findMany({ where: { userId, status: "HELD" }, include: { product: true } });
    const user = await db.user.findUnique({ where: { id: userId } });
    const total = accounts.reduce((s, a) => s + a.balance, 0);
    const finance = holdings.reduce((s, h) => s + h.amount, 0);
    const notices = await db.noticeMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return NextResponse.json({
      sessionId: session.id,
      user: { name: user?.name, avatar: user?.avatarEmoji, riskLevel: user?.riskLevel, status: user?.status },
      overview: {
        total: Number(total.toFixed(2)),
        finance: Number(finance.toFixed(2)),
        cardNo: accounts[0]?.accountNo.slice(-4) ?? "----",
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        payload: m.payload ? JSON.parse(m.payload) : null,
        createdAt: m.createdAt.toISOString(),
      })),
      notices: notices.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, read: n.read, createdAt: n.createdAt.toISOString() })),
    });
  } catch (e) {
    console.error("[session] error:", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
