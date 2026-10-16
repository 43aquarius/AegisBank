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
    <div className="flex flex-col h-full bg-[#1C1915]">
      {/* 顶部：银行头部（深黑金） */}
      <div className="relative bg-[#12100D] text-white px-5 pt-4 pb-4 shrink-0 border-b-2 border-[#C9A84C]/60">
        <div
          className="absolute inset-0 opacity-60"
          style={{ background: "radial-gradient(600px 120px at 20% 0%, rgba(201,168,76,0.22), transparent 70%)" }}
        />
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#C9A84C] to-[#8A6D2F] flex items-center justify-center shadow-lg shadow-black/40">
              <Landmark className="h-5 w-5 text-[#12100D]" strokeWidth={2.2} />
            </div>
            <div>
              <div className="text-[17px] font-bold leading-tight">
                AegisBank <span className="bg-gradient-to-r from-[#E7CE8C] to-[#C9A84C] bg-clip-text text-transparent">灵犀智银</span>
              </div>
              <div className="text-[11px] text-[#C9A84C]/90 flex items-center gap-1.5 mt-0.5">
                <ShieldCheck className="h-3 w-3" /> 三级权限管控 · 全程审计 · 沙箱执行
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-[#C9A84C]">
            <Bell className="h-4 w-4" />
            {notices.length > 0 && (
              <span className="bg-red-500 text-white rounded-full px-1.5 py-0.5 text-[10px] font-semibold">{notices.length}</span>
            )}
          </div>
        </div>
        {/* 资产条 */}
        {overview && (
          <div className="relative mt-3.5 rounded-xl bg-white/[0.07] backdrop-blur border border-[#C9A84C]/30 px-4 py-3 flex items-center justify-between">
            <div>
              <div className="text-[11px] text-[#A39B87]">总资产（储蓄卡 ****{overview.cardNo}）</div>
              <div className="text-[24px] font-bold tracking-tight text-[#F2EBDB] tabular-nums">
                ¥{overview.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </div>
            </div>
            <div className="text-right pl-5 border-l border-[#C9A84C]/25">
              <div className="text-[12px] text-[#A39B87] flex items-center gap-1.5 justify-end">
                <Wallet className="h-3 w-3" /> 理财持仓
              </div>
              <div className="text-[16px] font-semibold text-[#E7CE8C] tabular-nums">¥{overview.finance.toLocaleString()}</div>
            </div>
          </div>
        )}
      </div>

      {/* 快捷指令 */}
      <div className="bg-[#26211A] border-b border-[#C9A84C]/25 px-4 py-2.5 shrink-0 overflow-x-auto">
        <div className="flex gap-2.5 w-max">
          {QUICK_CMDS.map((q) => (
            <button
              key={q.label}
              onClick={() => send(q.text)}
              disabled={busy}
              className="text-[13px] px-4 py-2 rounded-full border border-[#C9A84C]/45 text-[#E7CE8C] bg-[#C9A84C]/10 hover:bg-[#C9A84C]/25 hover:border-[#C9A84C] disabled:opacity-40 whitespace-nowrap transition-colors font-medium"
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <div className="text-center py-12">
            <Sparkles className="h-10 w-10 text-[#C9A84C] mx-auto mb-3" />
            <div className="text-[19px] text-[#EDE6D6] font-medium">您好，我是您的银行智能助手</div>
            <div className="text-[14.5px] text-[#A39B87] mt-2">试试「查余额」「识别订阅」「转100给室友」</div>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} onConfirm={onConfirm} onVerify={onVerify} busy={busy} />
        ))}
        {busy && (
          <div className="flex justify-start mb-3">
            <div className="rounded-2xl rounded-bl-md bg-[#2A251C] border border-[#C9A84C]/40 px-5 py-3.5">
              <div className="flex gap-1.5">
                <span className="w-2 h-2 bg-[#C9A84C]/60 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 bg-[#C9A84C]/60 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 bg-[#C9A84C]/60 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="bg-[#26211A] border-t border-[#C9A84C]/30 px-4 py-3.5 pb-[max(0.8rem,env(safe-area-inset-bottom))] shrink-0">
        <div className="flex gap-2.5">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) send(input);
            }}
            placeholder="输入银行业务指令，如：转100给室友"
            className="flex-1 h-[52px] rounded-full bg-[#2A251C] border-[#C9A84C]/70 text-[16px] text-[#F2EBDB] placeholder:text-[#8F8878] focus-visible:ring-[#C9A84C] focus-visible:border-[#C9A84C] px-5"
            disabled={busy}
          />
          <Button
            size="icon"
            className="h-12 w-12 rounded-full bg-gradient-to-br from-[#C9A84C] to-[#8A6D2F] hover:from-[#D9B85C] hover:to-[#9A7A35] shrink-0 shadow-md"
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
          >
            <Send className="h-5 w-5" />
          </Button>
        </div>
        {sms && (
          <div className="mt-2.5 text-[13px] text-[#A39B87] text-center">
            💬 模拟手机已收到短信验证码：<span className="font-mono font-bold text-[#E7CE8C] text-[15px] tracking-wider">{sms.code}</span>（见右侧「模拟手机」面板）
          </div>
        )}
      </div>
    </div>
  );
}
