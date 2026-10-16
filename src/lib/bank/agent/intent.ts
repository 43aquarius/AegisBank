// ============ Agent：意图理解（NLU） ============
// 基于 LLM 的意图识别 + 槽位提取 + 追问判定
// 支持：模糊表达、省略上下文、隐含意图、复合任务标记

import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";
import { IntentResult, IntentType } from "../types";
import { audit } from "../audit";
import { ruleNLU } from "./ruleNLU";

const ALL_INTENTS: IntentType[] = [
  "chitchat", "out_of_scope", "help",
  "transfer.query_payee", "transfer.execute", "transfer.schedule", "transfer.aa_collect", "transfer.query_status",
  "bill.query_balance", "bill.transactions", "bill.categorize", "bill.anomaly", "bill.report",
  "finance.recommend", "finance.compare", "finance.risk_assess", "finance.purchase", "finance.redeem", "finance.portfolio",
  "card.apply", "card.adjust_limit", "card.toggle_restriction", "card.report_lost", "card.status",
  "sub.detect", "sub.remind", "sub.cancel", "sub.list",
  "cross.birthday_plan", "cross.custom_plan",
  "sys.security_center", "sys.interrupt", "sys.task_status",
];

const SYSTEM_PROMPT = `你是 AegisBank 银行 AI 智能体的意图识别引擎。分析用户消息，输出严格的 JSON。

【意图清单】(intent 只能取以下值)
- chitchat: 问候/闲聊/感谢
- out_of_scope: 与银行 Agent 职责无关或有害请求（如套取隐私、闲聊股票推荐、写代码等）
- help: 询问你能做什么
- transfer.query_payee: 查找收款人 | transfer.execute: 转账(现在执行) | transfer.schedule: 定时/预约转账 | transfer.aa_collect: AA收款/群收款 | transfer.query_status: 查转账进度/记录
- bill.query_balance: 余额查询 | bill.transactions: 流水/明细查询 | bill.categorize: 消费分类/构成分析 | bill.anomaly: 异常/可疑交易识别 | bill.report: 月度/年度账单报告
- finance.recommend: 理财产品推荐 | finance.compare: 产品对比 | finance.risk_assess: 风险测评 | finance.purchase: 理财申购 | finance.redeem: 理财赎回 | finance.portfolio: 持仓/收益查询
- card.apply: 申请卡片(虚拟卡) | card.adjust_limit: 调整限额/额度 | card.toggle_restriction: 开关线上/境外交易 | card.report_lost: 挂失/解挂 | card.status: 卡片状态
- sub.detect: 识别订阅/代扣 | sub.remind: 续费提醒 | sub.cancel: 取消订阅 | sub.list: 订阅清单
- cross.birthday_plan: 生日规划类(锁定资金+订购鲜花蛋糕等联动) | cross.custom_plan: 其他自定义联动计划
- sys.security_center: 查看安全中心/审计日志 | sys.interrupt: 打断/取消当前任务 | sys.task_status: 任务进度

【槽位提取规则】
- amount: 金额数字(元)。"五百"→500，"1k"→1000，"两万五"→25000
- payeeName: 收款人姓名或称呼(妈妈/室友/张伟/139xxx手机号)
- date/runAt: ISO 日期时间。"明天9点"→明天09:00，"下月1号"→下月1日 09:00，"周五"→本周五
- participants: AA收款参与者姓名数组
- period: "month"|"year"
- merchant: 商户/订阅名
- person: 生日规划的祝福对象; budget: 锁定预算
- cardLabel: 卡片标签(主力卡/虚拟卡)
- compareItems: 对比的产品名数组
- op: 挂失为"lost"，解挂为"unlost"
- horizon: 投资期限描述

【关键判定】
1. 复合任务(一句话多个诉求，如"查下余额然后把500转给妈妈") → compound=true，slots.tasks 列出每个子诉求
2. 隐含意图：如"这个月花了多少"→ bill.categorize；"我是不是被重复扣费了"→ bill.anomaly
3. 省略上下文：如果用户说"确认"/"是的"/"继续"等，intent 填 "sys.confirm"，由编排器结合上下文处理（若上一轮无待确认任务则按 chitchat 处理）
4. 拒绝办理与提问建议的区分：用户只是"问"信息(如"我该怎么办")不是指令时，选择最接近的查询类意图
5. 用户想中断/算了/停止 → sys.interrupt

【输出 JSON 格式】
{"intent":"...","confidence":0.0-1.0,"slots":{...},"utterance":"归一化后的用户诉求","needsClarify":["缺失且必要的槽位名"],"compound":false,"subTasks":[{"intent":"...","slots":{...}}]}

只输出 JSON，不要任何其他文字。`;

export async function understandIntent(
  userId: string,
  sessionId: string,
  userText: string,
  traceId: string
): Promise<IntentResult> {
  // 第一层：规则快速通道（精确指令模式，快、省配额、不依赖外部服务）
  const ruled = ruleNLU(userText);
  if (ruled) {
    await audit(userId, traceId, {
      stage: "INTENT",
      action: "nlu.rule_fastpath",
      decision: "ALLOW",
      detail: { intent: ruled.intent, slots: ruled.slots },
    });
    return ruled;
  }

  // 上下文注入：近 8 条消息 + 用户基础信息 + 收款人列表（帮助消解"妈妈"是谁）
  const history = await db.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  const historyText = history
    .reverse()
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 100)}`)
    .join("\n");
  const payees = await db.payee.findMany({ where: { userId }, orderBy: { frequent: "desc" }, take: 8 });
  const payeeText = payees.map((p) => `${p.name}(${p.remark ?? ""})`).join("、");
  const user = await db.user.findUnique({ where: { id: userId } });
  const now = new Date();
  const ctxText = `【当前时间】${now.toLocaleString("zh-CN", { hour12: false })}（${["周日","周一","周二","周三","周四","周五","周六"][now.getDay()]}）
【用户】${user?.name ?? ""}，风险测评等级：${user?.riskLevel ?? 0}级${user?.riskLevel ? "(已测评)" : "(未测评)"}
【常用收款人】${payeeText}
【近期对话】
${historyText || "（无）"}`;

  try {
    const zai = await ZAI.create();
    // LLM 调用带一次重试（抗限流抖动）
    let parsed: {
      intent: string;
      confidence: number;
      slots: Record<string, unknown>;
      utterance: string;
      needsClarify?: string[];
      compound?: boolean;
      subTasks?: { intent: string; slots: Record<string, unknown> }[];
    } | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      const completion = await zai.chat.completions.create({
        messages: [
          { role: "assistant", content: SYSTEM_PROMPT },
          { role: "user", content: `【上下文】\n${ctxText}\n\n【用户消息】${userText}` },
        ],
        thinking: { type: "disabled" },
        temperature: 0.1,
        max_tokens: 600,
      });
      const raw = completion.choices[0]?.message?.content ?? "";
      try {
        const jsonStr = raw.replace(/```json|```/g, "").trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        parsed = null; // 触发重试
      }
    }
    if (!parsed) throw new Error("intent parse failed after retries");
    // 未知意图兜底 → out_of_scope
    const intent = (ALL_INTENTS as string[]).includes(parsed.intent)
      ? (parsed.intent as IntentType)
      : ("out_of_scope" as IntentType);

    const result: IntentResult = {
      intent,
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.7)),
      slots: parsed.slots ?? {},
      utterance: parsed.utterance ?? userText,
      needsClarify: parsed.needsClarify,
      compound: Boolean(parsed.compound && parsed.subTasks?.length),
    };
    // 复合任务：暂存子任务到 slots.tasks
    if (result.compound && parsed.subTasks) {
      result.slots.tasks = parsed.subTasks;
    }
    await audit(userId, traceId, {
      stage: "INTENT",
      action: "nlu.llm",
      decision: "ALLOW",
      detail: { intent, confidence: result.confidence, compound: result.compound, slots: result.slots },
    });
    return result;
  } catch (e) {
    // 第二层纠错：LLM 不可用时降级到规则引擎兜底（高可用）
    const fallback = ruleNLU(userText);
    if (fallback) {
      await audit(userId, traceId, {
        stage: "INTENT",
        action: "nlu.rule_fallback",
        decision: "ALLOW",
        detail: { reason: "llm_unavailable", intent: fallback.intent },
      });
      return fallback;
    }
    await audit(userId, traceId, {
      stage: "INTENT",
      action: "nlu.failed",
      decision: "DENY",
      detail: { error: String(e).slice(0, 200) },
    });
    return {
      intent: "out_of_scope",
      confidence: 0,
      slots: {},
      utterance: userText,
    };
  }
}
