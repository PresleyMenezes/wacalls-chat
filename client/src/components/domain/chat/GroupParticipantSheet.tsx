import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Loader2, MessageCircle, Phone } from "lucide-react";
import { resolveLidPhone, syncChatContact, assignChat } from "@/services/chats";
import { updateContact } from "@/services/contacts";
import { fetchChats, useChats } from "@/stores/chats";
import { formatPhone } from "@/lib/phone-format";
import { useStartCall } from "@/hooks/useStartCall";
import { useDevices } from "@/stores/devices";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sessionId: string;
  participantJid: string;
  participantName: string;
  onOpenChat: (jid: string) => void;
}

// Painel lateral aberto ao clicar duas vezes no nome de um participante
// dentro de uma conversa de grupo — mesma ideia do WhatsApp Web: uma forma
// rápida de conversar ou ligar diretamente pra essa pessoa, sem precisar
// sair do grupo pra procurá-la nos Contatos.
export const GroupParticipantSheet = ({
  open,
  onOpenChange,
  sessionId,
  participantJid,
  participantName,
  onOpenChat,
}: Props) => {
  const [phone, setPhone] = useState<string | null>(null);
  const [resolvedJid, setResolvedJid] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined);
  const [displayName, setDisplayName] = useState(participantName);
  const micId = useDevices((s) => s.micId);
  const outId = useDevices((s) => s.outId);
  const start = useStartCall(sessionId, micId, outId);
  // Conversas já conhecidas nessa conexão — se essa pessoa já tem uma
  // conversa aberta, reaproveita ela direto (já em cache, abre na hora),
  // em vez de tratar como se fosse um contato novo toda vez.
  const knownChats = useChats((s) => s.chatsBySession[sessionId] ?? []);

  useEffect(() => {
    if (!open || !participantJid) {
      setPhone(null);
      setResolvedJid(null);
      setAvatarUrl(undefined);
      setDisplayName(participantName);
      return;
    }
    setDisplayName(participantName);
    if (participantJid.endsWith("@lid")) {
      setResolving(true);
      setPhone(null);
      setResolvedJid(null);
      resolveLidPhone(sessionId, participantJid)
        .then((r) => {
          setPhone(r?.phone ? r.phone.replace(/\D/g, "") : null);
          // Usa o JID canônico devolvido pela própria resolução, em vez de
          // remontar "telefone@s.whatsapp.net" na mão — remontar pode gerar
          // um formato levemente diferente do que o WhatsApp usa de
          // verdade (ex.: o "9" extra em celulares brasileiros), criando
          // uma conversa duplicada em vez de abrir a que já existe.
          setResolvedJid(r?.jid ?? null);
        })
        .finally(() => setResolving(false));
    } else {
      const digits = (participantJid.split("@")[0] ?? "").replace(/\D/g, "");
      setPhone(digits || null);
      setResolvedJid(participantJid);
    }
    // Busca nome e foto de perfil reais direto do WhatsApp — só quando
    // ainda não sabemos quem é essa pessoa. Se já existe uma conversa (ou
    // o nome do grupo já é suficiente), pula essa busca ao vivo — ela é
    // lenta e não é necessária, e evita gerar atualizações em segundo
    // plano bem na hora que o chat está abrindo.
    const alreadyKnown = knownChats.some((c) => {
      if (c.chatJid === participantJid) return true;
      const cDigits = c.chatJid.split("@")[0]?.replace(/\D/g, "") ?? "";
      const pDigits = (participantJid.split("@")[0] ?? "").replace(/\D/g, "");
      return cDigits.length >= 8 && pDigits.length >= 8 && cDigits.slice(-8) === pDigits.slice(-8);
    });
    if (!alreadyKnown) {
      syncChatContact(sessionId, participantJid)
        .then((meta) => {
          if (meta.avatarUrl) setAvatarUrl(meta.avatarUrl);
          if (meta.name) setDisplayName(meta.name);
        })
        .catch(() => {
          /* segue sem foto — não é crítico */
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, participantJid, participantName, sessionId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[340px] sm:w-[380px]">
        <SheetHeader className="items-center text-center">
          <div className="mx-auto grid h-20 w-20 place-items-center overflow-hidden rounded-full bg-primary/10 text-2xl font-semibold text-primary ring-4 ring-background shadow-sm">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={displayName}
                className="h-full w-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              (displayName || "?").slice(0, 1).toUpperCase()
            )}
          </div>
          <SheetTitle className="mt-2 break-words px-2 text-center">{displayName || "Participante"}</SheetTitle>
          <SheetDescription>
            {resolving ? "Resolvendo número..." : phone ? formatPhone(`+${phone}`) : "Número não disponível"}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-2 px-4">
          <Button
            className="w-full justify-start"
            variant="outline"
            disabled={resolving}
            onClick={() => {
              // Usa o JID canônico já resolvido (não remonta na mão) —
              // garante que abre a MESMA conversa que já existe com essa
              // pessoa, em vez de criar uma duplicata em "Atendendo".
              const resolved = resolvedJid ?? participantJid;
              // Se essa pessoa já tem uma conversa aberta nessa conexão,
              // usa exatamente essa conversa (já em cache no navegador) —
              // abre na hora, sem esperar nada. Só faz as chamadas de
              // nome/aceitar/recarregar quando é uma conversa GENUINAMENTE
              // nova (nunca vista antes), que é quando elas são realmente
              // necessárias.
              const existing = knownChats.find((c) => {
                if (c.chatJid === resolved) return true;
                if (!phone) return false;
                const cDigits = c.chatJid.split("@")[0]?.replace(/\D/g, "") ?? "";
                // Compara só os últimos 8 dígitos — evita falhar por causa
                // do "9" extra que números de celular brasileiros às vezes
                // têm numa representação e não na outra, mesmo sendo a
                // mesma pessoa.
                return cDigits.length >= 8 && phone.length >= 8 && cDigits.slice(-8) === phone.slice(-8);
              });
              if (existing) {
                // Mesmo já existindo, garante que está "aceita" — sem
                // isso, se a conversa ainda estiver em "Aguardando", o
                // campo de escrever fica bloqueado até alguém aceitar.
                void assignChat(sessionId, existing.chatJid);
                onOpenChat(existing.chatJid);
                onOpenChange(false);
                return;
              }
              const openJid = resolved;
              // Depois que as chamadas em segundo plano terminarem, recarrega
              // a lista de conversas do zero (mesma coisa que o F5 faz) —
              // corrige sozinho qualquer entrada duplicada que apareça
              // momentaneamente, sem precisar de F5 manual.
              void Promise.all([
                displayName ? updateContact(sessionId, openJid, { name: displayName }) : Promise.resolve(),
                assignChat(sessionId, openJid),
              ]).finally(() => {
                void fetchChats(sessionId);
              });
              onOpenChat(openJid);
              onOpenChange(false);
            }}
          >
            <MessageCircle className="mr-2 h-4 w-4" />
            Conversar
          </Button>
          <Button
            className="w-full justify-start"
            variant="outline"
            disabled={!phone || start.isPending}
            onClick={() => {
              if (!phone) return;
              start.mutate({ phone: `+${phone}`, record: false, video: false });
              onOpenChange(false);
            }}
          >
            {start.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Phone className="mr-2 h-4 w-4 text-emerald-500" />
            )}
            Ligar
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};
