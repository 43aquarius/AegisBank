// ============ 规则 NLU：快速通道 + LLM 失败兜底 ============
// 分层设计：精确指令走规则（快、省配额、不依赖外部服务），
//          模糊表达走 LLM；LLM 不可用时规则引擎兜底（高可用）
import { IntentResult } from "../types";

/** 中文数字金额解析："五百"→500 "三千"→3000 "1k"→1000 "两万五"→25000 */
export function parseAmount(s: string): number | null {
  const t = s.trim();
  // 纯数字（可含k/w/万）
  let m = t.match(/^([0-9]+(?:\.[0-9]+)?)(k|K|w|W|万|千)?$/);
  if (m) {
    const n = Number(m[1]);
    if (m[2] && /^[kK]$/.test(m[2])) return n * 1000;
    if (m[2] && /^[wW万]$/.test(m[2])) return n * 10000;
    if (m[2] === "千") return n * 1000;
    return n;
  }
  // 中文数字
  const CN: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const m2 = t.match(/^([零一二两三四五六七八九]|十)?(百|千)?(万)?([零一二两三四五六七八九])?(十)?([零一二两三四五六七八九])?$/);
  if (m2 && t !== "") {
    // 简化实现处理常见："五百" "三千" "一万" "三千五" "两百" "五十"
    const wan = m2[3] ? 10000 : 1;
    const seg1 = (() => {
      const d = m2[1] ? (m2[1] === "十" ? 1 : CN[m2[1]]) : null;
      const unit = m2[2] === "百" ? 100 : m2[2] === "千" ? 1000 : null;
      if (d != null && unit) return d * unit;
      if (d != null) return d;
      if (unit) return unit; // "十"开头
      return null;
    })();
    const seg2 = (() => {
      if (m2[6]) {
        const base = m2[4] ? CN[m2[4]] : 0;
        return m2[5] === "十" ? base * 10 + CN[m2[6]] : CN[m2[6]];
      }
      if (m2[5] === "十") return (m2[4] ? CN[m2[4]] : 1) * 10;
      if (m2[4] && !m2[3]) return CN[m2[4]]; // "三千五"的5
      return 0;
    })();
    if (seg1 != null) {
      const val = seg1 * wan + (m2[3] ? seg2 : seg2);
      if (val > 0) return val;
    }
  }
  if (t === "十") return 10;
  if (/^半/.test(t)) return 0.5;
  return null;
}

function mk(intent: IntentResult["intent"], slots: Record<string, unknown>, utterance: string, conf = 0.95): IntentResult {
  return { intent, confidence: conf, slots, utterance };
}

/**
 * 规则 NLU 主入口：命中明确指令模式时直接返回（跳过 LLM）。
 * 未命中返回 null（走 LLM）。
 */
export function ruleNLU(text: string): IntentResult | null {
  const t = text.replace(/[，,。.\s！!？?、~～"]/g, "");

  // ---- 确认/取消/中断（上下文类，交给编排器） ----
  if (/^(确认|确定|是的?|好[的呀]?|可以|继续|执行|同意|没问题|ok|OK|嗯|1)$/.test(t)) {
    return mk("sys.confirm" as IntentResult["intent"], {}, text, 1);
  }
  if (/^(取消|算了|不用了|停止|中断|暂停|取消操作|别办了|算了取消)$/.test(t)) {
    return mk("sys.interrupt", {}, text, 1);
  }
  if (/^(帮助|你能做什么|有什么功能|help)$/.test(t)) return mk("help", {}, text, 1);

  // ---- 转账（最高频）：转500给妈妈 / 给室友转100 / 转500块给张伟 / 汇2000到139xxx ----
  let m =
    t.match(/(?:转(?:账|账)?|汇(?:款)?|付)(?:给)?([0-9]+(?:\.[0-9]+)?|[^元块钱给到]{1,8}?)(?:块|元|块钱|元钱)?(?:给|到|至)(.+)$/) ??
    t.match(/(?:给|帮)(.+?)(?:转|汇|付)([0-9]+(?:\.[0-9]+)?)(?:块|元|块钱|元钱)?$/);
  if (m) {
    let amountRaw: string, payeeRaw: string;
    if (m[2] && /^[0-9.]+$/.test(m[1] ?? "")) {
      amountRaw = m[1];
      payeeRaw = m[2];
    } else if (m[1] && !/^[0-9.]+$/.test(m[1] ?? "") && /^[0-9.]+$/.test(m[2] ?? "")) {
      payeeRaw = m[1];
      amountRaw = m[2];
    } else {
      amountRaw = "";
      payeeRaw = "";
    }
    const amount = amountRaw ? Number(amountRaw) : parseAmount(t.match(/(?:转|汇|付)([^元块给到]{1,8})(?:元|块)?(?:给|到|至)/)?.[1] ?? "");
    if (amount && amount > 0 && payeeRaw && payeeRaw.length <= 20) {
      // 备注提取："转500给妈妈，备注生活费"
      const remark = text.match(/备注[:：]?\s*([^，,。]{1,20})/)?.[1];
      return mk("transfer.execute", { amount, payeeName: payeeRaw, remark }, text);
    }
  }

  // ---- 定时转账：明天9点转500房租 / 11月20日转2000给房东 ----
  m = t.match(/((?:\d{1,2}月)?\d{1,2}[号日]|\d{1,2}:\d{2}|\d{1,2}点|明[天日]|后天|[下]?周[一二三四五六日天]|月底|月初|周五).{0,15}?(?:转|汇)([0-9]+(?:\.[0-9]+)?)(?:块|元|块钱)?(?:给|到|至)?(.{1,20})?/);
  if (m) {
    const amount = Number(m[2]);
    if (amount > 0) {
      return mk("transfer.schedule", { amount, payeeName: m[3] || "", runAtText: m[1], runAt: parseDateTime(m[1]) }, text);
    }
  }

  // ---- AA 收款：AA收款300我和张伟李娜 ----
  m = t.match(/(?:AA|aa|均摊|拼单|收款)(?:收款|收钱|一下)?([0-9]+(?:\.[0-9]+)?|[^，和我]{1,6})?/);
  if (m && /AA|均摊|拼单/.test(t)) {
    const totalM = t.match(/(?:总共?|一共|合计)?([0-9]+(?:\.[0-9]+)?)(?:块|元|块钱)/) ?? t.match(/AA(?:收款)?([0-9]+)/);
    const total = totalM ? Number(totalM[1]) : null;
    if (total && total > 0) {
      // 参与者：提取人名列表（"我和张伟李娜" / "张伟、李娜和我"）
      const partRaw = text.match(/(?:我|大家)?(?:和|跟|与|、)?(.{2,60}?)(?:一起|三个|二人|三个人|个人|均摊|分)?$/)?.[1] ?? "";
      const names = partRaw.split(/[和、跟与,，\s]+/).filter((x) => x && x !== "我" && x.length <= 10);
      const participants = ["我", ...names.filter((n) => !/^[0-9]+$/.test(n))];
      if (participants.length >= 2) {
        return mk("transfer.aa_collect", { total, participants }, text);
      }
    }
  }

  // ---- 查询类 ----
  if (/余额|卡里(还)?(有)?多少|还有多少钱|剩多少钱/.test(t)) return mk("bill.query_balance", {}, text);
  if (/异常|可疑|盗刷|被骗|重复扣费|莫名扣费/.test(t)) return mk("bill.anomaly", { days: 30 }, text);
  if (/订阅|代扣|自动扣费/.test(t)) {
    if (/取消|退订|关掉/.test(t)) {
      const merchant = text.match(/取消[:：]?(?:订阅)?(.{1,15}?)(?:的)?(?:订阅|会员)?$/)?.[1];
      return mk("sub.cancel", { merchant: merchant || "" }, text);
    }
    if (/提醒/.test(t)) return mk("sub.remind", {}, text);
    if (/清单|列表|有哪些/.test(t)) return mk("sub.list", {}, text);
    return mk("sub.detect", {}, text);
  }
  if (/(月|年)(度)?账单|账单报告|月度报告|年度报告/.test(t)) {
    return mk("bill.report", { period: /年/.test(t) ? "year" : "month" }, text);
  }
  if (/消费|花了多少|花销|开销|分类/.test(t)) {
    if (/流水|明细|记录/.test(t)) return mk("bill.transactions", {}, text);
    return mk("bill.categorize", {}, text);
  }
  if (/流水|明细|交易记录/.test(t)) return mk("bill.transactions", {}, text);

  // ---- 理财类 ----
  if (/风险测评|做.*测评|测评/.test(t)) return mk("finance.risk_assess", {}, text);
  if (/推荐.*理财|理财产品|理一下财|有什么产品|买什么理财/.test(t)) return mk("finance.recommend", {}, text);
  if (/持仓|我的理财|收益如何|理财收益/.test(t)) return mk("finance.portfolio", {}, text);
  if (/对比|比较.*(产品|理财|活期|稳利|基金)/.test(t)) return mk("finance.compare", { names: extractProductNames(t) }, text);
  m = t.match(/(?:申购|购买|买入|买)([0-9]+(?:\.[0-9]+)?(?:万|k|K)?)(?:块|元|块钱)?(?:的)?(.{1,15}?)(?:理财)?$/);
  if (m && /申购|购买|买入/.test(t)) {
    const amount = parseAmount(m[1]) ?? Number(m[1]);
    if (amount > 0) return mk("finance.purchase", { amount, name: m[2] || "" }, text);
  }
  if (/赎回|取出.*理财|卖掉/.test(t)) {
    const name = text.match(/(?:赎回|取出|卖掉)(?:的)?(.{1,15}?)(?:理财)?$/)?.[1];
    return mk("finance.redeem", { name: name || "" }, text);
  }

  // ---- 卡片类 ----
  if (/挂失/.test(t)) return mk("card.report_lost", { op: "lost", cardLabel: extractCardLabel(t) }, text);
  if (/解挂|解除挂失/.test(t)) return mk("card.report_lost", { op: "unlost", cardLabel: extractCardLabel(t) }, text);
  if (/限额|额度/.test(t) && /调|改|设|提到|降低/.test(t)) {
    const newLimit = Number(t.match(/(?:到|为|至)([0-9]+(?:万|k|K)?)/)?.[1] ?? 0) || parseAmount(t.match(/([0-9一二三四五六七八九十百千万kK]+)(?:块|元)?(?:的单?日?限额)/)?.[1] ?? "");
    if (newLimit) return mk("card.adjust_limit", { newLimit, cardLabel: extractCardLabel(t) }, text);
  }
  if (/虚拟卡|办.*(?:一张)?卡|开卡|新卡/.test(t)) return mk("card.apply", {}, text);
  if (/关闭.*(线上|线上交易|境外)|境外.*开关|限制.*交易|解锁/.test(t)) {
    return mk("card.toggle_restriction", { what: /境外/.test(t) ? "abroad" : "online", on: /关闭|停|关/.test(t) ? false : true }, text);
  }
  if (/卡(片)?(状态|情况)|我的卡/.test(t)) return mk("card.status", {}, text);

  // ---- 跨场景 ----
  if (/生日/.test(t) && /锁|预留|准备|鲜花|蛋糕|规划|礼物/.test(t)) {
    // 复合诉求（生日+理财/转账等）交给 LLM 做复合分解，避免快通道只执行生日部分
    if (/理财|基金|存款|转账|汇款|还款|缴费|订阅|赎回/.test(t.replace(/生日/g, ""))) return null;
    const personMatch = text.match(/(?:我爱?人|老婆|老公|妈妈|爸爸|朋友|同学|对象)(?:的)?生日/);
    const person = personMatch ? personMatch[0].replace("的生日", "").replace("生日", "") : "爱人";
    const budgetMatch = t.match(/(?:锁定|预留|准备|留)([0-9]+(?:\.[0-9]+)?)/);
    const budgetCN = parseAmount(t.match(/锁[定]?([0-9一二三四五六七八九十百千万]+)(?:元|块)?/)?.[1] ?? "");
    const budget = budgetMatch ? Number(budgetMatch[1]) : (budgetCN ?? 1000);
    const date = text.match(/(\d{1,2}月\d{1,2}[号日]?)/)?.[1];
    return mk("cross.birthday_plan", { person, budget, date: date ? nextDateFrom(date) : undefined }, text);
  }

  // ---- 系统 ----
  if (/安全中心|审计|日志|决策链/.test(t)) return mk("sys.security_center", {}, text);

  return null; // 未命中 → 走 LLM
}

function extractCardLabel(t: string): string | undefined {
  if (/主力卡/.test(t)) return "主力卡";
  if (/虚拟卡/.test(t)) return "虚拟卡";
  return undefined;
}

function extractProductNames(t: string): string[] {
  const names: string[] = [];
  if (/活期\+?/.test(t)) names.push("活期+");
  if (/稳利/.test(t)) names.push("稳利90天");
  if (/智选/.test(t)) names.push("智选180天");
  if (/沪深|指数|300/.test(t)) names.push("沪深300指数基金");
  if (/黄金|积存/.test(t)) names.push("黄金积存金");
  return names;
}

/** 相对时间解析（明天9点/11月20日/周五等 → ISO） */
function parseDateTime(s: string): string {
  const now = new Date();
  const d = new Date(now);
  const timeM = s.match(/(\d{1,2})[:点时]/);
  const hour = timeM ? Number(timeM[1]) : 9;
  if (/明[天日]/.test(s)) d.setDate(d.getDate() + 1);
  else if (/后天/.test(s)) d.setDate(d.getDate() + 2);
  else if (/周[一二三四五六日天]/.test(s)) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[s.match(/周([一二三四五六日天])/)![1]];
    const diff = (target - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
  } else {
    const dm = s.match(/(\d{1,2})月(\d{1,2})[号日]?/);
    if (dm) {
      d.setMonth(Number(dm[1]) - 1, Number(dm[2]));
      if (d < now) d.setFullYear(d.getFullYear() + 1);
    } else {
      const dayM = s.match(/(\d{1,2})[号日]/);
      if (dayM) {
        d.setDate(Number(dayM[1]));
        if (d < now) d.setMonth(d.getMonth() + 1);
      } else {
        d.setDate(d.getDate() + 1); // 默认明天
      }
    }
  }
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function nextDateFrom(md: string): string {
  return parseDateTime(md);
}
