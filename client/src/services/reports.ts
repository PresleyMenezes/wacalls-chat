import { apiGet } from "@/lib/api";

export type ReportSummary = {
  from: number;
  to: number;
  sessionId?: string;
  messages: { total: number; inbound: number; outbound: number };
  calls: {
    total: number;
    inbound: number;
    outbound: number;
    answered: number;
    missed: number;
    video: number;
    totalDurationMs: number;
    avgDurationMs: number;
  };
  tickets: { closed: number; waiting: number; open: number; closedWithMsg?: number; closedNoMsg?: number; avgResolutionMs?: number };
  daily: Array<{
    day: string;
    messagesIn: number;
    messagesOut: number;
    callsIn: number;
    callsOut: number;
    callsAnswered: number;
    callsMissed: number;
    ticketsClosed: number;
    respondedChats: number;
    opened: number;
  }>;
  closureReasons: Array<{ label: string; count: number }>;
  agents: Array<{ userId: string; email?: string; closed: number }>;
  hourly?: Array<{ hour: number; messagesOut: number; messagesIn: number; receivedChats: number; respondedChats: number; opened: number; ticketsClosed: number }>;
  ratings: { total: number; good: number; bad: number; awful: number; average: number };
};

export const fetchReport = (params: { from?: number; to?: number; sessionId?: string; agentId?: string }) => {
  const q = new URLSearchParams();
  if (params.from) q.set("from", String(params.from));
  if (params.to) q.set("to", String(params.to));
  if (params.sessionId) q.set("sessionId", params.sessionId);
  if (params.agentId) q.set("agentId", params.agentId);
  const qs = q.toString();
  return apiGet<ReportSummary>(`/api/reports/summary${qs ? `?${qs}` : ""}`);
};

export type ReportHourChat = {
  sessionId: string;
  chatJid: string;
  name?: string;
  avatarUrl?: string;
  lastMessage: string;
  lastKind: string;
  lastTs: number;
  lastFromMe: boolean;
};

export const fetchReportHourDetail = (params: {
  from: number;
  to: number;
  hour: number;
  sessionId?: string;
  agentId?: string;
}) => {
  const q = new URLSearchParams();
  q.set("from", String(params.from));
  q.set("to", String(params.to));
  q.set("hour", String(params.hour));
  if (params.sessionId) q.set("sessionId", params.sessionId);
  if (params.agentId) q.set("agentId", params.agentId);
  return apiGet<{ chats: ReportHourChat[] }>(`/api/reports/hour-detail?${q.toString()}`).then((r) => r.chats ?? []);
};
