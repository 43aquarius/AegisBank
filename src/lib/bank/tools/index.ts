// ============ 工具注册表 + 沙箱执行器 ============
// 赛题安全机制5：沙箱环境 —— 工具在白名单+参数强校验+审计+超时的受控环境运行

import { z } from "zod";
import { db } from "@/lib/db";
import { ToolResult } from "../types";
import { audit } from "../audit";
import * as transfer from "./transfer";
import * as bill from "./bill";
import * as finance from "./finance";
import * as card from "./card";
import * as subscription from "./subscription";

// ---------- 参数 Schema（沙箱强校验） ----------
const S = {
  keyword: z.string().min(1).max(40),
  payeeName: z.string().min(1).max(40),
  amount: z.number().positive().max(1_000_000),
  remark: z.string().max(60).optional(),
  runAt: z.string().min(8),
  participants: z.array(z.string().min(1).max(30)).min(2).max(20),
  total: z.number().positive().max(500_000),
  note: z.string().max(60).optional(),
  days: z.number().int().min(1).max(365).optional(),
  category: z.string().max(20).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  period: z.enum(["month", "year"]),
  codes: z.array(z.string().max(20)).optional(),
  names: z.array(z.string().max(40)).optional(),
  answers: z.array(z.number().int().min(2).max(5)).length(4),
  code: z.string().max(20).optional(),
  name: z.string().max(40).optional(),
  purpose: z.string().max(30).optional(),
  quota: z.number().int().min(100).max(500_000).optional(),
  cardLabel: z.string().max(30).optional(),
  cardNo: z.string().max(19).optional(),
  newLimit: z.number().int().min(100).max(100_000),
  what: z.enum(["online", "abroad"]),
  on: z.boolean(),
  op: z.enum(["lost", "unlost"]),
  merchant: z.string().min(1).max(40),
  daysAhead: z.number().int().min(1).max(30).optional(),
  horizon: z.string().max(20).optional(),
  person: z.string().max(20).optional(),
  date: z.string().min(8).optional(),
  budget: z.number().positive().max(500_000).optional(),
  when: z.string().min(2).max(80),
  action: z.string().min(2).max(120),
};

// ---------- 工具定义 ----------
export interface ToolDef {
  action: string;
  desc: string;
  schema: z.ZodType<Record<string, unknown>>;
  // 沙箱标记：该工具是否触碰资金/账户状态（RED 工具必须在权限引擎放行后才可被调用）
  touchesMoney: boolean;
  fn: (userId: string, params: Record<string, unknown>, traceId: string) => Promise<ToolResult>;
}

export const TOOL_REGISTRY: Record<string, ToolDef> = {
  // -- 转账域 --
  "transfer.queryPayee": {
    action: "transfer.queryPayee",
    desc: "按人名/手机号/备注搜索收款人",
    schema: z.object({ keyword: S.keyword }),
    touchesMoney: false,
    fn: (uid, p) => transfer.queryPayee(uid, String(p.keyword)),
  },
  "transfer.execute": {
    action: "transfer.execute",
    desc: "执行转账",
    schema: z.object({ payeeName: S.payeeName, amount: S.amount, remark: S.remark }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      transfer.executeTransfer(uid, {
        payeeName: String(p.payeeName),
        amount: Number(p.amount),
        remark: p.remark ? String(p.remark) : undefined,
        traceId: tid,
      }),
  },
  "transfer.schedule": {
    action: "transfer.schedule",
    desc: "创建定时转账",
    schema: z.object({ payeeName: S.payeeName, amount: S.amount, runAt: S.runAt, remark: S.remark }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      transfer.scheduleTransfer(uid, {
        payeeName: String(p.payeeName),
        amount: Number(p.amount),
        runAt: String(p.runAt),
        remark: p.remark ? String(p.remark) : undefined,
        traceId: tid,
      }),
  },
  "transfer.aaCollect": {
    action: "transfer.aaCollect",
    desc: "发起AA收款",
    schema: z.object({ participants: S.participants, total: S.total, note: S.note }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      transfer.aaCollect(uid, {
        participants: p.participants as string[],
        total: Number(p.total),
        note: p.note ? String(p.note) : undefined,
        traceId: tid,
      }),
  },
  "transfer.queryStatus": {
    action: "transfer.queryStatus",
    desc: "查询转账与任务进度",
    schema: z.object({}),
    touchesMoney: false,
    fn: (uid) => transfer.queryTransferStatus(uid),
  },
  // -- 账单域 --
  "bill.queryBalance": {
    action: "bill.queryBalance",
    desc: "查询账户余额",
    schema: z.object({}),
    touchesMoney: false,
    fn: (uid) => bill.queryBalance(uid),
  },
  "bill.queryTransactions": {
    action: "bill.queryTransactions",
    desc: "查询交易流水",
    schema: z.object({ days: S.days, category: S.category, limit: S.limit }),
    touchesMoney: false,
    fn: (uid, p) =>
      bill.queryTransactions(uid, {
        days: p.days ? Number(p.days) : 30,
        category: p.category ? String(p.category) : undefined,
        limit: p.limit ? Number(p.limit) : 50,
      }),
  },
  "bill.categorize": {
    action: "bill.categorize",
    desc: "消费分类统计",
    schema: z.object({ days: S.days }),
    touchesMoney: false,
    fn: (uid, p) => bill.categorizeSpending(uid, p.days ? Number(p.days) : 30),
  },
  "bill.detectAnomaly": {
    action: "bill.detectAnomaly",
    desc: "异常交易识别",
    schema: z.object({ days: S.days }),
    touchesMoney: false,
    fn: (uid, p) => bill.detectAnomaly(uid, p.days ? Number(p.days) : 30),
  },
  "bill.report": {
    action: "bill.report",
    desc: "月度/年度账单报告",
    schema: z.object({ period: S.period }),
    touchesMoney: false,
    fn: (uid, p) => bill.generateReport(uid, p.period === "year" ? "year" : "month"),
  },
  // -- 理财域 --
  "finance.recommend": {
    action: "finance.recommend",
    desc: "理财产品推荐",
    schema: z.object({ horizon: S.horizon, amount: z.number().positive().optional() }),
    touchesMoney: false,
    fn: (uid) => finance.recommendProducts(uid, {}),
  },
  "finance.compare": {
    action: "finance.compare",
    desc: "理财产品对比",
    schema: z.object({ codes: S.codes, names: S.names }),
    touchesMoney: false,
    fn: (uid, p) =>
      finance.compareProducts(uid, {
        codes: p.codes as string[] | undefined,
        names: p.names as string[] | undefined,
      }),
  },
  "finance.saveRiskAssessment": {
    action: "finance.saveRiskAssessment",
    desc: "保存风险测评结果",
    schema: z.object({ answers: S.answers }),
    touchesMoney: false,
    fn: (uid, p, tid) => finance.saveRiskAssessment(uid, p.answers as number[], tid),
  },
  "finance.purchase": {
    action: "finance.purchase",
    desc: "理财产品申购",
    schema: z.object({ code: S.code, name: S.name, amount: S.amount }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      finance.purchaseProduct(uid, {
        code: p.code ? String(p.code) : undefined,
        name: p.name ? String(p.name) : undefined,
        amount: Number(p.amount),
        traceId: tid,
      }),
  },
  "finance.redeem": {
    action: "finance.redeem",
    desc: "理财产品赎回",
    schema: z.object({ code: S.code, name: S.name, amount: z.number().positive().optional() }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      finance.redeemProduct(uid, {
        code: p.code ? String(p.code) : undefined,
        name: p.name ? String(p.name) : undefined,
        amount: p.amount ? Number(p.amount) : undefined,
        traceId: tid,
      }),
  },
  "finance.portfolio": {
    action: "finance.portfolio",
    desc: "持仓与收益查询",
    schema: z.object({}),
    touchesMoney: false,
    fn: (uid) => finance.queryPortfolio(uid),
  },
  // -- 卡片域 --
  "card.applyVirtual": {
    action: "card.applyVirtual",
    desc: "申请虚拟卡",
    schema: z.object({ purpose: S.purpose, quota: S.quota }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      card.applyVirtualCard(uid, {
        purpose: p.purpose ? String(p.purpose) : undefined,
        quota: p.quota ? Number(p.quota) : undefined,
        traceId: tid,
      }),
  },
  "card.adjustLimit": {
    action: "card.adjustLimit",
    desc: "调整单日交易限额",
    schema: z.object({ cardLabel: S.cardLabel, cardNo: S.cardNo, newLimit: S.newLimit }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      card.adjustCardLimit(uid, {
        cardLabel: p.cardLabel ? String(p.cardLabel) : undefined,
        cardNo: p.cardNo ? String(p.cardNo) : undefined,
        newLimit: Number(p.newLimit),
        traceId: tid,
      }),
  },
  "card.toggleRestriction": {
    action: "card.toggleRestriction",
    desc: "开关线上/境外交易",
    schema: z.object({ cardLabel: S.cardLabel, cardNo: S.cardNo, what: S.what, on: S.on }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      card.toggleCardRestriction(uid, {
        cardLabel: p.cardLabel ? String(p.cardLabel) : undefined,
        cardNo: p.cardNo ? String(p.cardNo) : undefined,
        what: p.what as "online" | "abroad",
        on: Boolean(p.on),
        traceId: tid,
      }),
  },
  "card.reportLost": {
    action: "card.reportLost",
    desc: "卡片挂失/解挂",
    schema: z.object({ cardLabel: S.cardLabel, cardNo: S.cardNo, op: S.op }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      card.reportCardLost(uid, {
        cardLabel: p.cardLabel ? String(p.cardLabel) : undefined,
        cardNo: p.cardNo ? String(p.cardNo) : undefined,
        op: p.op as "lost" | "unlost",
        traceId: tid,
      }),
  },
  "card.status": {
    action: "card.status",
    desc: "卡片状态查询",
    schema: z.object({}),
    touchesMoney: false,
    fn: (uid) => card.queryCardStatus(uid),
  },
  // -- 订阅域 --
  "sub.detect": {
    action: "sub.detect",
    desc: "扫描识别订阅扣费",
    schema: z.object({}),
    touchesMoney: false,
    fn: (uid) => subscription.detectSubscriptions(uid),
  },
  "sub.list": {
    action: "sub.list",
    desc: "订阅清单",
    schema: z.object({}),
    touchesMoney: false,
    fn: (uid) => subscription.listSubscriptions(uid),
  },
  "sub.cancel": {
    action: "sub.cancel",
    desc: "取消订阅",
    schema: z.object({ merchant: S.merchant }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      subscription.cancelSubscription(uid, { merchant: String(p.merchant), traceId: tid }),
  },
  "sub.remind": {
    action: "sub.remind",
    desc: "设置续费提醒",
    schema: z.object({ merchant: z.string().max(40).optional(), daysAhead: S.daysAhead }),
    touchesMoney: false,
    fn: (uid, p, tid) =>
      subscription.setRenewReminder(uid, {
        merchant: p.merchant ? String(p.merchant) : undefined,
        daysAhead: p.daysAhead ? Number(p.daysAhead) : undefined,
        traceId: tid,
      }),
  },
  // -- 跨场景域 --
  "cross.birthdayPlan": {
    action: "cross.birthdayPlan",
    desc: "生日资金规划（锁资金+订购鲜花蛋糕）",
    schema: z.object({ person: S.person, date: S.date, budget: S.budget }),
    touchesMoney: true,
    fn: (uid, p, tid) =>
      subscription.createBirthdayPlan(uid, {
        person: p.person ? String(p.person) : undefined,
        date: p.date ? String(p.date) : undefined,
        budget: p.budget ? Number(p.budget) : undefined,
        traceId: tid,
      }),
  },
  "cross.customPlan": {
    action: "cross.customPlan",
    desc: "创建自定义联动计划",
    schema: z.object({ when: S.when, action: S.action }),
    touchesMoney: false,
    fn: (uid, p, tid) =>
      subscription.createCustomPlan(uid, {
        when: String(p.when),
        action: String(p.action),
        traceId: tid,
      }),
  },
};

// ---------- 沙箱执行器 ----------
const TOOL_TIMEOUT_MS = 8000;

/**
 * 沙箱执行：
 *  1. 白名单校验（未注册工具直接拒绝）
 *  2. zod 参数强校验（防参数注入/类型攻击）
 *  3. 超时熔断
 *  4. 审计留痕
 */
export async function sandboxExec(
  userId: string,
  action: string,
  params: Record<string, unknown>,
  traceId: string
): Promise<ToolResult> {
  const def = TOOL_REGISTRY[action];
  if (!def) {
    await audit(userId, traceId, {
      stage: "SECURITY",
      action: `sandbox.unknown_tool:${action}`,
      riskLevel: "RED",
      decision: "BLOCKED",
      detail: { params: JSON.stringify(params).slice(0, 200) },
    });
    return { ok: false, error: `工具「${action}」不在白名单内，沙箱已拒绝执行` };
  }
  const parsed = def.schema.safeParse(params);
  if (!parsed.success) {
    await audit(userId, traceId, {
      stage: "SECURITY",
      action: `sandbox.param_rejected:${action}`,
      riskLevel: "YELLOW",
      decision: "BLOCKED",
      detail: { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`) },
    });
    return {
      ok: false,
      error: `参数校验未通过：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`,
    };
  }
  try {
    const result = await Promise.race([
      def.fn(userId, parsed.data as Record<string, unknown>, traceId),
      new Promise<ToolResult>((_, rej) =>
        setTimeout(() => rej(new Error(`工具执行超时（>${TOOL_TIMEOUT_MS}ms），沙箱已中断`)), TOOL_TIMEOUT_MS)
      ),
    ]);
    await audit(userId, traceId, {
      stage: "EXECUTE",
      action,
      riskLevel: def.touchesMoney ? "RED" : "GREEN",
      decision: result.ok ? "ALLOW" : "DENY",
      detail: { ok: result.ok, error: result.error?.slice(0, 200) },
    });
    return result;
  } catch (e) {
    await audit(userId, traceId, {
      stage: "SECURITY",
      action: `sandbox.error:${action}`,
      riskLevel: "YELLOW",
      decision: "BLOCKED",
      detail: { error: String(e).slice(0, 200) },
    });
    return { ok: false, error: e instanceof Error ? e.message : "工具执行异常" };
  }
}
