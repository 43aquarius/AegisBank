// ============ AegisBank 类型定义 ============
// 权限分级 + 安全中心 + Agent 编排 全局类型

// ---------- 权限分级 ----------
export type RiskLevel = "GREEN" | "YELLOW" | "RED";

export const RISK_META: Record<RiskLevel, { label: string; policy: string; color: string }> = {
  GREEN: { label: "低风险", policy: "自动执行", color: "#10b981" },
  YELLOW: { label: "中风险", policy: "用户确认", color: "#f59e0b" },
  RED: { label: "高风险", policy: "强验证", color: "#ef4444" },
};

// ---------- 意图与槽位 ----------
// 意图枚举（六大厅景 + 兜底）
export type IntentType =
  // 0 通用
  | "chitchat"          // 闲聊/问候
  | "out_of_scope"      // 超范围请求（兜底拒绝）
  | "help"              // 能力说明
  // 1 智能转账
  | "transfer.query_payee"   // 找收款人
  | "transfer.execute"       // 转账
  | "transfer.schedule"      // 定时转账
  | "transfer.aa_collect"    // AA收款
  | "transfer.query_status"  // 转账进度查询
  // 2 账单分析
  | "bill.query_balance"     // 余额查询
  | "bill.transactions"      // 交易流水查询
  | "bill.categorize"        // 消费分类统计
  | "bill.anomaly"           // 异常交易识别
  | "bill.report"            // 月度/年度账单报告
  // 3 理财操作
  | "finance.recommend"      // 产品推荐
  | "finance.compare"        // 产品对比
  | "finance.risk_assess"    // 风险测评
  | "finance.purchase"       // 申购
  | "finance.redeem"         // 赎回
  | "finance.portfolio"      // 持仓查询
  // 4 卡片管理
  | "card.apply"             // 卡申请（虚拟卡）
  | "card.adjust_limit"      // 额度调整
  | "card.toggle_restriction"// 交易限制开关
  | "card.report_lost"       // 挂失/解挂
  | "card.status"            // 卡片状态查询
  // 5 订阅代扣
  | "sub.detect"             // 识别订阅
  | "sub.remind"             // 续费提醒设置
  | "sub.cancel"             // 取消订阅
  | "sub.list"               // 订阅列表
  // 6 跨场景联动
  | "cross.birthday_plan"    // 生日规划（锁定资金+订购）
  | "cross.custom_plan"      // 自定义联动计划
  // 系统级
  | "sys.security_center"    // 查看安全中心/审计
  | "sys.interrupt"          // 中断当前任务
  | "sys.task_status";       // 任务进度查询

// 意图 → 默认风险等级映射（permission.ts 细化）
export const INTENT_RISK: Record<string, RiskLevel> = {
  // 查询类 → 绿
  "bill.query_balance": "GREEN",
  "bill.transactions": "GREEN",
  "bill.categorize": "GREEN",
  "bill.anomaly": "GREEN",
  "bill.report": "GREEN",
  "finance.portfolio": "GREEN",
  "finance.recommend": "GREEN",
  "finance.compare": "GREEN",
  "sub.list": "GREEN",
  "sub.detect": "GREEN",
  "card.status": "GREEN",
  "transfer.query_payee": "GREEN",
  "transfer.query_status": "GREEN",
  "sys.security_center": "GREEN",
  "sys.task_status": "GREEN",
  "chitchat": "GREEN",
  "help": "GREEN",
  // 确认类 → 黄
  "transfer.execute": "YELLOW",
  "transfer.schedule": "YELLOW",
  "transfer.aa_collect": "YELLOW",
  "sub.cancel": "YELLOW",
  "sub.remind": "YELLOW",
  "card.apply": "YELLOW",
  "card.toggle_restriction": "YELLOW",
  "finance.risk_assess": "YELLOW",
  "cross.custom_plan": "YELLOW",
  // 强验证类 → 红
  "finance.purchase": "RED",
  "finance.redeem": "RED",
  "card.adjust_limit": "RED",
  "card.report_lost": "RED",
  "cross.birthday_plan": "RED", // 涉及资金锁定+对外订购
  "out_of_scope": "RED",
};

// ---------- 工具调用协议 ----------
export interface ToolCall {
  action: string;              // 工具名
  params: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  // 幻觉防护：Agent 回复必须引用真实数据引用
  evidence?: {
    source: string;            // 数据来源（表/工具名）
    snapshot: string;          // 结果快照 hash
  };
}

// ---------- 意图识别结果 ----------
export interface IntentResult {
  intent: IntentType;
  confidence: number;          // 0-1
  slots: Record<string, unknown>; // 金额/收款人/日期等
  utterance: string;           // 归一化后的用户诉求
  needsClarify?: string[];     // 需要追问的槽位
  compound?: boolean;          // 是否复合任务（需 DAG）
}

// ---------- DAG 任务规划 ----------
export interface DagNode {
  id: string;
  action: string;              // 对应工具/子意图
  label: string;               // 展示给用户的步骤名
  params: Record<string, unknown>;
  dependsOn: string[];
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED" | "WAITING";
  result?: ToolResult;
}

export interface DagPlan {
  goal: string;
  nodes: DagNode[];
}

// ---------- 对话消息载荷（前端渲染协议） ----------
export type MessagePayload =
  | { type: "intent"; intent: string; confidence: number }
  | { type: "dag"; plan: DagPlan }                         // 任务进度
  | {
      type: "confirm_request";                             // 黄色确认卡
      taskId: string;
      nodeId?: string;
      title: string;
      risk: RiskLevel;
      detail: Record<string, unknown>;                     // 操作详情键值对
      summary: string;
    }
  | {
      type: "verify_request";                              // 红色强验证卡
      traceId: string;
      method: "SMS" | "FACE";
      title: string;
      risk: RiskLevel;
      detail: Record<string, unknown>;
      summary: string;
    }
  | {
      type: "card";                                        // 富信息卡（产品对比/报告摘要/订阅清单等）
      card: string;                                        // 渲染器名
      data: unknown;
    }
  | {
      type: "security_alert";                              // 安全告警（注入拦截/熔断）
      kind: string;                                        // INJECTION | FUSE | ANOMALY
      message: string;
    }
  | {
      type: "task_done";                                   // 任务完成摘要
      goal: string;
      steps: { label: string; ok: boolean }[];
    };

// ---------- 审计 ----------
export interface AuditEntry {
  stage: "INTENT" | "PERMISSION" | "CONFIRM" | "VERIFY" | "EXECUTE" | "VALIDATE" | "SECURITY" | "FUSE";
  action: string;
  riskLevel?: RiskLevel;
  decision: "ALLOW" | "DENY" | "PENDING" | "CONFIRMED" | "VERIFIED" | "BLOCKED";
  detail?: Record<string, unknown>;
}
