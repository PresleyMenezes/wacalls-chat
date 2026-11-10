import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { BellRing, X } from "lucide-react";
import { create } from "zustand";
import { eventStream, type BrokerEvent } from "@/lib/event-stream";
import { useChats, markChatAsRead, setActiveChat } from "@/stores/chats";
import { useAuth } from "@/stores/auth";
import { useSessions } from "@/stores/sessions";
import { formatPhone } from "@/lib/phone-format";
import { installAudioUnlock, playNotificationSound } from "@/lib/favicon-badge";
import type { ChatMessage } from "@/types/chat";

// Aviso de "nova mensagem": reage a CADA mensagem recebida (e não ao contador
// de conversas não lidas), então toca som e mostra o aviso mesmo quando já
// existe outra mensagem não lida na mesma conversa, ou quando a conversa está
// aberta mas a aba está em segundo plano.
//
//  - Aba visível: bloco no TOPO da tela; clicar abre a conversa.
//  - Aba em segundo plano: som + notificação do navegador (se permitida).
//    A posição da notificação do navegador é definida pelo sistema
//    operacional (no Windows, canto inferior direito) e não dá para mudar.

// Ignora mensagens antigas (fila pendente / histórico que chega ao reconectar).
const MAX_MESSAGE_AGE_MS = 90_000;
const BANNER_TTL_SECONDS = 10;
const MAX_BANNERS = 3;
const HINT_KEY = "wacalls.notif.hint.dismissed";

const NOTIFY_KINDS = new Set<ChatMessage["kind"]>([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
]);

type BannerItem = {
  key: string;
  sessionId: string;
  chatJid: string;
  name: string;
  avatarUrl?: string;
  preview: string;
  count: number;
  ttl: number;
};

type BannerState = {
  items: BannerItem[];
  push: (i: Omit<BannerItem, "count" | "ttl">) => void;
  remove: (key: string) => void;
  tick: (pausedKey: string | null) => void;
};

const useBanners = create<BannerState>((set) => ({
  items: [],
  push: (i) =>
    set((s) => {
      const idx = s.items.findIndex((x) => x.key === i.key);
      if (idx >= 0) {
        // Mesma conversa: soma ao contador e traz para o topo.
        const merged: BannerItem = { ...s.items[idx], ...i, count: s.items[idx].count + 1, ttl: BANNER_TTL_SECONDS };
        const rest = s.items.filter((_, n) => n !== idx);
        return { items: [merged, ...rest] };
      }
      return { items: [{ ...i, count: 1, ttl: BANNER_TTL_SECONDS }, ...s.items].slice(0, MAX_BANNERS) };
    }),
  remove: (key) => set((s) => ({ items: s.items.filter((x) => x.key !== key) })),
  tick: (pausedKey) =>
    set((s) => ({
      items: s.items
        .map((x) => (x.key === pausedKey ? x : { ...x, ttl: x.ttl - 1 }))
        .filter((x) => x.ttl > 0),
    })),
}));

const cut = (text: string, max = 100): string => (text.length > max ? `${text.slice(0, max)}…` : text);

const previewOf = (m: ChatMessage): string => {
  const body = (m.body || "").trim().replace(/\s+/g, " ");
  switch (m.kind) {
    case "text":
      return body ? cut(body) : "Nova mensagem";
    case "image":
      return body ? `📷 ${cut(body)}` : "📷 Foto";
    case "video":
      return body ? `🎥 ${cut(body)}` : "🎥 Vídeo";
    case "audio":
      return "🎤 Áudio";
    case "document":
      return `📄 ${m.fileName || "Documento"}`;
    case "sticker":
      return "Figurinha";
    case "location":
      return "📍 Localização";
    case "contact":
      return "👤 Contato";
    default:
      return body ? cut(body) : "Nova mensagem";
  }
};

const showBrowserNotification = (
  key: string,
  title: string,
  body: string,
  icon: string | undefined,
  onClick: () => void,
): void => {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    // silent: o som já é tocado pelo próprio app (evita bip duplo).
    const n = new Notification(title, { body, icon: icon || "/favicon.png", tag: `chat:${key}`, silent: true });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
    window.setTimeout(() => n.close(), 12_000);
  } catch {
    /* notificação é um extra — nunca deve quebrar a UI */
  }
};

export const NewMessageBanner = () => {
  const navigate = useNavigate();
  const loc = useLocation();
  const me = useAuth((s) => s.user);
  const sessions = useSessions((s) => s.sessions);
  const items = useBanners((s) => s.items);
  const activeJidBySession = useChats((s) => s.activeJidBySession);

  const openChat = (sessionId: string, jid: string) => {
    setActiveChat(sessionId, jid);
    markChatAsRead(sessionId, jid);
    navigate(`/chats?sid=${encodeURIComponent(sessionId)}&jid=${encodeURIComponent(jid)}`);
  };

  // Valores "vivos" para o ouvinte de eventos, que é registrado uma só vez.
  const live = useRef({ me, sessions, pathname: loc.pathname, openChat });
  useEffect(() => {
    live.current = { me, sessions, pathname: loc.pathname, openChat };
  });

  const seen = useRef<string[]>([]);

  useEffect(() => {
    installAudioUnlock();
    const off = eventStream.on((ev: BrokerEvent) => {
      if (ev.type !== "message") return;
      const m = ev.message;
      if (m.fromMe || m.deleted || !NOTIFY_KINDS.has(m.kind)) return;
      if (!m.ts || Date.now() - m.ts > MAX_MESSAGE_AGE_MS) return;
      // Reedições da mesma mensagem (edição, atualização de mídia) não avisam de novo.
      if (seen.current.includes(m.id)) return;
      seen.current.push(m.id);
      if (seen.current.length > 300) seen.current.splice(0, 100);

      const { me: user, sessions: sess, pathname, openChat: open } = live.current;
      const st = useChats.getState();
      const chat = st.chatsBySession[m.sessionId]?.find((c) => c.chatJid === m.chatJid);

      // Grupos seguem a escolha feita na conexão ("aceitar mensagens de grupo"):
      // se a conexão aceita grupos, avisa; se não aceita, não avisa.
      const isGroupChat = !!chat?.isGroup || chat?.status === "group" || m.chatJid.endsWith("@g.us");
      if (isGroupChat && !sess.find((s) => s.id === m.sessionId)?.allowGroups) return;
      // Atendimento em andamento com OUTRO operador: não incomoda este.
      if (chat?.status === "open" && chat.assignedUserId && chat.assignedUserId !== user?.id) return;
      // Mesma regra de filas do sininho: quem tem filas definidas só é avisado das suas.
      const restricted = !user?.roles?.includes("admin") && !!user?.queueIds?.length;
      if (restricted) {
        const sessionQueue = sess.find((s) => s.id === m.sessionId)?.queueId;
        const effective = chat?.queueId || sessionQueue;
        if (effective && !user?.queueIds?.includes(effective)) return;
      }

      const focused = document.visibilityState === "visible" && document.hasFocus();
      const viewing =
        focused && pathname.startsWith("/chats") && st.activeJidBySession[m.sessionId] === m.chatJid;
      if (viewing) return; // o operador está olhando esta conversa agora

      const key = `${m.sessionId}:${m.chatJid}`;
      const name = chat?.name?.trim() || m.senderName?.trim() || formatPhone(m.chatJid);
      const preview = previewOf(m);

      playNotificationSound();
      useBanners.getState().push({ key, sessionId: m.sessionId, chatJid: m.chatJid, name, avatarUrl: chat?.avatarUrl, preview });
      if (!focused) {
        showBrowserNotification(key, name, preview, chat?.avatarUrl, () => open(m.sessionId, m.chatJid));
      }
    });
    return off;
  }, []);

  // Contagem regressiva do aviso: só corre com a aba visível, e pausa com o mouse em cima.
  const pausedRef = useRef<string | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") useBanners.getState().tick(pausedRef.current);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Se o operador abre a conversa por outro caminho, o aviso dela some.
  useEffect(() => {
    if (!loc.pathname.startsWith("/chats") || document.visibilityState !== "visible") return;
    for (const it of useBanners.getState().items) {
      if (activeJidBySession[it.sessionId] === it.chatJid) useBanners.getState().remove(it.key);
    }
  }, [activeJidBySession, loc.pathname, items]);

  // Convite para ativar as notificações do navegador (uma vez; dispensável).
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [hintDismissed, setHintDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HINT_KEY) === "1";
    } catch {
      return false;
    }
  });
  const showHint = perm === "default" && !hintDismissed;
  const dismissHint = () => {
    setHintDismissed(true);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* noop */
    }
  };

  if (!showHint && items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[70] flex flex-col items-center gap-2 px-3" aria-live="polite">
      {showHint && (
        <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border bg-popover px-3 py-2.5 text-popover-foreground shadow-xl ring-1 ring-black/5">
          <BellRing className="h-5 w-5 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 text-xs leading-snug">
            Ative as notificações do navegador para ser avisado de novas mensagens mesmo com esta aba em segundo plano.
          </p>
          <button
            type="button"
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
            onClick={() => {
              void Notification.requestPermission()
                .then(setPerm)
                .catch(() => {});
            }}
          >
            Ativar
          </button>
          <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-foreground" onClick={dismissHint}>
            Agora não
          </button>
        </div>
      )}
      {items.map((it) => (
        <div key={it.key} className="pointer-events-auto relative w-full max-w-md animate-in fade-in slide-in-from-top-2">
          <button
            type="button"
            onClick={() => {
              openChat(it.sessionId, it.chatJid);
              useBanners.getState().remove(it.key);
            }}
            onMouseEnter={() => {
              pausedRef.current = it.key;
            }}
            onMouseLeave={() => {
              pausedRef.current = null;
            }}
            className="flex w-full items-center gap-3 rounded-xl border bg-popover px-3 py-2.5 pr-9 text-left text-popover-foreground shadow-xl ring-1 ring-black/5 transition hover:bg-accent"
          >
            {it.avatarUrl ? (
              <img src={it.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                {(it.name || "?").slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{it.name}</span>
                {it.count > 1 && (
                  <span className="shrink-0 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                    {it.count} novas
                  </span>
                )}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{it.preview}</span>
            </span>
          </button>
          <button
            type="button"
            aria-label="Fechar aviso"
            onClick={() => useBanners.getState().remove(it.key)}
            className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
