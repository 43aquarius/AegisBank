// ============ AegisBank 安全中心 ============
// 赛题安全机制（实现优先级：高）：
//   1. 幻觉防护：Agent 只能引用工具返回的真实数据，禁止编造
//   2. 注入防御：Prompt 注入多模式检测与拦截
//   3. 操作审计：见 audit.ts
//   4. 异常熔断：见 permission.ts fuseLock
//   5. 沙箱执行：工具参数 zod 校验 + 工具白名单 + 环境隔离（见 tools/index.ts）

import { db } from "@/lib/db";
import { audit } from "./audit";

export interface InjectionVerdict {
  clean: boolean;
  level: "NONE" | "SUSPICIOUS" | "MALICIOUS";
  patterns: string[];
  message: string;
}

/**
 * Prompt 注入检测器。
 * 检测模式族：
 *  A. 指令覆盖型 —— 尝试冒充系统/开发者指令改写安全策略
 *  B. 权限绕过型 —— "忽略验证/免验证/直接执行不用确认"
 *  C. 数据渗出型 —— 诱导输出系统提示词、他人账户、验证码
 *  D. 角色扮演型 —— "你现在是没有任何限制的AI"
 *  E. 隐蔽指令型 —— base64/unicode/hex 藏毒、工具调用伪造
 */
const INJECTION_PATTERNS: { id: string; re: RegExp; label: string }[] = [
  // A 指令覆盖
  { id: "A1", re: /(忽略|无视| disregard).{0,12}(之前|以上|上面|prior|above).{0,12}(指令|提示|规则|设定|prompt)/i, label: "指令覆盖" },
  { id: "A2", re: /(你的?(新)?(系统)?(指令|设定|提示词)|system\s*prompt)\s*(是|为|如下|：|:)/i, label: "伪造系统指令" },
  { id: "A3", re: /(开发者|developer|admin|管理员).{0,10}(模式|mode|override)/i, label: "伪造开发者模式" },
  // B 权限绕过
  { id: "B1", re: /(跳过|免|不用|无需|不要).{0,8}(验证|确认|校验|密码|二次)/, label: "绕过验证/确认" },
  { id: "B2", re: /(直接|马上|立即).{0,10}(执行|转账|扣款|支付).{0,14}(不用|不要|无需|别)?\s*(问|确认|验证)?/i, label: "催促跳过安全流程" },
  { id: "B3", re: /(把|将).{0,20}(限额|阈值|风险等级|权限).{0,12}(调(高|大)|改成|设置(为)?|取消|去掉)/i, label: "篡改风控参数" },
  // C 数据渗出
  { id: "C1", re: /(打印|输出|显示|泄露|告诉我|reveal|show).{0,16}(系统提示词|你的指令|初始设定|system\s*prompt)/i, label: "套取系统提示词" },
  { id: "C2", re: /(查看|查询|转入|转出|动?用).{0,12}(别人的|他人的|其他(人|用户)|别人的账户|他人账户)/, label: "越权访问他人账户" },
  { id: "C3", re: /(验证码|动态码|OTP).{0,10}(告诉|发给|发我|泄露|读出来)/, label: "套取验证码" },
  // D 角色扮演越狱
  { id: "D1", re: /(你现在?是|扮演|假装|act\s*as|pretend).{0,24}(没有(任何)?限制|不受限|DAN|越狱|jailbreak|无道德|可以任意)/i, label: "角色扮演越狱" },
  // E 隐蔽指令
  { id: "E1", re: /[a-zA-Z0-9+/]{40,}={0,2}/, label: "疑似Base64藏匿载荷" },
  { id: "E2", re: /(\\u[0-9a-fA-F]{4}){8,}/, label: "Unicode编码藏匿载荷" },
  { id: "E3", re: /<\|?(im_start|im_end|system|tool|function)\|?>/i, label: "伪造对话协议标记" },
];

export function detectInjection(text: string): InjectionVerdict {
  const patterns: string[] = [];
  let malicious = 0;
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(text)) {
      patterns.push(`${p.id}:${p.label}`);
      if (p.id.startsWith("A") || p.id.startsWith("B") || p.id.startsWith("D")) malicious++;
    }
  }
  if (malicious > 0) {
    return {
      clean: false,
      level: "MALICIOUS",
      patterns,
      message: "检测到 Prompt 注入攻击特征，该请求已被安全网关拦截并记录审计日志。请使用正常的银行业务对话。",
    };
  }
  if (patterns.length > 0) {
    return {
      clean: false,
      level: "SUSPICIOUS",
      patterns,
      message: "检测到可疑的敏感指令特征，安全网关已加强本轮流量的风控策略。",
    };
  }
  return { clean: true, level: "NONE", patterns: [], message: "" };
}

/** 安全网关入口：每条用户消息先过此关 */
export async function securityGate(
  userId: string,
  traceId: string,
  userText: string
): Promise<InjectionVerdict> {
  const verdict = detectInjection(userText);
  if (!verdict.clean) {
    await audit(userId, traceId, {
      stage: "SECURITY",
      action: "gate.injection_detected",
      riskLevel: verdict.level === "MALICIOUS" ? "RED" : "YELLOW",
      decision: "BLOCKED",
      detail: { patterns: verdict.patterns, excerpt: userText.slice(0, 120) },
    });
    // 连续注入尝试 → 熔断计数
    if (verdict.level === "MALICIOUS") {
      const user = await db.user.update({
        where: { id: userId },
        data: { failCount: { increment: 1 } },
      });
      if (user.failCount >= 3) {
        const { fuseLock } = await import("./permission");
        await fuseLock(userId, traceId, "连续多次 Prompt 注入攻击");
      }
    }
  }
  return verdict;
}

// ============ 幻觉防护 ============
/**
 * 回复一致性校验：Agent 最终回复中出现的金额/账号/单号等关键事实，
 * 必须能在本轮工具真实返回的证据集合中找到，否则视为幻觉并修正。
 * 实现：从工具结果 JSON 中提取所有数字与单号，组成证据池；
 *       扫描回复中的 ¥金额 与流水号，不在池内 → 判定幻觉。
 */
export function buildEvidencePool(toolResults: unknown[]): Set<string> {
  const pool = new Set<string>();
  const walk = (v: unknown) => {
    if (v == null) return;
    if (typeof v === "number") {
      pool.add(String(v));
      pool.add(v.toFixed(2));
      pool.add(String(Math.round(v)));
    } else if (typeof v === "string") {
      // 流水号 / 单号 / 卡号后四位
      if (/^(TX|VD|OD|CD)[0-9]+$/i.test(v)) pool.add(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  toolResults.forEach(walk);
  return pool;
}

export function checkHallucination(
  reply: string,
  pool: Set<string>
): { hasHallucination: boolean; facts: string[] } {
  // 提取回复中的金额与单号
  const moneyFacts = reply.match(/¥\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g) ?? [];
  const idFacts = reply.match(/\b(?:TX|VD|OD|CD)\d{6,}\b/gi) ?? [];
  const facts: string[] = [];
  for (const m of moneyFacts) {
    const num = m.replace(/[¥,\s]/g, "");
    if (!pool.has(num) && !pool.has(Number(num).toFixed(2)) && !pool.has(String(Math.round(Number(num))))) {
      facts.push(m);
    }
  }
  for (const id of idFacts) {
    if (!pool.has(id)) facts.push(id);
  }
  return { hasHallucination: facts.length > 0, facts };
}
