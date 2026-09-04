import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Loader2, MessageCircle, Phone } from "lucide-react";
import { resolveLidPhone, syncChatContact } from "@/services/chats";
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
  const [resolving, setResolving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined);
  const [displayName, setDisplayName] = useState(participantName);
  const micId = useDevices((s) => s.micId);
  const outId = useDevices((s) => s.outId);
  const start = useStartCall(sessionId, micId, outId);

  useEffect(() => {
    if (!open || !participantJid) {
      setPhone(null);
      setAvatarUrl(undefined);
      setDisplayName(participantName);
      return;
    }
    setDisplayName(participantName);
    if (participantJid.endsWith("@lid")) {
      setResolving(true);
      setPhone(null);
      resolveLidPhone(sessionId, participantJid)
        .then((r) => setPhone(r?.phone ? r.phone.replace(/\D/g, "") : null))
        .finally(() => setResolving(false));
    } else {
      const digits = (participantJid.split("@")[0] ?? "").replace(/\D/g, "");
      setPhone(digits || null);
    }
    // Busca nome e foto de perfil reais direto do WhatsApp — o nome que
    // aparece na mensagem do grupo às vezes é só o "nome de exibição"
    // curto, e a foto nunca vem junto com a mensagem em si.
    syncChatContact(sessionId, participantJid)
      .then((meta) => {
        if (meta.avatarUrl) setAvatarUrl(meta.avatarUrl);
        if (meta.name) setDisplayName(meta.name);
      })
      .catch(() => {
        /* segue sem foto — não é crítico */
      });
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
          <SheetTitle className="mt-2 truncate">{displayName || "Participante"}</SheetTitle>
          <SheetDescription>
            {resolving ? "Resolvendo número..." : phone ? formatPhone(`+${phone}`) : "Número não disponível"}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-2 px-4">
          <Button
            className="w-full justify-start"
            variant="outline"
            onClick={() => {
              onOpenChat(participantJid);
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
