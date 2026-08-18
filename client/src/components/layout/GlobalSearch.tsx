import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import { searchMessages } from "@/services/search";
import type { SearchResult } from "@/services/search";

const KIND_LABEL: Record<string, string> = {
  image: "📷 Foto",
  video: "🎥 Vídeo",
  audio: "🎤 Áudio",
  document: "📄 Documento",
  contact: "👤 Contato",
  sticker: "Figurinha",
};

const previewText = (r: SearchResult): string => {
  if (r.kind === "text" || !r.kind) return r.body || "";
  return KIND_LABEL[r.kind] || r.body || r.kind;
};

const formatTs = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
};

// Highlights the matched substring inside a result preview — purely visual,
// case-insensitive, first occurrence only (results are already filtered
// server-side, this is just to help the eye find the match).
const highlight = (text: string, query: string) => {
  if (!query.trim()) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-amber-300/70 text-inherit">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
};

export const GlobalSearch = () => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
    else { setQuery(""); setResults([]); }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await searchMessages(q, 50);
        if (!cancelled) setResults(r);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [query]);

  const grouped = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      const key = `${r.sessionId}::${r.chatJid}`;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [results]);

  const openResult = (r: SearchResult) => {
    setOpen(false);
    navigate(`/chats?jid=${encodeURIComponent(r.chatJid)}&sid=${r.sessionId}&mid=${encodeURIComponent(r.messageId)}`);
  };

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Buscar mensagens"
        onClick={() => setOpen(true)}
        className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <Search className="h-4.5 w-4.5" />
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-4 pt-[10vh]" onClick={() => setOpen(false)}>
      <div
        className="flex w-full max-w-lg flex-col rounded-lg border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
            placeholder="Buscar em todas as conversas…"
            className="w-full bg-transparent text-sm outline-none"
          />
          <button onClick={() => setOpen(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">Buscando…</div>
          )}
          {!loading && query.trim().length >= 2 && grouped.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">Nenhum resultado encontrado.</div>
          )}
          {!loading && query.trim().length < 2 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">Digite pelo menos 2 caracteres.</div>
          )}
          {grouped.map(([key, items]) => {
            const first = items[0];
            const name = first.chatName?.trim() || first.chatJid;
            return (
              <div key={key} className="border-b last:border-b-0">
                <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5">
                  <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                    {first.avatarUrl ? (
                      <img src={first.avatarUrl} alt={name} className="h-full w-full object-cover" />
                    ) : (
                      name.slice(0, 1).toUpperCase()
                    )}
                  </span>
                  <span className="truncate text-xs font-semibold">{name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{items.length}</span>
                </div>
                {items.map((r) => (
                  <button
                    key={r.messageId}
                    type="button"
                    onClick={() => openResult(r)}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted/60"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-muted-foreground">{r.fromMe ? "Você" : name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{formatTs(r.ts)}</span>
                    </div>
                    <div className="truncate">{highlight(previewText(r), query)}</div>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
