import { useEffect, useState } from "react";
import { Loader2, Smartphone, Users2, UsersRound, Bot } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { updateSession, regenerateWebhookToken } from "@/services/sessions";
import { listQueues } from "@/services/queues";
import type { SessionInfo } from "@/types/session";
import type { Queue } from "@/types/queue";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: SessionInfo;
  onSaved?: () => void;
};

export const EditConnectionModal = ({ open, onOpenChange, session, onSaved }: Props) => {
  const [allowGroups, setAllowGroups] = useState(!!session.allowGroups);
  const [allowBroadcast, setAllowBroadcast] = useState(!!session.allowBroadcast);
  // Padrão true (igual o backend) — sessões antigas sem esse campo ainda
  // preenchido no cache do navegador devem continuar no modo compartilhado.
  const [sharedAttendance, setSharedAttendance] = useState(session.sharedAttendance ?? true);
  const [webhookInboundUrl, setWebhookInboundUrl] = useState(session.webhookInboundUrl ?? "");
  const [webhookToken, setWebhookToken] = useState(session.webhookToken ?? "");
  const [webhookTokenBusy, setWebhookTokenBusy] = useState(false);
  const [queueId, setQueueId] = useState(session.queueId ?? "");
  const [queues, setQueues] = useState<Queue[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAllowGroups(!!session.allowGroups);
    setAllowBroadcast(!!session.allowBroadcast);
    setSharedAttendance(session.sharedAttendance ?? true);
    setWebhookInboundUrl(session.webhookInboundUrl ?? "");
    setWebhookToken(session.webhookToken ?? "");
    setQueueId(session.queueId ?? "");
    void listQueues().then(setQueues).catch(() => {});
  }, [open, session]);

  const onGenerateWebhookToken = async () => {
    setWebhookTokenBusy(true);
    try {
      const tok = await regenerateWebhookToken(session.id);
      setWebhookToken(tok);
      toast.success("Token gerado. Já pode ser usado no n8n.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível gerar o token.");
    } finally {
      setWebhookTokenBusy(false);
    }
  };

  const onSave = async () => {
    setBusy(true);
    try {
      await updateSession(session.id, {
        name: session.name,
        color: session.color ?? "#57adf8",
        isDefault: !!session.isDefault,
        allowGroups,
        allowBroadcast,
        sharedAttendance,
        webhookInboundUrl,
        queueId,
        redirectMinutes: session.redirectMinutes ?? 0,
        flowId: session.flowId ?? "",
        greetingMessage: session.greetingMessage ?? "",
        completionMessage: session.completionMessage ?? "",
        outOfHoursMessage: session.outOfHoursMessage ?? "",
        surveyEnabled: !!session.surveyEnabled,
        surveyPrompt: session.surveyPrompt ?? "",
      });
      toast.success("Conexão atualizada");
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-md flex-col overflow-hidden p-0">
        <DialogHeader className="border-b bg-gradient-to-r from-primary/10 via-primary/5 to-transparent px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/15 text-primary">
              <Smartphone className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="truncate text-base">Editar conexão</DialogTitle>
              <p className="truncate text-xs text-muted-foreground">{session.jid || "Aguardando pareamento"}</p>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div>
            <Label htmlFor="cqueue">Fila vinculada</Label>
            <select
              id="cqueue"
              value={queueId}
              onChange={(e) => setQueueId(e.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">— Sem fila —</option>
              {queues.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Novas conversas são direcionadas para esta fila.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
                <Users2 className="h-4 w-4" />
              </span>
              <div>
                <div className="text-sm font-medium">Receber mensagens de grupo</div>
                <div className="text-xs text-muted-foreground">
                  Quando desativado, mensagens de grupos são ignoradas.
                </div>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={allowGroups}
              onClick={() => setAllowGroups((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
                allowGroups ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  allowGroups ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
                <Users2 className="h-4 w-4" />
              </span>
              <div>
                <div className="text-sm font-medium">Receber canais e listas de transmissão</div>
                <div className="text-xs text-muted-foreground">
                  Quando desativado, mensagens de status, newsletters e canais de venda são ignoradas.
                </div>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={allowBroadcast}
              onClick={() => setAllowBroadcast((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
                allowBroadcast ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  allowBroadcast ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
                <UsersRound className="h-4 w-4" />
              </span>
              <div>
                <div className="text-sm font-medium">Atendimento compartilhado entre agentes</div>
                <div className="text-xs text-muted-foreground">
                  Quando ativado, qualquer agente com acesso a esta conexão vê e responde conversas em atendimento,
                  não só quem clicou em "Atender". Quando desativado, cada conversa fica exclusiva de quem a assumiu.
                </div>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={sharedAttendance}
              onClick={() => setSharedAttendance((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
                sharedAttendance ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  sharedAttendance ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>

          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                <Bot className="h-4 w-4" />
              </span>
              <div className="flex-1 space-y-3">
                <div>
                  <div className="text-sm font-medium">Webhook para automação externa (n8n) — recomendado</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Caminho mais confiável que a detecção por aparelho acima: as mensagens do bot passam pelo nosso
                    próprio envio, então a métrica de "Chatbot externo" nos relatórios fica exata.
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="webhook-inbound-url" className="text-xs">
                    URL do n8n pra receber mensagens novas (webhook "de recebimento")
                  </Label>
                  <Input
                    id="webhook-inbound-url"
                    placeholder="https://seu-n8n.com/webhook/..."
                    className="h-9 text-sm"
                    value={webhookInboundUrl}
                    onChange={(e) => setWebhookInboundUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Endpoint pra o n8n mandar mensagens (webhook "de envio")</Label>
                  <div className="flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                    <span className="truncate">
                      POST {typeof window !== "undefined" ? window.location.origin : ""}/api/sessions/{session.id}/bot/send
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs shrink-0">Token de autenticação:</Label>
                    {webhookToken ? (
                      <code className="flex-1 truncate rounded-md border bg-muted/40 px-2 py-1 text-[11px]">
                        {webhookToken}
                      </code>
                    ) : (
                      <span className="text-xs text-muted-foreground">Nenhum token gerado ainda</span>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onGenerateWebhookToken}
                      disabled={webhookTokenBusy}
                    >
                      {webhookTokenBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                      {webhookToken ? "Gerar novo" : "Gerar token"}
                    </Button>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    No n8n, use o cabeçalho <code>Authorization: Bearer {"<token>"}</code>. Corpo esperado:
                    <code className="ml-1">{"{ to, text }"}</code> pra texto, ou
                    <code className="ml-1">{"{ to, mediaUrl, mediaKind, caption }"}</code> pra mídia
                    (mediaKind: image/video/audio/document). Some <code className="ml-1">replyToId</code> pra citar
                    uma mensagem.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t bg-muted/20 px-6 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Salvar alterações
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
