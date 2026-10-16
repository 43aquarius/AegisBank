"use client";

// ============ 消息渲染器：文本/DAG进度/确认卡/验证卡/安全告警/完成摘要/富卡片 ============

import React, { useState } from "react";
import { ChatMessage, DagNode, Payload } from "./types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
  ShieldAlert,
  Lock,
  Smartphone,
  TrendingUp,
  PieChart,
  Bell,
  CreditCard,
  Repeat,
  PartyPopper,
  FileText,
  ListChecks,
  Eye,
} from "lucide-react";

const STATUS_ICON: Record<string, React.ReactNode> = {
  DONE: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />,
  FAILED: <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />,
  RUNNING: <Loader2 className="h-3.5 w-3.5 text-amber-500 animate-spin shrink-0" />,
  PENDING: <Circle className="h-3.5 w-3.5 text-zinc-300 shrink-0" />,
  WAITING: <Circle className="h-3.5 w-3.5 text-zinc-300 shrink-0" />,
  SKIPPED: <Circle className="h-3.5 w-3.5 text-zinc-300 shrink-0" />,
};

export function MessageBubble({
  msg,
  onConfirm,
  onVerify,
  busy,
}: {
  msg: ChatMessage;
  onConfirm: (taskId: string, ok: boolean) => void;
  onVerify: (code: string) => void;
  busy: boolean;
}) {
  if (msg.role === "system_event" && !shouldRenderSystem(msg)) return null;

  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div className={`max-w-[92%] sm:max-w-[85%] ${isUser ? "order-2" : ""}`}>
        {/* 主文本气泡 */}
        {msg.content && (
          <div
            className={
              isUser
                ? "rounded-2xl rounded-br-md bg-emerald-700 text-white px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap shadow-sm"
                : "rounded-2xl rounded-bl-md bg-white border border-zinc-200 text-zinc-800 px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap shadow-sm"
            }
          >
            {msg.content}
          </div>
        )}
        {/* 载荷渲染 */}
        {msg.payload && (
          <PayloadRenderer payload={msg.payload} onConfirm={onConfirm} onVerify={onVerify} busy={busy} />
        )}
      </div>
    </div>
  );
}

function shouldRenderSystem(msg: ChatMessage): boolean {
  // CARD 系统消息渲染富卡片；PENDING_VERIFY 等不渲染
  return msg.payload?.type === "card";
}

function PayloadRenderer({
  payload,
  onConfirm,
  onVerify,
  busy,
}: {
  payload: Payload;
  onConfirm: (taskId: string, ok: boolean) => void;
  onVerify: (code: string) => void;
  busy: boolean;
}) {
  switch (payload.type) {
    case "dag":
      return <DagCard plan={payload.plan as { nodes: DagNode[] }} />;
    case "confirm_request":
      return <ConfirmCard payload={payload} onConfirm={onConfirm} busy={busy} />;
    case "verify_request":
      return <VerifyCard payload={payload} onVerify={onVerify} busy={busy} />;
    case "security_alert":
      return <SecurityAlert message={String(payload.message)} />;
    case "task_done":
      return <TaskDone payload={payload} />;
    case "card":
      return <RichCard name={String(payload.card)} data={payload.data} />;
    case "intent":
      return null; // 意图标签弱化展示
    default:
      return null;
  }
}

// ---------- DAG 任务进度卡 ----------
function DagCard({ plan }: { plan: { nodes: DagNode[] } }) {
  const done = plan.nodes.filter((n) => n.status === "DONE").length;
  const pct = Math.round((done / plan.nodes.length) * 100);
  return (
    <div className="mt-2 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-600">
          <ListChecks className="h-3.5 w-3.5" /> 任务规划（DAG）
        </div>
        <span className="text-[11px] text-zinc-400">{done}/{plan.nodes.length}</span>
      </div>
      <Progress value={pct} className="h-1 mb-2" />
      <div className="space-y-1.5">
        {plan.nodes.map((n, i) => (
          <div key={n.id} className="flex items-center gap-2 text-[13px] text-zinc-700">
            {STATUS_ICON[n.status]}
            <span>{n.label}</span>
            {n.dependsOn.length > 0 && (
              <span className="text-[10px] text-zinc-400">← 第{n.dependsOn.length}步后</span>
            )}
            {i === 0 && n.status === "PENDING" && null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 黄色确认卡 ----------
function ConfirmCard({
  payload,
  onConfirm,
  busy,
}: {
  payload: Payload & { taskId: string };
  onConfirm: (taskId: string, ok: boolean) => void;
  busy: boolean;
}) {
  const detail = (payload.detail ?? {}) as Record<string, unknown>;
  return (
    <div className="mt-2 rounded-xl border-2 border-amber-300 bg-amber-50 p-3.5 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <Badge className="bg-amber-500 hover:bg-amber-500 text-white text-[11px]">🟡 中风险 · 需确认</Badge>
      </div>
      <div className="text-[14px] font-semibold text-zinc-800 mb-2">{String(payload.title)}</div>
      <div className="space-y-1 mb-3">
        {Object.entries(detail).map(([k, v]) => (
          <div key={k} className="flex justify-between text-[13px] border-b border-amber-100 pb-1">
            <span className="text-zinc-500">{prettyKey(k)}</span>
            <span className="font-medium text-zinc-800">{prettyVal(v)}</span>
          </div>
        ))}
      </div>
      <div className="text-[12px] text-amber-700 mb-3">{String(payload.summary ?? "")}</div>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1 bg-amber-600 hover:bg-amber-700 text-white"
          disabled={busy}
          onClick={() => onConfirm(String(payload.taskId), true)}
        >
          确认执行
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 border-zinc-300"
          disabled={busy}
          onClick={() => onConfirm(String(payload.taskId), false)}
        >
          取消
        </Button>
      </div>
    </div>
  );
}

// ---------- 红色强验证卡 ----------
function VerifyCard({
  payload,
  onVerify,
  busy,
}: {
  payload: Payload & { traceId: string };
  onVerify: (code: string) => void;
  busy: boolean;
}) {
  const [code, setCode] = useState("");
  const detail = (payload.detail ?? {}) as Record<string, unknown>;
  return (
    <div className="mt-2 rounded-xl border-2 border-red-300 bg-red-50 p-3.5 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <Badge className="bg-red-600 hover:bg-red-600 text-white text-[11px]">🔴 高风险 · 强验证</Badge>
      </div>
      <div className="text-[14px] font-semibold text-zinc-800 mb-1">{String(payload.title)}</div>
      <div className="space-y-1 mb-2">
        {Object.entries(detail).map(([k, v]) => (
          <div key={k} className="flex justify-between text-[13px] border-b border-red-100 pb-1">
            <span className="text-zinc-500">{prettyKey(k)}</span>
            <span className="font-medium text-zinc-800">{prettyVal(v)}</span>
          </div>
        ))}
      </div>
      <div className="flex items-start gap-1.5 text-[12px] text-red-700 mb-3">
        <Smartphone className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>{String(payload.summary ?? "")}</span>
      </div>
      <div className="flex gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="6 位短信验证码"
          inputMode="numeric"
          className="flex-1 h-9 tracking-[0.3em] font-mono"
        />
        <Button
          size="sm"
          className="bg-red-600 hover:bg-red-700 text-white"
          disabled={busy || code.length !== 6}
          onClick={() => onVerify(code)}
        >
          验证并执行
        </Button>
      </div>
    </div>
  );
}

// ---------- 安全告警 ----------
function SecurityAlert({ message }: { message: string }) {
  return (
    <div className="mt-2 rounded-xl border-2 border-red-400 bg-red-100/80 p-3.5 flex gap-2.5 shadow-sm">
      <ShieldAlert className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
      <div>
        <div className="text-[13px] font-bold text-red-800">安全网关拦截</div>
        <div className="text-[13px] text-red-700 mt-1 leading-relaxed">{message}</div>
        <div className="text-[11px] text-red-500 mt-1.5 flex items-center gap-1">
          <Lock className="h-3 w-3" /> 该事件已写入操作审计日志
        </div>
      </div>
    </div>
  );
}

// ---------- 任务完成摘要 ----------
function TaskDone({ payload }: { payload: Payload }) {
  const steps = (payload.steps ?? []) as { label: string; ok: boolean }[];
  return (
    <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 shadow-sm">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700 mb-1.5">
        <CheckCircle2 className="h-4 w-4" /> 任务完成
      </div>
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-2 text-[13px] text-zinc-700 py-0.5">
          {s.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-red-500" />
          )}
          {s.label}
        </div>
      ))}
    </div>
  );
}

// ---------- 富信息卡片路由 ----------
function RichCard({ name, data }: { name: string; data: unknown }) {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (name) {
    case "spending":
      return <SpendingCard data={d} />;
    case "anomaly":
      return <AnomalyCard data={d} />;
    case "report":
      return <ReportCard data={d} />;
    case "balance":
      return <BalanceCard data={d} />;
    case "compare":
      return <CompareCard data={d} />;
    case "products":
      return <ProductsCard data={d} />;
    case "portfolio":
      return <PortfolioCard data={d} />;
    case "subs":
      return <SubsCard data={d} />;
    case "cards":
      return <CardsCard data={d} />;
    case "transactions":
      return <TransactionsCard data={d} />;
    case "risk_assess":
      return <RiskAssessCard data={d} />;
    case "risk_result":
      return <RiskResultCard data={d} />;
    default:
      return null;
  }
}

const cardShell =
  "mt-2 rounded-xl border border-zinc-200 bg-white p-3.5 shadow-sm";

// 消费分类
function SpendingCard({ data }: { data: Record<string, unknown> }) {
  const cats = (data.categories ?? []) as { category: string; total: number; count: number; ratio: number }[];
  const COLORS = ["#059669", "#10b981", "#34d399", "#6ee7b7", "#a7f3d0", "#d1fae5", "#e6f7ef"];
  return (
    <div className={cardShell}>
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-600 mb-2">
        <PieChart className="h-3.5 w-3.5" /> 近 {String(data.days ?? 30)} 天消费构成
      </div>
      <div className="text-[22px] font-bold text-zinc-900 mb-1">
        ¥{Number(data.totalOut ?? 0).toLocaleString()}
      </div>
      <div className="text-[11px] text-zinc-400 mb-3">{String(data.txCount ?? 0)} 笔支出</div>
      {/* 条形构成 */}
      <div className="space-y-2">
        {cats.slice(0, 7).map((c, i) => (
          <div key={c.category}>
            <div className="flex justify-between text-[12px] mb-0.5">
              <span className="text-zinc-600">{c.category}</span>
              <span className="text-zinc-800 font-medium">¥{c.total.toLocaleString()} · {c.ratio}%</span>
            </div>
            <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${c.ratio}%`, background: COLORS[i % COLORS.length] }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 异常交易
function AnomalyCard({ data }: { data: Record<string, unknown> }) {
  const list = (data.anomalies ?? []) as { rule: string; desc: string; merchant: string; amount: number; severity: string; time: string }[];
  return (
    <div className={cardShell}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-600">
          <ShieldAlert className="h-3.5 w-3.5 text-red-500" /> 异常交易扫描
        </div>
        <Badge variant={Number(data.count) > 0 ? "destructive" : "secondary"} className="text-[10px]">
          {Number(data.count) > 0 ? `${data.count} 项待核实` : "未发现异常"}
        </Badge>
      </div>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {list.map((a, i) => (
          <div key={i} className="rounded-lg bg-zinc-50 border border-zinc-100 p-2.5">
            <div className="flex justify-between items-center">
              <span className={`text-[11px] font-medium ${a.severity === "高" ? "text-red-600" : "text-amber-600"}`}>
                {a.rule} · {a.severity}风险
              </span>
              <span className="text-[13px] font-semibold text-zinc-800">¥{a.amount}</span>
            </div>
            <div className="text-[12px] text-zinc-600 mt-1">{a.desc}</div>
            <div className="text-[10px] text-zinc-400 mt-0.5">{a.merchant} · {new Date(a.time).toLocaleString("zh-CN")}</div>
          </div>
        ))}
        {list.length === 0 && <div className="text-[13px] text-zinc-500">近 {String(data.days)} 天交易未命中风控规则</div>}
      </div>
    </div>
  );
}

// 账单报告
function ReportCard({ data }: { data: Record<string, unknown> }) {
  const topCats = (data.topCategories ?? []) as { category: string; total: number }[];
  return (
    <div className={cardShell}>
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-600 mb-2">
        <FileText className="h-3.5 w-3.5" /> {String(data.title ?? "账单报告")}
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="rounded-lg bg-emerald-50 p-2 text-center">
          <div className="text-[10px] text-emerald-700">收入</div>
          <div className="text-[14px] font-bold text-emerald-800">¥{Number(data.totalIn ?? 0).toLocaleString()}</div>
        </div>
        <div className="rounded-lg bg-red-50 p-2 text-center">
          <div className="text-[10px] text-red-600">支出</div>
          <div className="text-[14px] font-bold text-red-700">¥{Number(data.totalOut ?? 0).toLocaleString()}</div>
        </div>
        <div className="rounded-lg bg-zinc-50 p-2 text-center">
          <div className="text-[10px] text-zinc-500">净额</div>
          <div className="text-[14px] font-bold text-zinc-800">¥{Number(data.net ?? 0).toLocaleString()}</div>
        </div>
      </div>
      <div className="space-y-1.5">
        {topCats.map((c) => (
          <div key={c.category} className="flex justify-between text-[12px]">
            <span className="text-zinc-600">{c.category}</span>
            <span className="font-medium text-zinc-800">¥{c.total.toLocaleString()}</span>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-zinc-500 mt-2.5 pt-2 border-t border-zinc-100">{String(data.insight ?? "")}</div>
    </div>
  );
}

// 余额
function BalanceCard({ data }: { data: Record<string, unknown> }) {
  return (
    <div className={cardShell}>
      <div className="text-[11px] text-zinc-500 mb-1">总资产（元）</div>
      <div className="text-[26px] font-bold text-zinc-900 tracking-tight">
        {Number(data.total ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3">
        <div className="rounded-lg bg-emerald-50 p-2">
          <div className="text-[10px] text-emerald-700">可用</div>
          <div className="text-[13px] font-semibold text-emerald-800">¥{Number(data.usable ?? 0).toLocaleString()}</div>
        </div>
        <div className="rounded-lg bg-amber-50 p-2">
          <div className="text-[10px] text-amber-700">锁定中</div>
          <div className="text-[13px] font-semibold text-amber-800">¥{Number(data.locked ?? 0).toLocaleString()}</div>
        </div>
        <div className="rounded-lg bg-sky-50 p-2">
          <div className="text-[10px] text-sky-700">理财</div>
          <div className="text-[13px] font-semibold text-sky-800">¥{Number(data.finance ?? 0).toLocaleString()}</div>
        </div>
      </div>
    </div>
  );
}

// 产品对比
function CompareCard({ data }: { data: Record<string, unknown> }) {
  const prods = (data.products ?? []) as { name: string; riskLevel: number; expectedRet: number; minAmount: number; lockDays: number }[];
  return (
    <div className={cardShell}>
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-600 mb-2">
        <TrendingUp className="h-3.5 w-3.5" /> 产品对比
      </div>
      <div className="grid grid-cols-2 gap-2">
        {prods.map((p) => (
          <div key={p.name} className="rounded-lg border border-zinc-200 p-2.5">
            <div className="text-[13px] font-semibold text-zinc-800">{p.name}</div>
            <div className="text-[18px] font-bold text-emerald-700 my-1">{p.expectedRet}%<span className="text-[10px] text-zinc-400">/年</span></div>
            <div className="text-[11px] text-zinc-500 space-y-0.5">
              <div>风险 R{p.riskLevel}</div>
              <div>起购 ¥{p.minAmount}</div>
              <div>{p.lockDays ? `锁 ${p.lockDays} 天` : "随时可取"}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 产品推荐
function ProductsCard({ data }: { data: Record<string, unknown> }) {
  const prods = (data.products ?? []) as { name: string; riskLevel: number; expectedRet: number; minAmount: number; lockDays: number; tags: string[]; desc: string }[];
  return (
    <div className={cardShell}>
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-600 mb-1">
        <TrendingUp className="h-3.5 w-3.5" /> 在售产品（已按适当性匹配）
      </div>
      <div className="text-[11px] text-zinc-400 mb-2">{String(data.riskNote ?? "")}</div>
      <div className="space-y-2 max-h-72 overflow-y-auto">
        {prods.map((p) => (
          <div key={p.name} className="rounded-lg border border-zinc-200 p-2.5 flex justify-between items-center">
            <div>
              <div className="text-[13px] font-semibold text-zinc-800">{p.name}</div>
              <div className="text-[11px] text-zinc-500">{p.desc}</div>
              <div className="flex gap-1 mt-1">
                {p.tags.map((t) => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">{t}</span>
                ))}
              </div>
            </div>
            <div className="text-right shrink-0 ml-2">
              <div className="text-[16px] font-bold text-emerald-700">{p.expectedRet}%</div>
              <div className="text-[10px] text-zinc-400">R{p.riskLevel} · ¥{p.minAmount}起</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 持仓
function PortfolioCard({ data }: { data: Record<string, unknown> }) {
  const holds = (data.holdings ?? []) as { name: string; riskLevel: number; amount: number; expectedRet: number; daysHeld: number }[];
  return (
    <div className={cardShell}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-600">
          <TrendingUp className="h-3.5 w-3.5" /> 理财持仓
        </div>
        <span className="text-[11px] text-emerald-700">预估收益 +¥{Number(data.estProfit ?? 0).toFixed(2)}</span>
      </div>
      <div className="text-[20px] font-bold text-zinc-900 mb-2">¥{Number(data.total ?? 0).toLocaleString()}</div>
      <div className="space-y-1.5">
        {holds.map((h) => (
          <div key={h.name} className="flex justify-between items-center text-[13px] rounded-lg bg-zinc-50 p-2">
            <div>
              <span className="font-medium text-zinc-800">{h.name}</span>
              <span className="text-[10px] text-zinc-400 ml-1.5">R{h.riskLevel} · 持有{h.daysHeld}天</span>
            </div>
            <div className="text-right">
              <div className="font-semibold text-zinc-800">¥{h.amount.toLocaleString()}</div>
              <div className="text-[10px] text-emerald-600">{h.expectedRet}%</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 订阅
function SubsCard({ data }: { data: Record<string, unknown> }) {
  const subs = (data.subscriptions ?? (data as { subs?: unknown[] }).subs ?? []) as { merchant: string; category?: string; amount: number; cycle?: string; monthlyOut?: number }[];
  return (
    <div className={cardShell}>
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-600 mb-2">
        <Repeat className="h-3.5 w-3.5" /> 订阅服务（自动识别）
      </div>
      {data.monthlyTotal !== undefined && (
        <div className="text-[12px] text-zinc-500 mb-2">
          月度支出 <span className="font-semibold text-red-600">¥{Number(data.monthlyTotal).toFixed(2)}</span>
          <span className="text-zinc-400"> · 年化 ¥{Number(data.annualTotal ?? 0).toFixed(0)}</span>
        </div>
      )}
      <div className="space-y-1.5">
        {subs.map((s) => (
          <div key={s.merchant} className="flex justify-between items-center text-[13px] rounded-lg bg-zinc-50 p-2">
            <div>
              <span className="font-medium text-zinc-800">{s.merchant}</span>
              {s.category && <span className="text-[10px] text-zinc-400 ml-1.5">{s.category}</span>}
            </div>
            <div className="text-right">
              <div className="font-semibold text-zinc-800">¥{s.monthlyOut ?? s.amount}</div>
              <div className="text-[10px] text-zinc-400">{s.cycle === "WEEKLY" ? "每周" : "每月"}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 卡片
function CardsCard({ data }: { data: Record<string, unknown> }) {
  const cards = Array.isArray(data) ? (data as { cardNo: string; label: string; type: string; status: string; limitDay: number }[]) : [];
  return (
    <div className={cardShell}>
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-600 mb-2">
        <CreditCard className="h-3.5 w-3.5" /> 我的卡片
      </div>
      <div className="space-y-2">
        {cards.map((c) => (
          <div key={c.cardNo} className="rounded-lg bg-gradient-to-r from-zinc-800 to-zinc-700 text-white p-3">
            <div className="flex justify-between text-[11px] text-zinc-300">
              <span>{c.label}</span>
              <span>**** {c.cardNo}</span>
            </div>
            <div className="flex justify-between items-end mt-2">
              <div className="text-[13px]">{c.type}</div>
              <div className={`text-[11px] px-1.5 py-0.5 rounded ${c.status === "正常" ? "bg-emerald-500/30 text-emerald-300" : "bg-red-500/30 text-red-300"}`}>
                {c.status}
              </div>
            </div>
            <div className="text-[10px] text-zinc-400 mt-1">单日限额 ¥{c.limitDay.toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 流水
function TransactionsCard({ data }: { data: unknown }) {
  const txs = (Array.isArray(data) ? data : []) as { amount: number; category: string; merchant: string; direction: string; time: string; status: string }[];
  return (
    <div className={cardShell}>
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-600 mb-2">
        <Eye className="h-3.5 w-3.5" /> 交易流水
      </div>
      <div className="space-y-1.5 max-h-64 overflow-y-auto">
        {txs.slice(0, 20).map((t, i) => (
          <div key={i} className="flex justify-between items-center text-[12px] py-1 border-b border-zinc-50">
            <div>
              <div className="text-zinc-800 font-medium">{t.merchant}</div>
              <div className="text-[10px] text-zinc-400">{t.category} · {new Date(t.time).toLocaleString("zh-CN")}</div>
            </div>
            <span className={`font-semibold ${t.direction === "IN" ? "text-emerald-600" : "text-zinc-700"}`}>
              {t.direction === "IN" ? "+" : "-"}¥{t.amount}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 风险测评问题
function RiskAssessCard({ data }: { data: Record<string, unknown> }) {
  const options = (data.options ?? []) as string[];
  return (
    <div className={cardShell}>
      <div className="text-[11px] text-zinc-400 mb-2">
        风险测评 {String(data.step)}/{String(data.total)}
      </div>
      <div className="text-[14px] font-semibold text-zinc-800 mb-2">{String(data.question ?? "")}</div>
      <div className="space-y-1.5">
        {options.map((o, i) => (
          <div key={i} className="text-[13px] rounded-lg border border-zinc-200 px-3 py-2 text-zinc-700">
            {i + 1}. {o}
          </div>
        ))}
      </div>
      <div className="text-[11px] text-zinc-400 mt-2">回复序号或选项内容即可</div>
    </div>
  );
}

// 风险测评结果
function RiskResultCard({ data }: { data: Record<string, unknown> }) {
  return (
    <div className={cardShell}>
      <div className="flex items-center gap-2 mb-1">
        <Badge className="bg-emerald-700 hover:bg-emerald-700 text-white">R{String(data.level)} {String(data.levelName)}</Badge>
      </div>
      <div className="text-[12px] text-zinc-600">{String(data.suggestion ?? "")}</div>
    </div>
  );
}

// ---------- utils ----------
const PRETTY: Record<string, string> = {
  payeeName: "收款人",
  amount: "金额",
  remark: "备注",
  runAt: "执行时间",
  participants: "参与者",
  total: "总金额",
  note: "说明",
  merchant: "商户",
  cardLabel: "卡片",
  newLimit: "新限额",
  what: "开关项",
  on: "状态",
  op: "操作",
  budget: "锁定预算",
  person: "对象",
  date: "日期",
  code: "产品代码",
  name: "产品",
};

function prettyKey(k: string): string {
  return PRETTY[k] ?? k;
}

function prettyVal(v: unknown): string {
  if (typeof v === "boolean") return v ? "开启" : "关闭";
  if (typeof v === "number") return `¥${v.toLocaleString()}`;
  if (Array.isArray(v)) return v.join("、");
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    return new Date(v).toLocaleString("zh-CN", { hour12: false });
  }
  if (v === "" || v == null) return "—";
  return String(v);
}
