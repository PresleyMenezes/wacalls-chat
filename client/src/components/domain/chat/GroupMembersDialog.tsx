import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2, Search, Users } from "lucide-react";
import { listGroupParticipants, type GroupParticipant } from "@/services/chats";
import { GroupParticipantSheet } from "./GroupParticipantSheet";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sessionId: string;
  chatJid: string;
  onOpenChat: (jid: string) => void;
}

// Modal de "ver membros do grupo" — busca por nome e, ao clicar num
// membro, abre o mesmo painel de conversar/ligar que já usamos ao dar
// duplo clique no nome de quem mandou mensagem no grupo.
export const GroupMembersDialog = ({ open, onOpenChange, sessionId, chatJid, onOpenChat }: Props) => {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [members, setMembers] = useState<GroupParticipant[]>([]);
  const [selected, setSelected] = useState<{ jid: string; name: string } | null>(null);

  useEffect(() => {
    if (!open) {
      setQ("");
      setMembers([]);
      return;
    }
    setLoading(true);
    listGroupParticipants(sessionId, chatJid)
      .then(setMembers)
      .catch(() => setMembers([]))
      .finally(() => setLoading(false));
  }, [open, sessionId, chatJid]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return members;
    return members.filter(
      (m) => m.name.toLowerCase().includes(term) || m.jid.toLowerCase().includes(term),
    );
  }, [members, q]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-4 w-4" /> Membros do grupo
            </DialogTitle>
            <DialogDescription>Busque e clique num membro pra conversar ou ligar.</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar por nome…"
              className="pl-8"
              autoFocus
            />
          </div>
          <div className="max-h-80 overflow-y-auto rounded-md border">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Carregando membros…
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">Nenhum membro encontrado.</div>
            ) : (
              <ul className="divide-y">
                {filtered.map((m) => (
                  <li key={m.jid}>
                    <button
                      type="button"
                      onClick={() => setSelected({ jid: m.jid, name: m.name })}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/60"
                    >
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold uppercase">
                        {(m.name || "?").slice(0, 2)}
                      </div>
                      <div className="min-w-0 flex-1 truncate text-sm font-medium">{m.name || m.jid}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {selected && (
        <GroupParticipantSheet
          open={!!selected}
          onOpenChange={(v) => !v && setSelected(null)}
          sessionId={sessionId}
          participantJid={selected.jid}
          participantName={selected.name}
          onOpenChat={(jid) => {
            onOpenChat(jid);
            onOpenChange(false);
          }}
        />
      )}
    </>
  );
};
