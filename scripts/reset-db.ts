// ============ 数据重置脚本：清空并重新灌入种子数据 ============
// 用法：bun run scripts/reset-db.ts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // 按依赖顺序清空
  await db.auditLog.deleteMany();
  await db.verifyRecord.deleteMany();
  await db.agentTask.deleteMany();
  await db.chatMessage.deleteMany();
  await db.chatSession.deleteMany();
  await db.noticeMessage.deleteMany();
  await db.scheduledTask.deleteMany();
  await db.transaction.deleteMany();
  await db.holding.deleteMany();
  await db.subscription.deleteMany();
  await db.card.deleteMany();
  await db.payee.deleteMany();
  await db.account.deleteMany();
  await db.financeProduct.deleteMany();
  await db.user.deleteMany();
  console.log("✅ 数据库已清空（下次访问 /api/chat 或 /api/session 时自动重新 seed）");
}

main().finally(() => db.$disconnect());
