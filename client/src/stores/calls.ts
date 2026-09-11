import { create } from "zustand";
import { toast } from "sonner";
import { eventStream, type BrokerEvent } from "@/lib/event-stream";
import { getClientId } from "@/lib/client-id";
import { queryClient, queryKeys } from "@/lib/query";
import type { OpenCall } from "@/lib/webrtc";
import type { CallSummary, IncomingPayload } from "@/types/call";
import { getRingbackUrl } from "@/lib/ringback";

type State = {
  calls: CallSummary[];
  ownConnections: Map<string, OpenCall>;
  ownSessions: Map<string, string>;
  incoming: IncomingPayload | null;
};

export const useCalls = create<State>(() => ({
  calls: [],
  ownConnections: new Map(),
  ownSessions: new Map(),
  incoming: null,
}));

// Rastreia, por conexão (sessionId), a limpeza de áudio/WebRTC ainda em
// andamento da última chamada encerrada nela — assim, ao iniciar uma
// chamada nova na MESMA conexão, dá pra esperar essa limpeza terminar de
// verdade antes de pedir o microfone de novo. Sem isso, desligar e ligar
// rapidamente podia deixar a chamada nova muda dos dois lados, porque o
// sistema operacional ainda não tinha liberado o áudio da chamada anterior.
const closingPromises = new Map<string, Promise<void>>();

export const waitForPendingClose = async (sid: string): Promise<void> => {
  const p = closingPromises.get(sid);
  if (!p) return;
  try {
    await p;
  } catch {
    /* ignore */
  }
};

export const resetCallsStore = (): void => {
  const current = useCalls.getState();
  for (const conn of current.ownConnections.values()) void conn.close();
  useCalls.setState({ calls: [], ownConnections: new Map(), ownSessions: new Map(), incoming: null });
};

let wired = false;

// Som de "chamando" — vive aqui, no nível do módulo (não dentro de nenhum
// componente React), porque o componente que antes controlava isso podia
// ser desmontado/remontado no meio da chamada (o app tem bastante
// atividade em tempo real acontecendo), matando o elemento de áudio sem
// recriar. Aqui ele sobrevive à vida inteira da aba, sem depender de
// nenhum ciclo de vida de componente.
let ringbackEl: HTMLAudioElement | null = null;
let ringbackStopTimer: number | null = null;

// Descobrimos (na prática, testando) que o status "tocando" de uma
// chamada não é confiável como sinal contínuo — o sistema de chamadas
// marca a chamada como "terminada" internamente logo no início da
// configuração (antes de realmente tocar por completo), e só atualiza de
// novo quando ela termina de verdade. Por isso, em vez de tocar/pausar
// seguindo esse status a cada instante, tocamos direto ao ligar e só
// paramos quando a chamada CONECTA de verdade ou depois de um tempo
// máximo de segurança (a maioria das chamadas não atendidas desiste
// sozinha por volta de 30-40s).
const RINGBACK_MAX_MS = 40000;

export const primeRingback = (): void => {
  if (ringbackEl) return;
  const el = new Audio();
  el.loop = true;
  el.volume = 0.5;
  el.src = getRingbackUrl();
  ringbackEl = el;
  void el.play().catch(() => {});
  if (ringbackStopTimer) window.clearTimeout(ringbackStopTimer);
  ringbackStopTimer = window.setTimeout(stopRingback, RINGBACK_MAX_MS);
};

const stopRingback = (): void => {
  if (ringbackStopTimer) {
    window.clearTimeout(ringbackStopTimer);
    ringbackStopTimer = null;
  }
  if (ringbackEl) {
    ringbackEl.pause();
    ringbackEl.currentTime = 0;
  }
};

const updateRingback = (): void => {
  if (!ringbackEl) return;
  // Só para o som quando a chamada realmente CONECTA (atendida) — esse
  // sim é um sinal confiável, diferente do status "tocando" que pisca.
  const connected = useCalls.getState().calls.some((c) => isMine(c) && c.status === "connected");
  if (connected) stopRingback();
};

export const ensureCallsWired = (): void => {
  if (wired) return;
  wired = true;
  useCalls.subscribe(updateRingback);
  eventStream.on((ev: BrokerEvent) => {
    if (ev.type === "call-list") {
      useCalls.setState({ calls: ev.calls });
    } else if (ev.type === "call-status") {
      useCalls.setState((s) => ({
        calls: s.calls.map((c) =>
          c.callId === ev.id
            ? { ...c, sessionId: ev.sessionId, status: ev.status, peer: ev.peer, startedAt: ev.startedAt }
            : c,
        ),
      }));
    } else if (ev.type === "call-ended") {
      console.log("[DIAG] call-ended event received at", new Date().toISOString(), ev);
      const before = useCalls.getState();
      const conn = before.ownConnections.get(ev.id);
      const sid = before.ownSessions.get(ev.id);
      let closePromise: Promise<void> | undefined;
      if (conn) {
        closePromise = conn.close().catch(() => {});
        if (sid) closingPromises.set(sid, closePromise);
      }
      useCalls.setState((s) => {
        const msg = conn ? callEndMessage(ev.reason) : null;
        if (msg) toast.error(msg);
        const next = new Map(s.ownConnections);
        next.delete(ev.id);
        const nextSessions = new Map(s.ownSessions);
        nextSessions.delete(ev.id);
        return {
          calls: s.calls.filter((c) => c.callId !== ev.id),
          ownConnections: next,
          ownSessions: nextSessions,
          incoming: s.incoming?.callId === ev.id ? null : s.incoming,
        };
      });
      if (closePromise && sid) {
        const settled = closePromise;
        void settled.finally(() => {
          if (closingPromises.get(sid) === settled) closingPromises.delete(sid);
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    } else if (ev.type === "incoming") {
      useCalls.setState((s) => ({
        incoming: {
          sessionId: ev.sessionId,
          callId: ev.id,
          peer: ev.peer,
          peerName: ev.peerName || s.incoming?.peerName,
          video: ev.video,
          offeredAt: ev.offeredAt,
        },
      }));
    } else if (ev.type === "incoming-claimed") {
      useCalls.setState((s) => (s.incoming?.callId === ev.id ? { incoming: null } : s));
    } else if (ev.type === "ura-auto-attend") {
      // A URA atendeu automaticamente — não mostramos o modal "Incoming",
      // mas avisamos o operador com um toast persistente contendo
      // o número de origem e o horário em que a chamada chegou.
      const when = new Date(ev.ts || Date.now()).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const who = ev.peerName?.trim() || formatPeer(ev.peer);
      toast.info(`URA assumiu o atendimento`, {
        description: `${ev.video ? "Vídeo" : "Voz"} • ${who} • ${when}`,
        duration: 8000,
        id: `ura-auto-${ev.id}`,
      });
    } else if (ev.type === "flow-skip") {
      // O backend pode reportar "flow-skip" mesmo quando a chamada disparou
      // normalmente por outro caminho (ex.: campanha sem URA inbound).
      // Para não poluir a UI com um toast vermelho enganoso, apenas logamos
      // no console — o operador ainda consegue puxar o trace se precisar.
      // eslint-disable-next-line no-console
      console.warn(
        `[flow-skip] traceId=${ev.traceId || "-"} reason=${ev.reason} callId=${ev.callId} detail=${ev.detail || "-"} → GET /api/flows/trace?callId=${ev.callId}`,
        ev,
      );
    }
  });
};

export const isMine = (call: CallSummary): boolean => call.owner === getClientId();

const callEndMessage = (reason: string): string | null => {
  if (reason === "timeout") return "Não foi possível estabelecer a mídia da chamada. Tente novamente.";
  if (reason === "aborted-before-sdp") return "A chamada foi encerrada antes de iniciar.";
  if (reason === "failed") return "A chamada falhou antes de conectar.";
  if (reason === "busy")
    return "O WhatsApp do destinatário recusou a chamada (ocupado ou sem permissão). Envie uma mensagem primeiro para liberar chamadas deste contato.";
  return null;
};

export const registerOwnConnection = (id: string, conn: OpenCall, sid?: string): void => {
  useCalls.setState((s) => {
    const next = new Map(s.ownConnections);
    next.set(id, conn);
    const nextSessions = new Map(s.ownSessions);
    if (sid) nextSessions.set(id, sid);
    return { ownConnections: next, ownSessions: nextSessions };
  });
  // Fonte de verdade adicional: monitora o estado REAL da conexão de voz
  // no navegador, em vez de depender só do evento do servidor avisando que
  // a chamada acabou (que às vezes falha em chegar — seja porque nós
  // desligamos, seja porque a outra pessoa desligou). Se a conexão cair de
  // verdade, limpa a tela na hora, sem precisar de F5.
  const pc = conn.pc;
  const onStateChange = () => {
    if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
      forceEndCallLocally(id);
    }
  };
  pc.addEventListener("connectionstatechange", onStateChange);
};

export const clearIncoming = (): void => useCalls.setState({ incoming: null });

// Rede de segurança: limpa uma chamada do estado local mesmo sem o
// servidor confirmar o fim dela — usado quando o botão "Desligar" não
// recebe confirmação em alguns segundos, pra nunca deixar o operador com
// a tela de chamada travada (mesmo que o motivo real do travamento
// continue precisando de investigação por trás).
export const forceEndCallLocally = (callId: string): void => {
  stopRingback();
  const before = useCalls.getState();
  const conn = before.ownConnections.get(callId);
  if (conn) void conn.close().catch(() => {});
  useCalls.setState((s) => {
    const next = new Map(s.ownConnections);
    next.delete(callId);
    const nextSessions = new Map(s.ownSessions);
    nextSessions.delete(callId);
    return {
      calls: s.calls.filter((c) => c.callId !== callId),
      ownConnections: next,
      ownSessions: nextSessions,
      incoming: s.incoming?.callId === callId ? null : s.incoming,
    };
  });
};

const formatPeer = (peer: string): string => {
  // peer é tipicamente "<digits>@s.whatsapp.net" ou "<digits>@lid".
  const raw = (peer || "").split("@")[0] || peer;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length >= 12 && digits.startsWith("55")) {
    const cc = digits.slice(0, 2);
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const mid = rest.length > 4 ? rest.slice(0, rest.length - 4) : rest;
    const end = rest.slice(-4);
    return `+${cc} (${ddd}) ${mid}-${end}`;
  }
  return digits ? `+${digits}` : peer;
};

const _flowSkipMessage = (reason: string, detail: string): string => {
  switch (reason) {
    case "no_inbound_flow":
      return "URA não disparou: nenhum fluxo habilitado com gatilho \"inbound\". Vincule um fluxo na conexão ou marque-o como inbound.";
    case "flow_disabled":
      return `URA não disparou: ${detail || "habilite o fluxo no FlowBuilder."}`;
    case "flow_not_found":
      return "URA não disparou: o fluxo vinculado foi removido. Revincule um fluxo na conexão.";
    case "flow_lookup_failed":
      return `URA não disparou: erro ao carregar fluxo (${detail}).`;
    case "tts_not_configured":
      return "URA disparou mas o TTS não está configurado (defina WACALLS_TTS_URL ou use voz ElevenLabs no nó).";
    case "tts_failed":
      return `URA: falha ao sintetizar voz (${detail}).`;
    default:
      return detail ? `URA: ${detail}` : "URA não disparou.";
  }
};
