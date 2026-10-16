// ============ Agent：DAG 任务规划器 ============
// 赛题要求：复杂任务需拆解为有序的子任务 DAG（有向无环图）
// 执行过程中支持中断、回退和人工接管

import { IntentResult, DagPlan, DagNode } from "../types";

/** 意图 → 默认 DAG 模板（确定性规划，LLM 只做意图与参数，保证执行可靠性） */
const DAG_TEMPLATES: Record<string, (slots: Record<string, unknown>) => DagNode[] | null> = {
  // 简单意图 → 单节点
  simple: (slots) => null,

  // 转账（含收款人解析）：解析收款人 → 转账
  "transfer.execute": (s) => {
    const nodes: DagNode[] = [];
    if (s.payeeName && !/^1[3-9]\d{9}$/.test(String(s.payeeName))) {
      nodes.push({
        id: "n1",
        action: "transfer.queryPayee",
        label: `解析收款人「${s.payeeName}」`,
        params: { keyword: s.payeeName },
        dependsOn: [],
        status: "PENDING",
      });
      nodes.push({
        id: "n2",
        action: "transfer.execute",
        label: `转账 ¥${s.amount} 给${s.payeeName}`,
        params: { payeeName: s.payeeName, amount: s.amount, remark: s.remark ?? "" },
        dependsOn: ["n1"],
        status: "PENDING",
      });
    } else {
      nodes.push({
        id: "n1",
        action: "transfer.execute",
        label: `转账 ¥${s.amount}`,
        params: { payeeName: s.payeeName, amount: s.amount, remark: s.remark ?? "" },
        dependsOn: [],
        status: "PENDING",
      });
    }
    return nodes;
  },

  // 定时转账
  "transfer.schedule": (s) => [
    {
      id: "n1",
      action: "transfer.schedule",
      label: `创建定时转账（${s.runAt}）`,
      params: { payeeName: s.payeeName, amount: s.amount, runAt: s.runAt, remark: s.remark ?? "" },
      dependsOn: [],
      status: "PENDING",
    },
  ],

  // AA 收款
  "transfer.aa_collect": (s) => [
    {
      id: "n1",
      action: "transfer.aaCollect",
      label: `发起 AA 收款（${(s.participants as string[])?.length ?? 0} 人 / ¥${s.total}）`,
      params: { participants: s.participants, total: s.total, note: s.note ?? "" },
      dependsOn: [],
      status: "PENDING",
    },
  ],

  // 异常识别 + 分类（组合分析）
  "bill.anomaly": (s) => [
    {
      id: "n1",
      action: "bill.detectAnomaly",
      label: `扫描异常交易（近 ${s.days ?? 30} 天）`,
      params: { days: s.days ?? 30 },
      dependsOn: [],
      status: "PENDING",
    },
  ],

  // 账单报告：分类统计 + 报告生成
  "bill.report": (s) => [
    { id: "n1", action: "bill.categorize", label: "消费分类统计", params: { days: s.period === "year" ? 365 : 30 }, dependsOn: [], status: "PENDING" },
    { id: "n2", action: "bill.report", label: `生成${s.period === "year" ? "年度" : "月度"}账单报告`, params: { period: s.period ?? "month" }, dependsOn: ["n1"], status: "PENDING" },
  ],

  // 申购：先查产品信息 → 申购
  "finance.purchase": (s) => [
    { id: "n1", action: "finance.recommend", label: "校验产品与适当性", params: {}, dependsOn: [], status: "PENDING" },
    { id: "n2", action: "finance.purchase", label: `申购 ${s.name ?? s.code} ¥${s.amount}`, params: { code: s.code, name: s.name, amount: s.amount }, dependsOn: ["n1"], status: "PENDING" },
  ],

  // 赎回
  "finance.redeem": (s) => [
    { id: "n1", action: "finance.portfolio", label: "查询持仓与锁定期", params: {}, dependsOn: [], status: "PENDING" },
    { id: "n2", action: "finance.redeem", label: `赎回 ${s.name ?? ""}${s.amount ? ` ¥${s.amount}` : "全部"}`, params: { code: s.code, name: s.name, amount: s.amount }, dependsOn: ["n1"], status: "PENDING" },
  ],

  // 生日规划（赛题跨场景示例：锁资金 → 创建订购计划）
  "cross.birthday_plan": (s) => [
    { id: "n1", action: "bill.queryBalance", label: "检查可用资金", params: {}, dependsOn: [], status: "PENDING" },
    { id: "n2", action: "cross.birthdayPlan", label: `锁定 ¥${s.budget ?? 1000} 生日资金`, params: { person: s.person, date: s.date, budget: s.budget ?? 1000 }, dependsOn: ["n1"], status: "PENDING" },
  ],

  // 订阅识别（扫描 → 汇总）
  "sub.detect": () => [
    { id: "n1", action: "sub.detect", label: "扫描近 120 天周期扣费", params: {}, dependsOn: [], status: "PENDING" },
    { id: "n2", action: "sub.list", label: "汇总订阅清单", params: {}, dependsOn: ["n1"], status: "PENDING" },
  ],

  // 取消订阅（先列清单确认目标 → 取消）
  "sub.cancel": (s) => [
    { id: "n1", action: "sub.list", label: "确认订阅目标", params: {}, dependsOn: [], status: "PENDING" },
    { id: "n2", action: "sub.cancel", label: `取消「${s.merchant}」订阅`, params: { merchant: s.merchant }, dependsOn: ["n1"], status: "PENDING" },
  ],
};

/** 简单意图直接映射为单工具调用 */
const SIMPLE_TOOL_MAP: Record<string, { action: string; label: string; paramKeys: string[] }> = {
  "bill.query_balance": { action: "bill.queryBalance", label: "查询余额", paramKeys: [] },
  "bill.transactions": { action: "bill.queryTransactions", label: "查询流水", paramKeys: ["days", "category", "limit"] },
  "bill.categorize": { action: "bill.categorize", label: "消费分类统计", paramKeys: ["days"] },
  "finance.recommend": { action: "finance.recommend", label: "理财产品推荐", paramKeys: [] },
  "finance.compare": { action: "finance.compare", label: "产品对比", paramKeys: ["codes", "names"] },
  "finance.portfolio": { action: "finance.portfolio", label: "持仓查询", paramKeys: [] },
  "card.status": { action: "card.status", label: "卡片状态", paramKeys: [] },
  "card.apply": { action: "card.applyVirtual", label: "申请虚拟卡", paramKeys: ["purpose", "quota"] },
  "card.adjust_limit": { action: "card.adjustLimit", label: "调整限额", paramKeys: ["cardLabel", "cardNo", "newLimit"] },
  "card.toggle_restriction": { action: "card.toggleRestriction", label: "交易限制开关", paramKeys: ["cardLabel", "cardNo", "what", "on"] },
  "card.report_lost": { action: "card.reportLost", label: "挂失/解挂", paramKeys: ["cardLabel", "cardNo", "op"] },
  "sub.remind": { action: "sub.remind", label: "续费提醒", paramKeys: ["merchant", "daysAhead"] },
  "sub.list": { action: "sub.list", label: "订阅清单", paramKeys: [] },
  "transfer.query_payee": { action: "transfer.queryPayee", label: "查找收款人", paramKeys: ["keyword"] },
  "transfer.query_status": { action: "transfer.queryStatus", label: "转账进度", paramKeys: [] },
  "cross.custom_plan": { action: "cross.customPlan", label: "创建联动计划", paramKeys: ["when", "action"] },
};

export function planDag(intentResult: IntentResult): DagPlan {
  const { intent, slots } = intentResult;

  // 复合任务：把 subTasks 串成链式 DAG
  if (intentResult.compound && Array.isArray(slots.tasks)) {
    const tasks = slots.tasks as { intent: string; slots: Record<string, unknown> }[];
    const nodes: DagNode[] = [];
    tasks.forEach((t, i) => {
      const sub = planDag({ intent: t.intent as IntentResult["intent"], confidence: 1, slots: t.slots, utterance: "" });
      sub.nodes.forEach((n) => {
        nodes.push({
          ...n,
          id: `t${i}_${n.id}`,
          dependsOn: n.dependsOn.map((d) => `t${i}_${d}`),
        });
      });
    });
    return { goal: intentResult.utterance, nodes };
  }

  // 模板规划
  const templater = DAG_TEMPLATES[intent];
  if (templater) {
    const nodes = templater(slots);
    if (nodes) return { goal: intentResult.utterance, nodes };
  }

  // cross.custom_plan 缺 when/action 槽位时的兜底（防 zod 拒绝导致整任务失败）：
  // 含生日/人物/预算信号 → 改走生日规划模板；否则以归一化诉求原文登记联动计划
  if (intent === "cross.custom_plan" && (slots.when === undefined || slots.action === undefined)) {
    const birthdaySignals =
      slots.person !== undefined || slots.budget !== undefined || /生日|礼物|鲜花|蛋糕/.test(intentResult.utterance);
    if (birthdaySignals) {
      return planDag({
        ...intentResult,
        intent: "cross.birthday_plan",
        compound: false,
        slots: { ...slots, budget: slots.budget ?? 1000 },
      });
    }
    const text = String(intentResult.utterance || "用户联动计划").slice(0, 60);
    return {
      goal: intentResult.utterance,
      nodes: [
        { id: "n1", action: "cross.customPlan", label: "创建联动计划", params: { when: text, action: text }, dependsOn: [], status: "PENDING" },
      ],
    };
  }

  // 简单映射
  const simple = SIMPLE_TOOL_MAP[intent];
  if (simple) {
    const params: Record<string, unknown> = {};
    for (const k of simple.paramKeys) if (slots[k] !== undefined) params[k] = slots[k];
    return {
      goal: intentResult.utterance,
      nodes: [{ id: "n1", action: simple.action, label: simple.label, params, dependsOn: [], status: "PENDING" }],
    };
  }

  // 无规划（chitchat/help/out_of_scope/risk_assess 等）→ 空计划
  return { goal: intentResult.utterance, nodes: [] };
}
