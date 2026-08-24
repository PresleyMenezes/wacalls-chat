import { useEffect, useMemo, useRef, useState } from "react";
import { listUsers } from "@/services/auth";
import type { AuthUser } from "@/types/auth";
import {
  BarChart3,
  Calendar,
  ChevronDown,
  Clock,
  MessageSquare,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  TrendingUp,
  Users as UsersIcon,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AppShell } from "@/components/layout/AppShell";
import { fetchReport, type ReportSummary } from "@/services/reports";
import { fetchCallHistory, type CallHistoryRow } from "@/services/callsHistory";
import { listChats, listMessages } from "@/services/chats";
import type { ChatSummary } from "@/types/chat";
import { useSessions, ensureSessionsWired } from "@/stores/sessions";


import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const RANGES: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
const ALL_SESSIONS = "__all__";

// Power BI-ish palette (works in dark mode)
const C = {
  blue: "#3b82f6",
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
  violet: "#8b5cf6",
  sky: "#06b6d4",
  slate: "#94a3b8",
};
const DONUT_COLORS = [C.emerald, C.rose, C.amber, C.violet, C.sky, C.blue];

const formatDuration = (ms: number) => {
  if (!ms || ms < 1000) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
};

const shortDay = (iso: string) => {
  // "2026-07-05" → "05/07"
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
};

const KpiCard = ({
  label,
  value,
  hint,
  delta,
  icon: Icon,
  tone,
  subStats,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: { value: number; positive?: boolean };
  icon: typeof Phone;
  tone: string;
  subStats?: { label: string; value: string }[];
  className?: string;
}) => (
  <div className={`rounded-xl border bg-card p-4 transition hover:shadow-md ${className ?? ""}`}>
    <div className="flex items-start justify-between">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <span className={`grid h-8 w-8 place-items-center rounded-lg ${tone}`}>
        <Icon className="h-4 w-4" />
      </span>
    </div>
    <div className="mt-3 text-2xl font-semibold tabular-nums">{value}</div>
    {subStats && subStats.length > 0 && (
      <div className="mt-1.5 space-y-0.5">
        {subStats.map((s) => (
          <div key={s.label} className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{s.label}</span>
            <span className="font-medium tabular-nums text-foreground/80">{s.value}</span>
          </div>
        ))}
      </div>
    )}
    <div className="mt-1 flex items-center gap-2">
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      {delta ? (
        <span
          className={`text-[11px] font-medium ${
            delta.positive ? "text-emerald-500" : "text-rose-500"
          }`}
        >
          {delta.positive ? "▲" : "▼"} {delta.value}%
        </span>
      ) : null}
    </div>
  </div>
);

const ChartCard = ({
  title,
  subtitle,
  icon: Icon,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  icon?: typeof BarChart3;
  children: React.ReactNode;
  className?: string;
}) => (
  <div className={`rounded-xl border bg-card p-4 ${className}`}>
    <div className="mb-3 flex items-start justify-between">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          {Icon ? <Icon className="h-4 w-4 text-primary" /> : null}
          {title}
        </div>
        {subtitle ? (
          <div className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</div>
        ) : null}
      </div>
    </div>
    <div className="h-64 w-full">{children}</div>
  </div>
);

const tooltipStyle = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  padding: "8px 10px",
};

const emptyReport = (from: number, to: number, sessionId?: string): ReportSummary => ({
  from,
  to,
  sessionId,
  messages: { total: 0, inbound: 0, outbound: 0 },
  calls: {
    total: 0, inbound: 0, outbound: 0, answered: 0, missed: 0, video: 0,
    totalDurationMs: 0, avgDurationMs: 0,
  },
  tickets: { closed: 0, waiting: 0, open: 0 },
  daily: [],
  closureReasons: [],
  agents: [],
  ratings: { total: 0, good: 0, bad: 0, awful: 0, average: 0 },
});

const buildSummaryFromCalls = (
  from: number,
  to: number,
  sessionId: string | undefined,
  rows: CallHistoryRow[],
  kpis: {
    total: number; inbound: number; outbound: number; answered: number;
    missed: number; video: number; totalDurationMs: number; avgDurationMs: number;
  },
): ReportSummary => {
  const base = emptyReport(from, to, sessionId);
  base.calls = { ...kpis };

  // Build daily buckets from `from` to `to`.
  const dayKey = (ts: number) => {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const buckets = new Map<string, {
    day: string; messagesIn: number; messagesOut: number;
    callsIn: number; callsOut: number; callsAnswered: number;
    callsMissed: number; ticketsClosed: number;
  }>();
  const start = new Date(from); start.setHours(0, 0, 0, 0);
  const end = new Date(to); end.setHours(0, 0, 0, 0);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d.getTime());
    buckets.set(k, {
      day: k, messagesIn: 0, messagesOut: 0,
      callsIn: 0, callsOut: 0, callsAnswered: 0, callsMissed: 0, ticketsClosed: 0,
    });
  }
  for (const r of rows) {
    const k = dayKey(r.startedAt);
    const b = buckets.get(k);
    if (!b) continue;
    if (r.direction === "inbound") b.callsIn += 1;
    else b.callsOut += 1;
    if (r.answered) b.callsAnswered += 1;
    else if (r.direction === "inbound") b.callsMissed += 1;
  }
  base.daily = Array.from(buckets.values()).sort((a, b) => a.day.localeCompare(b.day));
  return base;
};

const mergeChatsIntoSummary = (
  summary: ReportSummary,
  chats: ChatSummary[],
): ReportSummary => {
  const from = summary.from;
  const to = summary.to;
  const dayKey = (ts: number) => {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const daily = new Map(summary.daily.map((d) => [d.day, { ...d }]));

  let msgsTotal = 0;
  const tickets = { closed: 0, waiting: 0, open: 0 };

  for (const c of chats) {
    if (c.isGroup) continue;
    // Only account chats whose latest activity falls in the window.
    if (c.lastTs && (c.lastTs < from || c.lastTs > to)) continue;

    msgsTotal += c.count ?? 0;
    if (c.status === "closed") tickets.closed += 1;
    else if (c.status === "waiting") tickets.waiting += 1;
    else if (c.status === "open") tickets.open += 1;

    if (c.status === "closed" && c.lastTs) {
      const k = dayKey(c.lastTs);
      const b = daily.get(k);
      if (b) b.ticketsClosed += 1;
    }
  }

  return {
    ...summary,
    messages: { total: msgsTotal, inbound: 0, outbound: 0 },
    tickets,
    daily: Array.from(daily.values()).sort((a, b) => a.day.localeCompare(b.day)),
  };
};

const mergeReportSources = (
  remote: ReportSummary | null,
  local: ReportSummary,
  agentFilterActive = false,
): ReportSummary => {
  if (!remote) return local;
  const hasMessageBreakdown = (r: ReportSummary) => (r.messages?.inbound ?? 0) + (r.messages?.outbound ?? 0) > 0;
  const callScore = (r: ReportSummary) => r.calls?.total ?? 0;
  const ticketScore = (r: ReportSummary) => (r.tickets?.open ?? 0) + (r.tickets?.waiting ?? 0) + (r.tickets?.closed ?? 0);
  const dailyByDay = new Map(local.daily.map((d) => [d.day, { ...d }]));

  for (const rd of remote.daily ?? []) {
    const ld = dailyByDay.get(rd.day);
    dailyByDay.set(rd.day, {
      day: rd.day,
      // Com filtro de agente ativo, os valores filtrados do servidor
      // valem mesmo quando são zero — misturar com o total local (sem
      // filtro) faria o gráfico "ignorar" o agente selecionado.
      messagesIn: agentFilterActive ? rd.messagesIn : (rd.messagesIn || ld?.messagesIn || 0),
      messagesOut: agentFilterActive ? rd.messagesOut : (rd.messagesOut || ld?.messagesOut || 0),
      callsIn: rd.callsIn || ld?.callsIn || 0,
      callsOut: rd.callsOut || ld?.callsOut || 0,
      callsAnswered: rd.callsAnswered || ld?.callsAnswered || 0,
      callsMissed: rd.callsMissed || ld?.callsMissed || 0,
      ticketsClosed: agentFilterActive ? rd.ticketsClosed : (rd.ticketsClosed || ld?.ticketsClosed || 0),
      respondedChats: agentFilterActive ? rd.respondedChats : (rd.respondedChats || ld?.respondedChats || 0),
      opened: agentFilterActive ? rd.opened : (rd.opened || ld?.opened || 0),
    });
  }

  return {
    ...local,
    ...remote,
    messages: agentFilterActive || hasMessageBreakdown(remote) ? remote.messages : local.messages,
    // Com filtro de agente ativo, o total filtrado do servidor é sempre
    // menor (ou igual) que o total geral local — a heurística "quem tem
    // mais dados" removeria o filtro sem querer, então nesse caso o
    // resultado remoto (já filtrado corretamente) é sempre priorizado.
    calls: agentFilterActive || callScore(remote) >= callScore(local) ? remote.calls : local.calls,
    tickets: agentFilterActive || ticketScore(remote) >= ticketScore(local) ? remote.tickets : local.tickets,
    daily: Array.from(dailyByDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
    closureReasons: remote.closureReasons?.length ? remote.closureReasons : local.closureReasons,
    agents: remote.agents?.length ? remote.agents : local.agents,
  };
};





export default function ReportsPage() {
  const sessions = useSessions((s) => s.sessions);
  // A store de sessões recebe um array NOVO a cada evento em tempo real
  // (session-list, auth-state), mesmo sem mudança real de conteúdo. Usar
  // `sessions` direto como dependência do efeito abaixo faria o relatório
  // ser buscado de novo a cada evento, criando corridas entre requisições
  // (a mais lenta podia "vencer" e sobrescrever a tela com dados velhos/
  // incompletos). Uma chave estável, derivada só dos IDs, evita isso.
  const sessionsKey = useMemo(() => sessions.map((s) => s.id).sort().join(","), [sessions]);
  const [range, setRange] = useState<string>("30d");
  // Período personalizado: strings "YYYY-MM-DD" vindas de <input type="date">.
  // Só têm efeito quando range === "custom".
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [rangeMenuOpen, setRangeMenuOpen] = useState(false);
  const rangeMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rangeMenuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rangeMenuRef.current && !rangeMenuRef.current.contains(e.target as Node)) {
        setRangeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [rangeMenuOpen]);
  const rangeLabel =
    range === "custom"
      ? customFrom && customTo
        ? `${customFrom.split("-").reverse().join("/")} – ${customTo.split("-").reverse().join("/")}`
        : "Personalizado"
      : range === "today"
        ? "Hoje"
        : range === "7d"
          ? "Últimos 7 dias"
          : range === "90d"
            ? "Últimos 90 dias"
            : "Últimos 30 dias";
  const [sessionId, setSessionId] = useState<string>(ALL_SESSIONS);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("all");
  const [callsAgentId, setCallsAgentId] = useState<string>("all");
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<AuthUser[]>([]);
  // Séries ocultas por gráfico (clique na legenda alterna) — um Set por
  // gráfico, já que o mesmo dataKey pode existir em mais de um.
  const [hiddenCalls, setHiddenCalls] = useState<Set<string>>(new Set());
  const [hiddenDaily, setHiddenDaily] = useState<Set<string>>(new Set());
  const [hiddenTimes, setHiddenTimes] = useState<Set<string>>(new Set());
  const [hiddenHourly, setHiddenHourly] = useState<Set<string>>(new Set());
  const makeLegendToggle = (setHidden: (fn: (prev: Set<string>) => Set<string>) => void) => (e: { dataKey?: unknown }) => {
    const key = String(e.dataKey ?? "");
    if (!key) return;
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  useEffect(() => {
    void listUsers().then(setUsers).catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    ensureSessionsWired();
  }, []);

  useEffect(() => {
    // Ignora a resposta desta busca se uma busca mais nova já tiver sido
    // disparada enquanto esta ainda estava em andamento (corrida entre
    // requisições — buildFallback faz várias chamadas sequenciais e pode
    // demorar mais que a busca seguinte, chegando "atrasada").
    let cancelled = false;
    let from: number;
    let to: number;
    if (range === "custom" && customFrom && customTo) {
      // Início do dia inicial até o fim do dia final, no fuso do navegador.
      from = new Date(`${customFrom}T00:00:00`).getTime();
      to = new Date(`${customTo}T23:59:59.999`).getTime();
    } else if (range === "today") {
      const now = new Date();
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
      to = Date.now();
    } else {
      const days = RANGES[range] ?? 30;
      to = Date.now();
      from = to - days * 24 * 60 * 60 * 1000;
    }
    const sid = sessionId === ALL_SESSIONS ? undefined : sessionId;
    setLoading(true);
    const targetSessions = sid ? [sid] : sessions.map((s) => s.id);

    const buildFallback = async (): Promise<ReportSummary> => {
      let summary = emptyReport(from, to, sid);
      try {
        const ch = await fetchCallHistory({ from, to, sessionId: sid, limit: 5000 });
        summary = buildSummaryFromCalls(from, to, sid, ch.rows, ch.kpis);
      } catch {
        /* keep empty calls */
      }
      // Merge chat/ticket data across the selected sessions.
      try {
        const chatsBySession = await Promise.all(
          targetSessions.map(async (id) => ({ id, chats: await listChats(id).catch(() => [] as ChatSummary[]) })),
        );
        const allChats = chatsBySession.flatMap((item) => item.chats);
        summary = mergeChatsIntoSummary(summary, allChats);
        const messageTotals = { total: 0, inbound: 0, outbound: 0 };
        const dailyByDay = new Map(summary.daily.map((d) => [d.day, { ...d }]));
        await Promise.all(
          chatsBySession.flatMap(({ id, chats }) =>
            chats
              .filter((chat) => !chat.isGroup)
              .map(async (chat) => {
                const rows = await listMessages(id, chat.chatJid, { limit: 500 }).catch(() => []);
                for (const msg of rows) {
                  if (msg.ts < from || msg.ts > to) continue;
                  messageTotals.total += 1;
                  const day = new Date(msg.ts).toISOString().slice(0, 10);
                  const bucket = dailyByDay.get(day);
                  if (msg.fromMe) {
                    messageTotals.outbound += 1;
                    if (bucket) bucket.messagesOut += 1;
                  } else {
                    messageTotals.inbound += 1;
                    if (bucket) bucket.messagesIn += 1;
                  }
                }
              }),
          ),
        );
        if (messageTotals.total > 0) {
          summary = {
            ...summary,
            messages: messageTotals,
            daily: Array.from(dailyByDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
          };
        }
      } catch {
        /* ignore chat aggregation errors */
      }
      return summary;
    };

    // Sempre construir localmente para garantir dados de chamadas e atendimentos,
    // já que o endpoint /api/reports pode retornar dados incompletos dependendo
    // do backend/configuração. Tentamos o backend em paralelo e usamos o que
    // tiver mais dados (calls.total + messages.total + tickets totais).
    (async () => {
      try {
        const [remote, local] = await Promise.all([
          fetchReport({ from, to, sessionId: sid, agentId: callsAgentId === "all" ? undefined : callsAgentId }).catch(() => null),
          buildFallback(),
        ]);
        if (cancelled) return;
        setReport(mergeReportSources(remote, local, callsAgentId !== "all"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, sessionId, sessionsKey, callsAgentId, customFrom, customTo]);



  const answeredPct = useMemo(
    () => (report?.calls.total ? Math.round((report.calls.answered / report.calls.total) * 100) : 0),
    [report],
  );
  const missedPct = useMemo(
    () => (report?.calls.inbound ? Math.round((report.calls.missed / report.calls.inbound) * 100) : 0),
    [report],
  );

  const calls = report?.calls;
  const messages = report?.messages;
  const tickets = report?.tickets;

  // Prepare chart data
  const daily = useMemo(
    () =>
      (report?.daily ?? []).map((d) => ({
        ...d,
        label: shortDay(d.day),
        callsTotal: d.callsIn + d.callsOut,
        msgsTotal: d.messagesIn + d.messagesOut,
      })),
    [report],
  );

  const hourly = useMemo(
    () =>
      (report?.hourly ?? []).map((h) => ({
        ...h,
        label: `${String(h.hour).padStart(2, "0")}h`,
      })),
    [report],
  );

  const callsDonut = useMemo(() => {
    if (!calls) return [];
    return [
      { name: "Atendidas", value: calls.answered },
      { name: "Perdidas", value: calls.missed },
      { name: "Outras", value: Math.max(0, calls.total - calls.answered - calls.missed) },
    ].filter((d) => d.value > 0);
  }, [calls]);

  const ticketsDonut = useMemo(() => {
    if (!tickets) return [];
    return [
      { name: "Em aberto", value: tickets.open },
      { name: "Aguardando", value: tickets.waiting },
      { name: "Finalizados", value: tickets.closed },
    ].filter((d) => d.value > 0);
  }, [tickets]);


  const topAgents = useMemo(
    () =>
      [...(report?.agents ?? [])]
        .sort((a, b) => b.messagesSent - a.messagesSent)
        .slice(0, 8)
        .map((a) => ({
          userId: a.userId,
          name: a.name || (a.email || a.userId).split("@")[0],
          closed: a.closed,
          messagesSent: a.messagesSent,
          respondedChats: a.respondedChats,
          avgFirstResponseMin: a.avgFirstResponseMs ? Math.round(a.avgFirstResponseMs / 60000) : null,
          avgResolutionMin: a.avgResolutionMs ? Math.round(a.avgResolutionMs / 60000) : null,
        })),
    [report],
  );
  const selectedAgent = useMemo(
    () => (selectedAgentId === "all" ? null : topAgents.find((a) => a.userId === selectedAgentId) ?? null),
    [selectedAgentId, topAgents],
  );
  // Mesma lógica de `selectedAgent`, só que ligada ao dropdown "Agente" do
  // topo da página (callsAgentId) — usado pela seção "Atendimentos no chat"
  // e pela seção "Chamadas", que compartilham esse mesmo filtro.
  const callsSelectedAgent = useMemo(
    () => (callsAgentId === "all" ? null : topAgents.find((a) => a.userId === callsAgentId) ?? null),
    [callsAgentId, topAgents],
  );
  const agentTotals = useMemo(() => {
    if (selectedAgent) {
      return {
        messagesSent: selectedAgent.messagesSent,
        respondedChats: selectedAgent.respondedChats,
        closed: selectedAgent.closed,
      };
    }
    return topAgents.reduce(
      (acc, a) => ({
        messagesSent: acc.messagesSent + a.messagesSent,
        respondedChats: acc.respondedChats + a.respondedChats,
        closed: acc.closed + a.closed,
      }),
      { messagesSent: 0, respondedChats: 0, closed: 0 },
    );
  }, [selectedAgent, topAgents]);
  const formatMinutes = (min: number | null | undefined) => {
    if (min === null || min === undefined) return "—";
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  };

  const closureReasons = useMemo(
    () =>
      (report?.closureReasons ?? [])
        .slice()
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
    [report],
  );

  return (
    <AppShell>
      <div className="space-y-6 pb-12">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              Relatórios
            </h2>
            <p className="text-sm text-muted-foreground">
              Chamadas e atendimentos no período selecionado
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={sessionId} onValueChange={setSessionId}>
              <SelectTrigger className="h-9 w-[180px]">
                <SelectValue placeholder="Conexão" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SESSIONS}>Todas as conexões</SelectItem>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name || s.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={callsAgentId} onValueChange={setCallsAgentId}>
              <SelectTrigger className="h-9 w-[160px]">
                <SelectValue placeholder="Agente" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os agentes</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.name?.trim() || u.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative" ref={rangeMenuRef}>
              <button
                type="button"
                onClick={() => setRangeMenuOpen((o) => !o)}
                className="flex h-9 w-[190px] items-center justify-between rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <span className="truncate">{rangeLabel}</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
              {rangeMenuOpen && (
                <div className="absolute right-0 z-50 mt-1 w-64 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-md">
                                    {[
                    { value: "today", label: "Hoje" },
                    { value: "7d", label: "Últimos 7 dias" },
                    { value: "30d", label: "Últimos 30 dias" },
                    { value: "90d", label: "Últimos 90 dias" },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        setRange(opt.value);
                        setRangeMenuOpen(false);
                      }}
                      className={`flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted ${
                        range === opt.value ? "font-medium text-primary" : ""
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <div className="my-1.5 border-t" />
                  <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Personalizado
                  </div>
                  <div className="flex items-center gap-1.5 px-2 pb-1.5">
                    <input
                      type="date"
                      value={customFrom}
                      max={customTo || undefined}
                      onChange={(e) => {
                        setCustomFrom(e.target.value);
                        setRange("custom");
                      }}
                      className="h-8 w-full min-w-0 rounded-md border bg-background px-1.5 text-xs outline-none focus:ring-2 focus:ring-ring dark:[color-scheme:dark]"
                    />
                    <span className="text-xs text-muted-foreground">–</span>
                    <input
                      type="date"
                      value={customTo}
                      min={customFrom || undefined}
                      onChange={(e) => {
                        setCustomTo(e.target.value);
                        setRange("custom");
                      }}
                      className="h-8 w-full min-w-0 rounded-md border bg-background px-1.5 text-xs outline-none focus:ring-2 focus:ring-ring dark:[color-scheme:dark]"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* KPI ROW - Chamadas */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Phone className="h-3.5 w-3.5" /> Chamadas
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <KpiCard label="Total" value={String(calls?.total ?? 0)} icon={Phone} tone="bg-sky-500/15 text-sky-400" />
            <KpiCard label="Realizadas" value={String(calls?.outbound ?? 0)} icon={PhoneOutgoing} tone="bg-emerald-500/15 text-emerald-400" />
            <KpiCard
              label="Recebidas"
              value={String(calls?.inbound ?? 0)}
              hint={callsAgentId === "all" ? `${missedPct}% perdidas` : undefined}
              icon={PhoneIncoming}
              tone="bg-primary/15 text-primary"
            />
            <KpiCard label="Atendidas" value={String(calls?.answered ?? 0)} hint={`${answeredPct}% do total`} icon={TrendingUp} tone="bg-emerald-500/15 text-emerald-400" />
            {callsAgentId === "all" && (
              <KpiCard label="Perdidas" value={String(calls?.missed ?? 0)} icon={Calendar} tone="bg-rose-500/15 text-rose-400" />
            )}
            <KpiCard label="Duração média" value={formatDuration(calls?.avgDurationMs ?? 0)} hint="por ligação" icon={Clock} tone="bg-violet-500/15 text-violet-400" />
          </div>
        </section>

        {/* Charts row 1 - Calls timeline + donut */}
        <div className="grid gap-4 lg:grid-cols-3">
          <ChartCard
            title="Ligações por dia"
            subtitle="Saídas vs. entradas"
            icon={TrendingUp}
            className="lg:col-span-2"
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={daily} margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.emerald} stopOpacity={0.5} />
                    <stop offset="100%" stopColor={C.emerald} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.blue} stopOpacity={0.5} />
                    <stop offset="100%" stopColor={C.blue} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={30} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "hsl(var(--foreground))" }} />
                <Legend wrapperStyle={{ fontSize: 12, cursor: "pointer" }} onClick={makeLegendToggle(setHiddenCalls)} />
                <Area type="monotone" dataKey="callsOut" name="Saídas" stroke={C.emerald} strokeWidth={2} fill="url(#gOut)" hide={hiddenCalls.has("callsOut")} />
                <Area type="monotone" dataKey="callsIn" name="Entradas" stroke={C.blue} strokeWidth={2} fill="url(#gIn)" hide={hiddenCalls.has("callsIn")} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Status das chamadas" subtitle="Distribuição no período" icon={Phone}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip contentStyle={tooltipStyle} />
                <Pie data={callsDonut} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                  {callsDonut.map((_, i) => (
                    <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                  ))}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 12 }} verticalAlign="bottom" iconType="circle" />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        {/* KPI ROW - Atendimentos */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <MessageSquare className="h-3.5 w-3.5" /> Atendimentos no chat
          </h3>
          <div className="flex flex-wrap gap-3">
            {/* Bloco 1: interações gerais */}
            <div className="flex flex-1 min-w-[280px] gap-2 rounded-xl border border-border/70 p-2">
              {callsAgentId === "all" && (
                <>
                  <KpiCard className="flex-1" label="Interações" value={String(messages?.total ?? 0)} icon={MessageSquare} tone="bg-sky-500/15 text-sky-400" />
                  <KpiCard className="flex-1" label="Recebidas" value={String(messages?.inbound ?? 0)} icon={PhoneIncoming} tone="bg-primary/15 text-primary" />
                </>
              )}
              <KpiCard className="flex-1" label="Enviadas" value={String(messages?.outbound ?? 0)} icon={PhoneOutgoing} tone="bg-emerald-500/15 text-emerald-400" />
            </div>
            {/* Bloco 2: finalizados e sua composição */}
            <div className="flex flex-1 min-w-[280px] gap-2 rounded-xl border border-border/70 p-2">
              <KpiCard className="flex-1" label="Finalizados" value={String(tickets?.closed ?? 0)} icon={TrendingUp} tone="bg-emerald-500/15 text-emerald-400" />
              <KpiCard className="flex-1" label="Com mensagem" value={String(tickets?.closedWithMsg ?? 0)} icon={UsersIcon} tone="bg-amber-500/15 text-amber-400" />
              <KpiCard className="flex-1" label="Sem mensagem" value={String(tickets?.closedNoMsg ?? 0)} icon={Clock} tone="bg-violet-500/15 text-violet-400" />
            </div>
            {/* Bloco 3: fila de trabalho */}
            <div className="flex flex-1 min-w-[280px] gap-2 rounded-xl border border-border/70 p-2">
              <KpiCard
                className="flex-1"
                label="Respondidas"
                value={String(
                  callsSelectedAgent
                    ? callsSelectedAgent.respondedChats
                    : topAgents.reduce((sum, a) => sum + a.respondedChats, 0),
                )}
                icon={UsersIcon}
                tone="bg-sky-500/15 text-sky-400"
              />
              <KpiCard className="flex-1" label="Em aberto" value={String(tickets?.open ?? 0)} icon={UsersIcon} tone="bg-amber-500/15 text-amber-400" />
              {callsAgentId === "all" && (
                <KpiCard className="flex-1" label="Aguardando" value={String(tickets?.waiting ?? 0)} icon={Clock} tone="bg-violet-500/15 text-violet-400" />
              )}
            </div>
          </div>
        </section>

        {/* Charts row 2 - Atendimentos por dia */}
        <div className="grid gap-4">
          <ChartCard
            title="Atendimentos por dia"
            subtitle="Enviadas, respondidas, abertas e finalizadas"
            icon={MessageSquare}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={30} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }} />
                <Legend wrapperStyle={{ fontSize: 12, cursor: "pointer" }} onClick={makeLegendToggle(setHiddenDaily)} />
                <Bar dataKey="messagesOut" name="Mensagens enviadas" stackId="d" fill={C.emerald} radius={[0, 0, 0, 0]} hide={hiddenDaily.has("messagesOut")} />
                <Bar dataKey="respondedChats" name="Conversas respondidas" stackId="d" fill={C.violet} radius={[0, 0, 0, 0]} hide={hiddenDaily.has("respondedChats")} />
                <Bar dataKey="opened" name="Conversas abertas" stackId="d" fill={C.amber} radius={[0, 0, 0, 0]} hide={hiddenDaily.has("opened")} />
                <Bar dataKey="ticketsClosed" name="Conversas finalizadas" stackId="d" fill={C.sky} radius={[4, 4, 0, 0]} hide={hiddenDaily.has("ticketsClosed")} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        {/* Tempo médio 1ª resposta | gráfico comparativo | conversa finalizada */}
        <div className="grid gap-4 lg:grid-cols-3">
          <ChartCard
            title="Tempo médio 1ª resposta"
            subtitle={callsSelectedAgent ? callsSelectedAgent.name : "Geral e por agente"}
            icon={Clock}
          >
            <div className="flex h-full flex-col justify-center gap-3 px-2">
              <div className="text-center">
                <div className="text-3xl font-bold tracking-tight">
                  {callsSelectedAgent
                    ? formatMinutes(callsSelectedAgent.avgFirstResponseMin)
                    : formatMinutes(report?.avgFirstResponseMs ? Math.round(report.avgFirstResponseMs / 60000) : null)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {callsSelectedAgent ? "Média do agente" : "Média geral"}
                </div>
              </div>
              {!callsSelectedAgent && (
                <div className="max-h-32 space-y-1 overflow-y-auto border-t pt-2">
                  {topAgents.filter((a) => a.avgFirstResponseMin !== null).map((a) => (
                    <div key={a.name} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{a.name}</span>
                      <span className="font-medium">{formatMinutes(a.avgFirstResponseMin)}</span>
                    </div>
                  ))}
                  {topAgents.every((a) => a.avgFirstResponseMin === null) && (
                    <div className="text-center text-xs text-muted-foreground">Sem dados ainda</div>
                  )}
                </div>
              )}
            </div>
          </ChartCard>
          <ChartCard
            title="Tempo médio 1ª resposta x conversa finalizada"
            subtitle={callsSelectedAgent ? callsSelectedAgent.name : "Por agente, em minutos"}
            icon={Clock}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={callsSelectedAgent ? [callsSelectedAgent] : topAgents} layout="vertical" margin={{ top: 10, right: 12, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={90} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }} formatter={(value: number) => formatMinutes(value)} />
                <Legend wrapperStyle={{ fontSize: 12, cursor: "pointer" }} onClick={makeLegendToggle(setHiddenTimes)} />
                <Bar dataKey="avgFirstResponseMin" name="1ª resposta" fill={C.violet} radius={[0, 4, 4, 0]} hide={hiddenTimes.has("avgFirstResponseMin")} />
                <Bar dataKey="avgResolutionMin" name="Conversa finalizada" fill={C.emerald} radius={[0, 4, 4, 0]} hide={hiddenTimes.has("avgResolutionMin")} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard
            title="Tempo médio de conversa finalizada"
            subtitle={callsSelectedAgent ? callsSelectedAgent.name : "Geral e por agente"}
            icon={TrendingUp}
          >
            <div className="flex h-full flex-col justify-center gap-3 px-2">
              <div className="text-center">
                <div className="text-3xl font-bold tracking-tight">
                  {callsSelectedAgent
                    ? formatMinutes(callsSelectedAgent.avgResolutionMin)
                    : formatMinutes(tickets?.avgResolutionMs ? Math.round(tickets.avgResolutionMs / 60000) : null)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {callsSelectedAgent ? "Média do agente" : "Média geral"}
                </div>
              </div>
              {!callsSelectedAgent && (
                <div className="max-h-32 space-y-1 overflow-y-auto border-t pt-2">
                  {topAgents.filter((a) => a.avgResolutionMin !== null).map((a) => (
                    <div key={a.name} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{a.name}</span>
                      <span className="font-medium">{formatMinutes(a.avgResolutionMin)}</span>
                    </div>
                  ))}
                  {topAgents.every((a) => a.avgResolutionMin === null) && (
                    <div className="text-center text-xs text-muted-foreground">Sem dados ainda</div>
                  )}
                </div>
              )}
            </div>
          </ChartCard>
        </div>
        {/* Charts row 2b - Atendimentos por hora */}
        <div className="grid gap-4">
          <ChartCard
            title="Atendimentos por hora"
            subtitle={callsSelectedAgent ? `${callsSelectedAgent.name} · horários mais movimentados` : "Todos os agentes · horários mais movimentados"}
            icon={Clock}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourly} margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval={0} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={30} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }} />
                <Legend wrapperStyle={{ fontSize: 12, cursor: "pointer" }} onClick={makeLegendToggle(setHiddenHourly)} />
                <Bar dataKey="messagesIn" name="Mensagens recebidas" stackId="h" fill={C.blue} radius={[0, 0, 0, 0]} hide={hiddenHourly.has("messagesIn")} />
                <Bar dataKey="messagesOut" name="Mensagens enviadas" stackId="h" fill={C.emerald} radius={[0, 0, 0, 0]} hide={hiddenHourly.has("messagesOut")} />
                <Bar dataKey="receivedChats" name="Conversas recebidas" stackId="h" fill={C.rose} radius={[0, 0, 0, 0]} hide={hiddenHourly.has("receivedChats")} />
                <Bar dataKey="respondedChats" name="Conversas respondidas" stackId="h" fill={C.violet} radius={[0, 0, 0, 0]} hide={hiddenHourly.has("respondedChats")} />
                <Bar dataKey="opened" name="Conversas abertas" stackId="h" fill={C.amber} radius={[0, 0, 0, 0]} hide={hiddenHourly.has("opened")} />
                <Bar dataKey="ticketsClosed" name="Conversas finalizadas" stackId="h" fill={C.sky} radius={[4, 4, 0, 0]} hide={hiddenHourly.has("ticketsClosed")} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        {loading && (
          <p className="text-center text-xs text-muted-foreground">Carregando...</p>
        )}
      </div>
    </AppShell>
  );
}
