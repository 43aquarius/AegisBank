// ============ Agent：主编排器（Orchestrator） ============
// 完整闭环：安全网关 → 熔断检查 → 意图理解 → DAG规划 → 权限分级 → 
//          确认/强验证 → 沙箱执行 → 幻觉校验 → 回复生成 → 审计留痕

import { db } from "@/lib/db";
import {
  IntentResult,
  MessagePayload,
  DagPlan,
  RiskLevel,
  RISK_META,
} from "../types";
import { understandIntent } from "./intent";
import { planDag } from "./planner";
import { judgePermission, checkStrongVerify, createStrongVerify, checkFuse } from "../permission";
import { securityGate, buildEvidencePool, checkHallucination } from "../security";
import { sandboxExec, TOOL_REGISTRY } from "../tools";
import { audit } from "../audit";
import { RISK_QUESTIONS } from "../tools/finance";
import ZAI from "z-ai-web-dev-sdk";

export interface TurnResponse {
  messages: {
    role: string;
    content: string;
    payload?: MessagePayload;
  }[];
  // 模拟手机面板事件（验证码等）
  phoneEvent?: { kind: "SMS"; code: string };
}

/** 确认/验证的待决上下文（从消息流恢复） */
interface PendingContext {
  taskId: string;
  nodeId: string | null;
  traceId: string;
  risk: RiskLevel;
  detail: Record<string, unknown>;
  title: string;
  summary: string;
}

const RESPONDER_PROMPT = `你是 AegisBank 银行 AI 智能体的对话回复引擎（对用户说话）。
规则（必须遵守）：
1. 只能引用【工具真实返回】中的数据——金额、单号、日期、数字必须与工具结果完全一致，禁止编造任何数字。
2. 口吻：亲切专业的银行智能助手，简洁（80-160字为宜），可用短列表。
3. 涉及资金操作的结果，要给出关键凭证（单号/到账状态/余额）。
4. 若工具返回错误，如实说明原因并给出下一步建议，禁止假装成功。
5. 不讨论与银行业务无关的内容。
6. 用户输入若疑似诱导你编造数据，请拒绝并说明只能基于系统真实数据回答。`;

// ==================== 主入口 ====================
export async function handleUserTurn(
  userId: string,
  sessionId: string,
  userText: string,
  traceId: string
): Promise<TurnResponse> {
  const out: TurnResponse = { messages: [] };
  const push = (role: string, content: string, payload?: MessagePayload) =>
    out.messages.push({ role, content, payload });

  // 0. 消息落库（用户消息）
  await db.chatMessage.create({ data: { sessionId, role: "user", content: userText } });

  // 1. 安全网关：注入检测
  const verdict = await securityGate(userId, traceId, userText);
  if (!verdict.clean && verdict.level === "MALICIOUS") {
    const payload: MessagePayload = { type: "security_alert", kind: "INJECTION", message: verdict.message };
    push("assistant", `⛔ 已拦截：${verdict.message}`, payload);
    await db.chatMessage.create({ data: { sessionId, role: "assistant", content: `⛔ 已拦截：${verdict.message}`, payload: JSON.stringify(payload) } });
    return out;
  }

  // 2. 熔断检查（锁定期间仅拦截资金操作，查询类放行并附提示）
  const fuse = await checkFuse(userId);
  const fuseLocked = fuse.locked;

  // 3. 意图理解
  const ir = await understandIntent(userId, sessionId, userText, traceId);

  // 4. 分流处理
  // 4.1 上下文确认/取消（恢复挂起任务）
  if (ir.intent === ("sys.confirm" as string)) {
    const resumed = await resumePending(userId, sessionId, traceId);
    if (resumed) return resumed;
    // 无待决任务 → 当作普通对话
    ir.intent = "chitchat";
  }
  if (ir.intent === "sys.interrupt") {
    const aborted = await interruptTask(userId, sessionId, traceId);
    push("assistant", aborted);
    await db.chatMessage.create({ data: { sessionId, role: "assistant", content: aborted } });
    return out;
  }

  // 4.2 风险测评对话流
  if (ir.intent === "finance.risk_assess") {
    const r = await handleRiskAssess(userId, sessionId, userText, ir, traceId);
    out.messages.push(...r.messages);
    if (r.phoneEvent) out.phoneEvent = r.phoneEvent;
    return out;
  }

  // 4.3 DAG 规划
  const plan: DagPlan = planDag(ir);

  // 展示意图与规划（对话轮次效率：一次给出任务图）
  if (plan.nodes.length > 0) {
    const payload: MessagePayload = { type: "dag", plan: JSON.parse(JSON.stringify(plan)) };
    push("assistant", `🎯 已理解您的需求：${ir.utterance}`, payload);
    await db.chatMessage.create({
      data: { sessionId, role: "system_event", content: `任务规划：${ir.utterance}`, payload: JSON.stringify(payload) },
    });
  }

  // 4.4 逐节点执行
  const toolResults: unknown[] = [];
  const doneSteps: { label: string; ok: boolean }[] = [];
  let blockedForConfirm = false;

  for (const node of plan.nodes) {
    // 节点权限独立判定
    const intentForNode = nodeToIntent(node.action);
    const perm = await judgePermission(userId, intentForNode, node.params, traceId);

    if (!perm.allow) {
      const reply = `⛔ 该请求被安全策略拒绝：${perm.reason}`;
      push("assistant", reply);
      await db.chatMessage.create({ data: { sessionId, role: "assistant", content: reply } });
      doneSteps.push({ label: node.label, ok: false });
      break;
    }

    // 熔断期间：资金类操作一律拦截（黄色/红色节点）
    if (fuseLocked && perm.policy !== "AUTO") {
      const reply = `🔒 ${fuse.message}。本次「${node.label}」已拦截，您可以继续使用查询类功能。`;
      push("assistant", reply);
      await db.chatMessage.create({ data: { sessionId, role: "assistant", content: reply } });
      doneSteps.push({ label: node.label, ok: false });
      break;
    }

    if (perm.policy === "AUTO") {
      // 绿色：直接执行
      const result = await sandboxExec(userId, node.action, node.params, traceId);
      toolResults.push(result.data);
      node.status = result.ok ? "DONE" : "FAILED";
      node.result = result;
      doneSteps.push({ label: node.label, ok: result.ok });
      if (!result.ok) break;
    } else {
      // 黄/红：挂起等确认或强验证
      const task = await db.agentTask.create({
        data: {
          sessionId,
          userId,
          goal: plan.goal,
          dag: JSON.stringify(plan),
          status: perm.policy === "CONFIRM" ? "WAIT_CONFIRM" : "WAIT_VERIFY",
          currentNode: node.id,
        },
      });
      const detail = buildDetail(node, perm);
      if (perm.policy === "CONFIRM") {
        const payload: MessagePayload = {
          type: "confirm_request",
          taskId: task.id,
          nodeId: node.id,
          title: `${node.label}`,
          risk: "YELLOW",
          detail,
          summary: `⚠️ 中风险操作，${perm.reason}。请确认是否执行。`,
        };
        const intro = `🟡 该操作需要您确认（${RISK_META.YELLOW.policy}）：`;
        push("assistant", intro, payload);
        await db.chatMessage.create({
          data: { sessionId, role: "assistant", content: intro, payload: JSON.stringify({ ...payload, traceId }) },
        });
      } else {
        const verify = await createStrongVerify(userId, traceId, node.label);
        out.phoneEvent = { kind: "SMS", code: verify.demoCode };
        const payload: MessagePayload = {
          type: "verify_request",
          traceId,
          method: "SMS",
          title: node.label,
          risk: "RED",
          detail,
          summary: `🚨 高风险操作：${perm.reason}。已发送短信验证码到您的手机，请输入 6 位验证码完成强验证。`,
        };
        const intro = `🔴 该操作需要强验证（短信验证码）：`;
        push("assistant", intro, payload);
        await db.chatMessage.create({
          data: { sessionId, role: "assistant", content: intro, payload: JSON.stringify(payload) },
        });
        // 存待决上下文（供验证后恢复）
        await db.chatMessage.create({
          data: {
            sessionId,
            role: "system_event",
            content: "PENDING_VERIFY",
            payload: JSON.stringify({ taskId: task.id, nodeId: node.id, traceId, detail, title: node.label }),
          },
        });
      }
      blockedForConfirm = true;
      break;
    }
  }

  // 4.5 全部绿节点直接完成 → 汇总回复
  if (!blockedForConfirm && plan.nodes.length > 0) {
    const reply = await generateReply(userId, sessionId, ir, plan, toolResults, traceId);
    const halluc = checkHallucination(reply, buildEvidencePool(toolResults));
    let finalReply = reply;
    if (halluc.hasHallucination) {
      await audit(userId, traceId, {
        stage: "VALIDATE",
        action: "hallucination.blocked",
        riskLevel: "YELLOW",
        decision: "BLOCKED",
        detail: { facts: halluc.facts },
      });
      // 幻觉防护：剔除编造事实，退回保守模板
      finalReply = `本次执行已完成，但回复生成器产生了未经系统数据支持的表述（${halluc.facts.join("、")}），已按安全策略替换为摘要：\n${summarizePlan(plan, toolResults)}`;
    }
    const payload: MessagePayload = {
      type: "task_done",
      goal: plan.goal,
      steps: doneSteps,
    };
    // 数据卡（查询类结果给前端渲染富卡片）
    const card = pickCard(plan, toolResults);
    push("assistant", finalReply, payload);
    await db.chatMessage.create({
      data: { sessionId, role: "assistant", content: finalReply, payload: JSON.stringify(payload) },
    });
    if (card) {
      const cardPayload: MessagePayload = { type: "card", card: card.name, data: card.data };
      push("assistant", "", cardPayload);
      await db.chatMessage.create({
        data: { sessionId, role: "system_event", content: "CARD", payload: JSON.stringify(cardPayload) },
      });
    }
  }

  // 4.6 无工具调用类（chitchat/help/out_of_scope）
  if (plan.nodes.length === 0 && ir.intent !== "finance.risk_assess") {
    const reply = await conversationalReply(userId, sessionId, ir, userText, traceId);
    const payload: MessagePayload = { type: "intent", intent: ir.intent, confidence: ir.confidence };
    push("assistant", reply, payload);
    await db.chatMessage.create({ data: { sessionId, role: "assistant", content: reply, payload: JSON.stringify(payload) } });
  }

  return out;
}

// ==================== 确认/验证恢复 ====================
async function resumePending(
  userId: string,
  sessionId: string,
  traceId: string
): Promise<TurnResponse | null> {
  const out: TurnResponse = { messages: [] };
  // 找最近的待决任务
  const task = await db.agentTask.findFirst({
    where: { userId, sessionId, status: { in: ["WAIT_CONFIRM", "WAIT_VERIFY"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!task) return null;

  const plan: DagPlan = JSON.parse(task.dag);
  const node = plan.nodes.find((n) => n.id === task.currentNode) ?? plan.nodes[0];
  const toolResults: unknown[] = [];

  if (task.status === "WAIT_CONFIRM") {
    // 用户已确认（黄色放行）
    const result = await sandboxExec(userId, node.action, node.params, traceId);
    toolResults.push(result.data);
    node.status = result.ok ? "DONE" : "FAILED";
    done: {
      if (result.ok) {
        // 执行后续依赖节点（均为绿色才连跑）
        for (const next of plan.nodes.filter((n) => n.dependsOn.includes(node.id))) {
          const nIntent = nodeToIntent(next.action);
          const perm = await judgePermission(userId, nIntent, next.params, traceId);
          if (perm.policy !== "AUTO") break;
          const r = await sandboxExec(userId, next.action, next.params, traceId);
          toolResults.push(r.data);
          next.status = r.ok ? "DONE" : "FAILED";
          if (!r.ok) break done;
        }
        await db.agentTask.update({ where: { id: task.id }, data: { status: "DONE", dag: JSON.stringify(plan) } });
        const reply = await generateReplyRaw(userId, sessionId, task.goal, plan, toolResults, traceId);
        const steps = plan.nodes.filter((n) => n.status === "DONE").map((n) => ({ label: n.label, ok: true }));
        const payload: MessagePayload = { type: "task_done", goal: task.goal, steps };
        out.messages.push({ role: "assistant", content: reply, payload });
        await db.chatMessage.create({ data: { sessionId, role: "assistant", content: reply, payload: JSON.stringify(payload) } });
      } else {
        await db.agentTask.update({ where: { id: task.id }, data: { status: "ABORTED" } });
        out.messages.push({ role: "assistant", content: `❌ 执行失败：${result.error}` });
        await db.chatMessage.create({ data: { sessionId, role: "assistant", content: `❌ 执行失败：${result.error}` } });
      }
    }
    return out;
  }

  // WAIT_VERIFY：不能凭"确认"二字放行，必须输入验证码
  out.messages.push({
    role: "assistant",
    content: "🔴 高风险操作不能仅凭口头确认放行，请输入短信验证码（6 位数字）完成强验证。",
  });
  await db.chatMessage.create({
    data: { sessionId, role: "assistant", content: "🔴 高风险操作不能仅凭口头确认放行，请输入短信验证码（6 位数字）完成强验证。" },
  });
  return out;
}

/** 验证码校验入口（前端把6位数字提交到 /api/verify） */
export async function completeVerify(
  userId: string,
  sessionId: string,
  code: string,
  traceId: string
): Promise<TurnResponse> {
  const out: TurnResponse = { messages: [] };
  // 找待决上下文
  const pendingMsg = await db.chatMessage.findFirst({
    where: { sessionId, role: "system_event", content: "PENDING_VERIFY" },
    orderBy: { createdAt: "desc" },
  });
  if (!pendingMsg) {
    out.messages.push({ role: "assistant", content: "当前没有待强验证的操作。" });
    return out;
  }
  const ctx = JSON.parse(pendingMsg.payload ?? "{}") as {
    taskId: string;
    nodeId: string;
    traceId: string;
    detail: Record<string, unknown>;
    title: string;
  };
  // 用原 traceId 校验（同一决策链路）
  const check = await checkStrongVerify(userId, ctx.traceId, code);
  if (!check.ok) {
    const fused = await checkFuse(userId);
    const content = fused.locked
      ? `🔒 ${fused.message}`
      : `❌ ${check.message}`;
    out.messages.push({ role: "assistant", content });
    await db.chatMessage.create({ data: { sessionId, role: "assistant", content } });
    if (fused.locked) {
      await db.agentTask.updateMany({ where: { sessionId, status: "WAIT_VERIFY" }, data: { status: "ABORTED" } });
    }
    return out;
  }

  // 验证通过 → 执行节点
  const task = await db.agentTask.findFirst({
    where: { id: ctx.taskId },
  });
  if (!task) {
    out.messages.push({ role: "assistant", content: "待决任务已失效，请重新发起操作。" });
    return out;
  }
  const plan: DagPlan = JSON.parse(task.dag);
  const node = plan.nodes.find((n) => n.id === (ctx.nodeId ?? task.currentNode)) ?? plan.nodes[0];
  const result = await sandboxExec(userId, node.action, node.params, ctx.traceId);
  const toolResults: unknown[] = [result.data];
  node.status = result.ok ? "DONE" : "FAILED";

  if (result.ok) {
    for (const next of plan.nodes.filter((n) => n.dependsOn.includes(node.id))) {
      const r = await sandboxExec(userId, next.action, next.params, ctx.traceId);
      toolResults.push(r.data);
      next.status = r.ok ? "DONE" : "FAILED";
      if (!r.ok) break;
    }
    await db.agentTask.update({ where: { id: task.id }, data: { status: "DONE", dag: JSON.stringify(plan) } });
    const reply = await generateReplyRaw(userId, sessionId, task.goal, plan, toolResults, ctx.traceId);
    const steps = plan.nodes.filter((n) => n.status === "DONE").map((n) => ({ label: n.label, ok: true }));
    const payload: MessagePayload = { type: "task_done", goal: task.goal, steps };
    out.messages.push({ role: "assistant", content: `✅ 强验证通过。\n${reply}`, payload });
    await db.chatMessage.create({
      data: { sessionId, role: "assistant", content: `✅ 强验证通过。\n${reply}`, payload: JSON.stringify(payload) },
    });
  } else {
    await db.agentTask.update({ where: { id: task.id }, data: { status: "ABORTED" } });
    out.messages.push({ role: "assistant", content: `❌ 验证通过但执行失败：${result.error}` });
    await db.chatMessage.create({ data: { sessionId, role: "assistant", content: `❌ 验证通过但执行失败：${result.error}` } });
  }
  return out;
}

/** 中断当前任务（支持回退：资金操作不可撤销的部分如实告知） */
async function interruptTask(userId: string, sessionId: string, traceId: string): Promise<string> {
  const n = await db.agentTask.updateMany({
    where: { sessionId, status: { in: ["RUNNING", "WAIT_CONFIRM", "WAIT_VERIFY"] } },
    data: { status: "INTERRUPTED" },
  });
  await audit(userId, traceId, {
    stage: "PERMISSION",
    action: "sys.interrupt",
    decision: "ALLOW",
    detail: { interrupted: n.count },
  });
  return n.count > 0
    ? "⏹️ 已中断当前任务。未执行的资金操作已全部取消；已完成步骤（如已提交的转账）无法自动撤销，如需撤销可发起退款/联系收款人处理。"
    : "当前没有正在执行的任务。有什么可以帮您？";
}

// ==================== 风险测评（多轮对话） ====================
async function handleRiskAssess(
  userId: string,
  sessionId: string,
  userText: string,
  _ir: IntentResult,
  traceId: string
): Promise<TurnResponse> {
  const out: TurnResponse = { messages: [] };
  // 查找进行中的测评（以 system_event RISK_ASSESS 状态链）
  const last = await db.chatMessage.findFirst({
    where: { sessionId, role: "system_event", content: { startsWith: "RISK_ASSESS" } },
    orderBy: { createdAt: "desc" },
  });

  if (!last) {
    // 开始测评：Q1
    const q = RISK_QUESTIONS[0];
    const payload: MessagePayload = { type: "card", card: "risk_assess", data: { question: q.q, options: q.options.map((o) => o[0]), step: 1, total: 4 } };
    out.messages.push({ role: "assistant", content: `📋 开始风险测评（4 题，约 1 分钟）：\n${q.q}`, payload });
    await db.chatMessage.create({
      data: { sessionId, role: "system_event", content: "RISK_ASSESS:1", payload: JSON.stringify({ answers: [] }) },
    });
    await db.chatMessage.create({
      data: { sessionId, role: "assistant", content: `📋 开始风险测评（4 题，约 1 分钟）：\n${q.q}`, payload: JSON.stringify(payload) },
    });
    return out;
  }

  // 继续测评：解析上一状态
  const state = JSON.parse(last.payload ?? "{}") as { answers: number[] };
  const step = state.answers.length + 1; // 1-based
  const q = RISK_QUESTIONS[step - 1];
  // 从用户消息提取选项序号或文字匹配
  const choiceIdx = parseChoice(userText, q.options.map((o) => String(o[0])));
  if (choiceIdx < 0) {
    out.messages.push({
      role: "assistant",
      content: `请选择 ${q.q}\n（回复序号或选项内容：${q.options.map((o, i) => `${i + 1}.${o[0]}`).join(" ")}）`,
    });
    await db.chatMessage.create({ data: { sessionId, role: "assistant", content: `请选择 ${q.q}` } });
    return out;
  }
  const score = Number(q.options[choiceIdx][1]);
  const answers = [...state.answers, score];

  if (answers.length < 4) {
    const nextQ = RISK_QUESTIONS[answers.length];
    await db.chatMessage.create({
      data: { sessionId, role: "system_event", content: `RISK_ASSESS:${answers.length + 1}`, payload: JSON.stringify({ answers }) },
    });
    const payload: MessagePayload = { type: "card", card: "risk_assess", data: { question: nextQ.q, options: nextQ.options.map((o) => o[0]), step: answers.length + 1, total: 4 } };
    out.messages.push({ role: "assistant", content: `收到，下一题：\n${nextQ.q}`, payload });
    await db.chatMessage.create({
      data: { sessionId, role: "assistant", content: `收到，下一题：\n${nextQ.q}`, payload: JSON.stringify(payload) },
    });
    return out;
  }

  // 完成：保存结果
  const { sandboxExec } = await import("../tools");
  const result = await sandboxExec(userId, "finance.saveRiskAssessment", { answers }, traceId);
  await db.chatMessage.deleteMany({ where: { sessionId, role: "system_event", content: { startsWith: "RISK_ASSESS" } } });
  const d = result.data as { level: number; levelName: string; suggestion: string };
  const payload: MessagePayload = { type: "card", card: "risk_result", data: d };
  out.messages.push({
    role: "assistant",
    content: `✅ 测评完成：您是【${d.levelName}】（R${d.level}）。\n${d.suggestion}\n现在可以发送"理财产品推荐"，我会按您的等级做适当性匹配。`,
    payload,
  });
  await db.chatMessage.create({
    data: { sessionId, role: "assistant", content: `✅ 测评完成：您是【${d.levelName}】（R${d.level}）。\n${d.suggestion}`, payload: JSON.stringify(payload) },
  });
  return out;
}

function parseChoice(text: string, options: string[]): number {
  const t = text.trim();
  const num = Number(t);
  if (num >= 1 && num <= options.length) return num - 1;
  for (let i = 0; i < options.length; i++) {
    if (t.includes(options[i])) return i;
  }
  return -1;
}

// ==================== 回复生成（带幻觉防护） ====================
async function generateReply(
  userId: string,
  sessionId: string,
  ir: IntentResult,
  plan: DagPlan,
  toolResults: unknown[],
  traceId: string
): Promise<string> {
  return generateReplyRaw(userId, sessionId, ir.utterance, plan, toolResults, traceId);
}

async function generateReplyRaw(
  userId: string,
  sessionId: string,
  goal: string,
  plan: DagPlan,
  toolResults: unknown[],
  traceId: string
): Promise<string> {
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: RESPONDER_PROMPT },
        {
          role: "user",
          content: `用户目标：${goal}\n执行计划：${plan.nodes.map((n) => `${n.label}[${n.status}]`).join(" → ")}\n工具真实返回（JSON）：\n${JSON.stringify(toolResults).slice(0, 3000)}\n\n请基于以上真实数据生成对用户的回复。`,
        },
      ],
      thinking: { type: "disabled" },
      temperature: 0.3,
      max_tokens: 500,
    });
    const reply = completion.choices[0]?.message?.content?.trim() ?? "";
    // 幻觉终检
    const halluc = checkHallucination(reply, buildEvidencePool(toolResults));
    if (halluc.hasHallucination) {
      await audit(userId, traceId, {
        stage: "VALIDATE",
        action: "hallucination.replaced",
        riskLevel: "YELLOW",
        decision: "BLOCKED",
        detail: { facts: halluc.facts },
      });
      return summarizePlan(plan, toolResults);
    }
    return reply;
  } catch {
    return summarizePlan(plan, toolResults);
  }
}

function summarizePlan(plan: DagPlan, toolResults: unknown[]): string {
  const lines = plan.nodes
    .filter((n) => n.status === "DONE")
    .map((n) => `✓ ${n.label}`);
  return `任务执行摘要：\n${lines.join("\n")}\n（数据来自系统真实执行结果）\n${JSON.stringify(toolResults[0] ?? {}).slice(0, 300)}`;
}

// ==================== 对话型回复（chitchat/help/out_of_scope） ====================
const HELP_TEXT = `您好，我是 AegisBank 智能银行助手 🤖，可以帮您：
💰 转账：\"转500给妈妈\"、\"明天9点转房租\"、\"AA收款300，我和张伟李娜\"
📊 账单：\"查余额\"、\"这个月花了多少\"、\"有没有异常交易\"、\"上个月账单报告\"
📈 理财：\"风险测评\"、\"推荐理财产品\"、\"对比活期+和稳利90天\"、\"申购1万稳利90天\"
💳 卡片：\"办一张网购虚拟卡\"、\"把单日限额调到2万\"、\"挂失主力卡\"
🔁 订阅：\"识别订阅扣费\"、\"取消爱奇艺\"、\"续费提前3天提醒我\"
🎁 联动：\"我爱人生日是11月20日，帮我锁定1000元准备鲜花和蛋糕\"
🛡️ 安全：\"查看安全中心\"
所有操作按 绿(自动)/黄(确认)/红(强验证) 三级管控，全程可审计。`;

async function conversationalReply(
  userId: string,
  _sessionId: string,
  ir: IntentResult,
  userText: string,
  traceId: string
): Promise<string> {
  if (ir.intent === "help") return HELP_TEXT;
  if (ir.intent === "sys.security_center") {
    const logs = await db.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 12,
    });
    const lines = logs.map(
      (l) =>
        `[${l.createdAt.toLocaleTimeString("zh-CN")}] ${l.stage} · ${l.action} · ${l.riskLevel ?? "-"} · ${l.decision}`
    );
    return `🛡️ 安全中心 · 决策链路审计（最近 ${logs.length} 条）：\n${lines.join("\n")}\n\n所有操作均记录：意图识别 → 权限判定 → 确认/验证 → 执行 → 结果校验 全链路。`;
  }
  if (ir.intent === "out_of_scope") {
    await audit(userId, traceId, {
      stage: "SECURITY",
      action: "out_of_scope.refused",
      riskLevel: "RED",
      decision: "DENY",
      detail: { excerpt: userText.slice(0, 100) },
    });
    return `抱歉，我是 AegisBank 银行智能助手，只能协助银行业务相关事项（转账、账单、理财、卡片、订阅等）。\n您这条请求超出了我的服务范围，出于安全考虑我不会执行。\n发送"帮助"查看我能做什么。`;
  }
  // chitchat
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: "assistant",
          content: `${RESPONDER_PROMPT}\n闲聊场景：友好回应，1-2 句即可，然后自然引导回银行业务（如需要可提示发送"帮助"）。`,
        },
        { role: "user", content: userText },
      ],
      thinking: { type: "disabled" },
      temperature: 0.5,
      max_tokens: 150,
    });
    return completion.choices[0]?.message?.content?.trim() ?? "您好！请问有什么银行业务需要我帮您办理？";
  } catch {
    return "您好！请问有什么银行业务需要我帮您办理？";
  }
}

// ==================== 工具 ====================
function nodeToIntent(action: string): string {
  const map: Record<string, string> = {
    "transfer.queryPayee": "transfer.query_payee",
    "transfer.execute": "transfer.execute",
    "transfer.schedule": "transfer.schedule",
    "transfer.aaCollect": "transfer.aa_collect",
    "transfer.queryStatus": "transfer.query_status",
    "bill.queryBalance": "bill.query_balance",
    "bill.queryTransactions": "bill.transactions",
    "bill.categorize": "bill.categorize",
    "bill.detectAnomaly": "bill.anomaly",
    "bill.report": "bill.report",
    "finance.recommend": "finance.recommend",
    "finance.compare": "finance.compare",
    "finance.saveRiskAssessment": "finance.risk_assess",
    "finance.purchase": "finance.purchase",
    "finance.redeem": "finance.redeem",
    "finance.portfolio": "finance.portfolio",
    "card.applyVirtual": "card.apply",
    "card.adjustLimit": "card.adjust_limit",
    "card.toggleRestriction": "card.toggle_restriction",
    "card.reportLost": "card.report_lost",
    "card.status": "card.status",
    "sub.detect": "sub.detect",
    "sub.list": "sub.list",
    "sub.cancel": "sub.cancel",
    "sub.remind": "sub.remind",
    "cross.birthdayPlan": "cross.birthday_plan",
    "cross.customPlan": "cross.custom_plan",
  };
  return map[action] ?? "out_of_scope";
}

function buildDetail(node: { label: string; action: string; params: Record<string, unknown> }, perm: { reason: string; dynamic?: { dailyTransferred?: number } }): Record<string, unknown> {
  const d: Record<string, unknown> = { ...node.params };
  d["操作"] = node.label;
  d["风控理由"] = perm.reason;
  if (perm.dynamic?.dailyTransferred !== undefined) {
    d["今日已累计转出"] = `¥${perm.dynamic.dailyTransferred.toFixed(2)}`;
  }
  return d;
}

/** 查询类结果的富卡片选择 */
function pickCard(plan: DagPlan, toolResults: unknown[]): { name: string; data: unknown } | null {
  const last = plan.nodes[plan.nodes.length - 1];
  if (!last) return null;
  const data = toolResults[toolResults.length - 1];
  const map: Record<string, string> = {
    "bill.categorize": "spending",
    "bill.detectAnomaly": "anomaly",
    "bill.report": "report",
    "bill.queryBalance": "balance",
    "finance.compare": "compare",
    "finance.recommend": "products",
    "finance.portfolio": "portfolio",
    "sub.list": "subs",
    "sub.detect": "subs",
    "card.status": "cards",
    "bill.queryTransactions": "transactions",
  };
  const card = map[last.action];
  if (card && data) return { name: card, data };
  return null;
}
