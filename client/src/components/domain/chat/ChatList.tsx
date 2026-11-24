import { useMemo, useState } from "react";
import { ArrowLeftRight, RotateCcw, Send, X } from "lucide-react";
import { toast } from "sonner";
import { setChatStatus, useChats } from "@/stores/chats";
import { useSessions } from "@/stores/sessions";
import type { ChatSummary } from "@/types/chat";
import { formatPeer, formatRelative, isGroupJid, previewBody } from "./format";
import { closeChat, requeueChat } from "@/services/chats";
import { TransferDialog } from "./TransferDialog";
import { useAuth } from "@/stores/auth";

import { CloseReasonDialog } from "./CloseReasonDialog";

const EMPTY: ChatSummary[] = [];

export type ChatTab = "open" | "waiting" | "group";

interface Props {
  sessionId: string;
  activeJid: string | null;
  tab: ChatTab;
  myId: string | null;
  unreadOnly?: boolean;
  sort?: "desc" | "asc";
  onSelect: (jid: string) => void;
  onStatusChange?: (status: "open" | "waiting" | "closed") => void;
}

// filterChats applies the tab + extra filters that the dropdown menu controls.
// Exported so the parent page can pre-compute which chats a bulk action covers.
export const filterChats = (
  chats: ChatSummary[],
  tab: ChatTab,
  myId: string | null,
  unreadOnly = false,
  sharedAttendance = true,
): ChatSummary[] =>
  chats.filter((c) => {
    const status = c.status ?? (c.lastFromMe ? "open" : "waiting");
    // Conversations that were closed in bulk must vanish from every tab
    // until a new message arrives and reopens them.
    if (status === "closed") return false;
    if (tab === "waiting" && status !== "waiting") return false;
    if (tab === "open") {
      if (status !== "open") return false;
      // Atendimento compartilhado (padrão, ligado por conexão): qualquer
      // agente com acesso à conexão vê e responde conversas "Em
      // atendimento", não só quem clicou em "Atender" primeiro. Com o
      // toggle desligado para esta conexão, volta ao modelo exclusivo.
      if (!sharedAttendance && myId && c.assignedUserId && c.assignedUserId !== myId) return false;
    }
    if (unreadOnly && (c.unread ?? 0) <= 0) return false;
    return true;
  });

export const ChatList = ({ sessionId, activeJid, tab, myId, unreadOnly, sort = "desc", onSelect, onStatusChange }: Props) => {
  const chats = useChats((s) => s.chatsBySession[sessionId] ?? EMPTY);
  const loading = useChats((s) => s.loadingChats[sessionId] ?? false);
  const sessionName = useSessions((s) => s.sessions.find((x) => x.id === sessionId)?.name ?? "");
  const sharedAttendance = useSessions((s) => s.sessions.find((x) => x.id === sessionId)?.sharedAttendance ?? true);
  const [transferFor, setTransferFor] = useState<ChatSummary | null>(null);
  const [closeFor, setCloseFor] = useState<ChatSummary | null>(null);
  const filtered = useMemo(() => {
    const list = filterChats(chats, tab, myId, unreadOnly, sharedAttendance);
    return [...list].sort((a, b) =>
      sort === "asc" ? (a.lastTs ?? 0) - (b.lastTs ?? 0) : (b.lastTs ?? 0) - (a.lastTs ?? 0),
    );
  }, [chats, tab, myId, unreadOnly, sort, sharedAttendance]);

  if (loading && filtered.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">Carregando conversas…</div>;
  }

  if (filtered.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Nada por aqui ainda.
      </div>
    );
  }

  return (
    <>
      <ul className="scrollbar-thin flex-1 overflow-y-auto">
        {filtered.map((c) => (
          <ChatRow
            key={c.chatJid}
            chat={c}
            sessionId={sessionId}
            sessionName={sessionName}
            active={c.chatJid === activeJid}
            tab={tab}
            onClick={() => onSelect(c.chatJid)}
            onTransfer={() => setTransferFor(c)}
            onRequestClose={() => setCloseFor(c)}
            onStatusChange={onStatusChange}
          />
        ))}
      </ul>
      {closeFor && (
        <CloseReasonDialog
          chatName={closeFor.name?.trim() || formatPeer(closeFor.chatJid)}
          onCancel={() => setCloseFor(null)}
          onConfirm={async (reason) => {
            const target = closeFor;
            setCloseFor(null);
            try {
              await closeChat(sessionId, target.chatJid, reason);
              setChatStatus(sessionId, target.chatJid, "closed", null);
              onStatusChange?.("closed");
              toast.success("Atendimento finalizado");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Falha ao finalizar");
            }
          }}
        />
      )}
      {transferFor && (
        <TransferDialog
          open={!!transferFor}
          onOpenChange={(o) => { if (!o) setTransferFor(null); }}
          sessionId={sessionId}
          chatJid={transferFor.chatJid}
          chatName={transferFor.name?.trim() || formatPeer(transferFor.chatJid)}
          excludeUserId={useAuth.getState().user?.id ?? null}
          onTransferred={() => {
            setChatStatus(sessionId, transferFor.chatJid, "open");
            onStatusChange?.("open");
          }}
        />
      )}
    </>
  );
};

interface RowProps {
  chat: ChatSummary;
  sessionId: string;
  sessionName: string;
  active: boolean;
  tab: ChatTab;
  onClick: () => void;
  onTransfer: () => void;
  onRequestClose: () => void;
  onStatusChange?: (status: "open" | "waiting" | "closed") => void;
}

const ChatRow = ({ chat, sessionId, sessionName, active, tab, onClick, onTransfer, onRequestClose, onStatusChange }: RowProps) => {
  const name = chat.name && chat.name.trim() !== "" ? chat.name : formatPeer(chat.chatJid);
  const unread = chat.unread ?? 0;
  const isGroup = chat.isGroup || isGroupJid(chat.chatJid);

  const [busy, setBusy] = useState<null | "assign" | "close" | "requeue" | "transfer">(null);
  const run = async (kind: typeof busy, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    try { await fn(); } finally { setBusy(null); }
  };

  // Action handlers. Each one calls the existing API and optimistically
  // mutates the local chat store so the row hops to the right tab instantly.
  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    void run("close", async () => {
      try {
        await closeChat(sessionId, chat.chatJid);
        setChatStatus(sessionId, chat.chatJid, "closed", null);
        onStatusChange?.("closed");
        toast.success("Atendimento finalizado");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Falha ao finalizar");
      }
    });
  };
  const handleRequeue = (e: React.MouseEvent) => {
    e.stopPropagation();
    void run("requeue", async () => {
      try {
        await requeueChat(sessionId, chat.chatJid);
        setChatStatus(sessionId, chat.chatJid, "waiting", null);
        onStatusChange?.("waiting");
        toast.success("Devolvido para a fila");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Falha ao devolver");
      }
    });
  };
  const handleTransfer = (e: React.MouseEvent) => {
    e.stopPropagation();
    onTransfer();
  };

  return (
    <li>
      <div
        onClick={onClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onClick();
        }}
        className={`group flex w-full cursor-pointer items-start gap-3 border-b pl-3 pr-4 py-3 text-left transition-colors hover:bg-muted/60 ${active ? "bg-muted" : ""}`}
      >
        {/* Avatar. O selo verde do WhatsApp foi removido: era confundido com
            o contador de mensagens não lidas. */}
        <div className="relative shrink-0">
          <span className="relative grid h-11 w-11 place-items-center overflow-hidden rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {/* Letra de fallback sempre renderiza por baixo, então o card
                aparece imediatamente; a foto, quando decodificar, faz
                fade-in por cima — sem o "buraco" branco que parecia delay. */}
            <span aria-hidden className="select-none">{name.slice(0, 1).toUpperCase()}</span>
            {chat.avatarUrl && (
              <img
                src={chat.avatarUrl}
                alt={name}
                width={44}
                height={44}
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-150"
                onLoad={(e) => {
                  (e.currentTarget as HTMLImageElement).style.opacity = "1";
                }}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            )}
          </span>
          {unread > 0 && (
            <span
              aria-label={`${unread} não lida${unread === 1 ? "" : "s"}`}
              className="absolute -top-1 -right-1 grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-background"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={`min-w-0 flex-1 truncate text-sm ${unread > 0 ? "font-semibold text-foreground" : "font-medium text-foreground"}`}>
              {name}
            </span>
          </div>

          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>{formatRelative(chat.lastTs)}</span>
          </div>

          <div className="mt-1 flex items-end justify-between gap-2">
            <span className={`min-w-0 flex-1 truncate text-xs ${unread > 0 ? "text-foreground" : "text-muted-foreground"}`}>
              {chat.lastFromMe ? "Você: " : ""}
              {previewBody(chat.lastKind, chat.lastMessage)}
            </span>
          </div>
        </div>

        {/* Side action column — buttons stack to the right of the content,
            matching the reference layout (Atendendo/Aguardando cards). */}
        {(tab === "waiting" || tab === "open") && (
          <div className="ml-3 mr-1 flex shrink-0 items-center justify-center gap-1 self-center">
            {tab === "waiting" ? (
              <>
                {/* Aguardando: transferir / finalizar — aceitar acontece
                    sozinho ao começar a digitar dentro da conversa. */}
                <RowAction tone="lavender" label="Transferir" onClick={handleTransfer} disabled={!!busy} square>
                  <ArrowLeftRight className="h-2.5 w-2.5" />
                </RowAction>
                <RowAction tone="dangerSolid" label="Finalizar" busy={busy === "close"} disabled={!!busy} onClick={handleClose} square>
                  <X className="h-2.5 w-2.5" strokeWidth={3} />
                </RowAction>
              </>
            ) : (
              <>
                {/* Atendendo: transferir / finalizar / devolver — alinhados em linha */}
                <RowAction tone="lavender" label="Transferir" onClick={handleTransfer} disabled={!!busy} square>
                  <ArrowLeftRight className="h-2.5 w-2.5" />
                </RowAction>
                <RowAction tone="dangerSolid" label="Finalizar" busy={busy === "close"} disabled={!!busy} onClick={handleClose} square>
                  <X className="h-2.5 w-2.5" strokeWidth={3} />
                </RowAction>
                <RowAction tone="neutral" label="Devolver para fila" busy={busy === "requeue"} disabled={!!busy} onClick={handleRequeue} square>
                  <RotateCcw className="h-2.5 w-2.5" />
                </RowAction>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
};

// RowAction renders a compact action button matching the reference cards:
//  - success / dangerSolid / dark: filled, white icon (Aguardando "Aceitar", Atendendo "Finalizar")
//  - dangerOutline: light bg + colored border/icon (Aguardando "X")
//  - lavender: soft indigo chip (Atendendo "Transferir")
//  - neutral: subtle muted chip (Devolver)
// `square` switches from circular pill (Aguardando) to rounded-square (Atendendo).
// Stops propagation so clicking it doesn't also open the conversation.
type Tone = "success" | "dangerSolid" | "dangerOutline" | "dark" | "lavender" | "neutral";
const TONE_CLASSES: Record<Tone, string> = {
  success:
    "bg-emerald-500 text-white border-transparent shadow-sm hover:bg-emerald-600 active:bg-emerald-700",
  dangerSolid:
    "bg-rose-500 text-white border-transparent shadow-sm hover:bg-rose-600 active:bg-rose-700",
  dangerOutline:
    "bg-rose-500/10 text-rose-600 border-rose-500/40 hover:bg-rose-500/20 dark:text-rose-400",
  dark:
    "bg-slate-800 text-white border-transparent hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white",
  lavender:
    "bg-indigo-500/15 text-indigo-600 border-indigo-500/30 hover:bg-indigo-500/25 dark:text-indigo-300",
  neutral:
    "bg-muted text-foreground border-border hover:bg-muted/80",
};
const RowAction = ({
  tone,
  label,
  onClick,
  children,
  disabled,
  busy,
  square,
}: {
  tone: Tone;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  disabled?: boolean;
  busy?: boolean;
  square?: boolean;
}) => {
  const shape = square ? "rounded-md" : "rounded-full";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-6 w-6 items-center justify-center border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${shape} ${TONE_CLASSES[tone]}`}
    >
      {busy ? (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        children
      )}
    </button>
  );
};
