"use client";

// ============ AegisBank 聊天主体 ============

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMessage, Overview, Notice } from "./types";
import { MessageBubble } from "./message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Send,
  ShieldCheck,
  Sparkles,
  Landmark,
  Bell,
  Wallet,
} from "lucide-react";

const QUICK_CMDS = [
  { label: "查余额", text: "查一下余额" },
  { label: "月度消费分析", text: "这个月消费分类分析一下" },
  { label: "异常交易检测", text: "帮我看看最近有没有异常交易" },
  { label: "识别订阅", text: "帮我识别一下订阅扣费" },
  { label: "风险测评", text: "我要做风险测评" },
  { label: "理财推荐", text: "推荐一些理财产品" },
  { label: "小额转账", text: "转100块钱给室友" },
  { label: "大额转账", text: "转3000给妈妈" },
  { label: "生日规划", text: "我爱人生日是11月20日，帮我锁定1000元准备鲜花和蛋糕" },
  { label: "帮助", text: "帮助" },
];

export function Chat({
  onSms,
}: {
  onSms?: (sms: { code: string; time: string }) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [sms, setSms] = useState<{ code: string; time: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const pushSms = useCallback(
    (code: string) => {
      const s = { code, time: new Date().toLocaleTimeString("zh-CN", { hour12: false }) };
      setSms(s);
      onSms?.(s);
    },
    [onSms]
  );

  // 加载会话
  const loadSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/session${sessionId ? `?sessionId=${sessionId}` : ""}`);
      const data = await res.json();
      if (data.sessionId) {
        setSessionId(data.sessionId);
        setMessages(data.messages ?? []);
        setOverview(data.overview ?? null);
        setNotices(data.notices ?? []);
      }
    } catch (e) {
      console.error(e);
    }
  }, [sessionId]);

  useEffect(() => {
    loadSession();
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  // 发送消息
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy || !sessionId) return;
      setBusy(true);
      setInput("");
      const userMsg: ChatMessage = {
        id: `tmp-${Date.now()}`,
        role: "user",
        content: trimmed,
        payload: null,
        createdAt: new Date().toISOString(),
      };
      setMessages((m) => [...m, userMsg]);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, sessionId }),
        });
        const data = await res.json();
        if (data.messages) {
          setMessages((m) => [
            ...m,
            ...data.messages.map(
              (x: { role: string; content: string; payload?: unknown }, i: number) => ({
                id: `r-${Date.now()}-${i}`,
                role: x.role,
                content: x.content,
                payload: (x.payload as ChatMessage["payload"]) ?? null,
                createdAt: new Date().toISOString(),
              })
            ),
          ]);
        }
        if (data.phoneEvent?.kind === "SMS") {
          pushSms(data.phoneEvent.code);
        }
        // 刷新资产概览（转账后余额变化）
        if (/转|余额|申|赎|挂失|解挂|锁/.test(trimmed)) {
          const res2 = await fetch(`/api/session?sessionId=${sessionId}`);
          const d2 = await res2.json();
          if (d2.overview) setOverview(d2.overview);
        }
      } catch (e) {
        setMessages((m) => [
          ...m,
          {
            id: `err-${Date.now()}`,
            role: "assistant",
            content: "⚠️ 网络异常，请稍后重试",
            payload: null,
            createdAt: new Date().toISOString(),
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, sessionId]
  );

  // 确认/取消（黄色卡）
  const onConfirm = useCallback(
    async (_taskId: string, ok: boolean) => {
      await send(ok ? "确认" : "取消");
    },
    [send]
  );

  // 验证码提交（红色卡）
  const onVerify = useCallback(
    async (code: string) => {
      if (!sessionId || busy) return;
      setBusy(true);
      setMessages((m) => [
        ...m,
        {
          id: `u-${Date.now()}`,
          role: "user",
          content: "输入验证码：******",
          payload: null,
          createdAt: new Date().toISOString(),
        },
      ]);
      try {
        const res = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, sessionId }),
        });
        const data = await res.json();
        if (data.messages) {
          setMessages((m) => [
            ...m,
            ...data.messages.map(
              (x: { role: string; content: string; payload?: unknown }, i: number) => ({
                id: `v-${Date.now()}-${i}`,
                role: x.role,
                content: x.content,
                payload: (x.payload as ChatMessage["payload"]) ?? null,
                createdAt: new Date().toISOString(),
              })
            ),
          ]);
        }
        const res2 = await fetch(`/api/session?sessionId=${sessionId}`);
        const d2 = await res2.json();
        if (d2.overview) setOverview(d2.overview);
      } finally {
        setBusy(false);
      }
    },
    [sessionId, busy]
  );

  return (
    <div className="flex flex-col h-full bg-zinc-100">
      {/* 顶部：银行头部 */}
      <div className="bg-gradient-to-r from-emerald-800 to-emerald-700 text-white px-4 pt-3 pb-4 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white/15 flex items-center justify-center">
              <Landmark className="h-4.5 w-4.5 h-4 w-4" />
            </div>
            <div>
              <div className="text-[15px] font-semibold leading-tight">AegisBank 灵犀智银</div>
              <div className="text-[10px] text-emerald-200/90 flex items-center gap-1">
                <ShieldCheck className="h-2.5 w-2.5" /> 三级权限管控 · 全程审计
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-emerald-100/80">
            <Bell className="h-3.5 w-3.5" />
            {notices.length > 0 && (
              <span className="bg-red-500 text-white rounded-full px-1.5 text-[9px]">{notices.length}</span>
            )}
          </div>
        </div>
        {/* 资产条 */}
        {overview && (
          <div className="mt-3 rounded-xl bg-white/10 backdrop-blur px-3 py-2.5 flex items-center justify-between">
            <div>
              <div className="text-[10px] text-emerald-100/70">总资产（储蓄卡 ****{overview.cardNo}）</div>
              <div className="text-[20px] font-bold tracking-tight">
                ¥{overview.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-emerald-100/70 flex items-center gap-1 justify-end">
                <Wallet className="h-2.5 w-2.5" /> 理财
              </div>
              <div className="text-[14px] font-semibold">¥{overview.finance.toLocaleString()}</div>
            </div>
          </div>
        )}
      </div>

      {/* 快捷指令 */}
      <div className="bg-white border-b border-zinc-100 px-3 py-2 shrink-0 overflow-x-auto">
        <div className="flex gap-2 w-max">
          {QUICK_CMDS.map((q) => (
            <button
              key={q.label}
              onClick={() => send(q.text)}
              disabled={busy}
              className="text-[11px] px-2.5 py-1 rounded-full border border-emerald-200 text-emerald-800 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 whitespace-nowrap transition-colors"
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <Sparkles className="h-8 w-8 text-emerald-300 mx-auto mb-2" />
            <div className="text-[13px] text-zinc-500">您好，我是您的银行智能助手</div>
            <div className="text-[11px] text-zinc-400 mt-1">试试「查余额」「识别订阅」「转100给室友」</div>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} onConfirm={onConfirm} onVerify={onVerify} busy={busy} />
        ))}
        {busy && (
          <div className="flex justify-start mb-3">
            <div className="rounded-2xl rounded-bl-md bg-white border border-zinc-200 px-4 py-3 shadow-sm">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-zinc-300 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-1.5 h-1.5 bg-zinc-300 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-1.5 h-1.5 bg-zinc-300 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="bg-white border-t border-zinc-200 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shrink-0">
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) send(input);
            }}
            placeholder="输入银行业务指令，如：转100给室友"
            className="flex-1 h-10 rounded-full bg-zinc-100 border-zinc-200 focus-visible:ring-emerald-500"
            disabled={busy}
          />
          <Button
            size="icon"
            className="h-10 w-10 rounded-full bg-emerald-700 hover:bg-emerald-800 shrink-0"
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {sms && (
          <div className="mt-1.5 text-[10px] text-zinc-400 text-center">
            💬 模拟手机已收到短信验证码：<span className="font-mono font-semibold text-amber-600">{sms.code}</span>（见右侧/下方"模拟手机"面板）
          </div>
        )}
      </div>
    </div>
  );
}
