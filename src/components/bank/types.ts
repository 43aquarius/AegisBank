"use client";

// ============ AegisBank 前端类型 ============

export interface DagNode {
  id: string;
  action: string;
  label: string;
  params: Record<string, unknown>;
  dependsOn: string[];
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED" | "WAITING";
}

export interface Payload {
  type: string;
  [k: string]: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system_event";
  content: string;
  payload: Payload | null;
  createdAt: string;
}

export interface Overview {
  total: number;
  finance: number;
  cardNo: string;
}

export interface Notice {
  id: string;
  kind: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}
