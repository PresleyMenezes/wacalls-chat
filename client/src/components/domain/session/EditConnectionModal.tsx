import { useEffect, useState } from "react";
import { Loader2, Smartphone, Users2, UsersRound, Bot } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { updateSession, fetchLinkedDevices } from "@/services/sessions";
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
  // 0 = não configurado. Descoberto pelo botão "Buscar dispositivos
  // vinculados" logo abaixo.
  const [externalBotDevice, setExternalBotDevice] = useState(session.externalBotDevice ?? 0);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [linkedDevices, setLinkedDevices] = useState<number[] | null>(null);
  const [queueId, setQueueId] = useState(session.queueId ?? "");
  const [queues, setQueues] = useState<Queue[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAllowGroups(!!session.allowGroups);
    setAllowBroadcast(!!session.allowBroadcast);
    setSharedAttendance(session.sharedAttendance ?? true);
    setExternalBotDevice(session.externalBotDevice ?? 0);
    setQueueId(session.queueId ?? "");
    void listQueues().then(setQueues).catch(() => {});
  }, [open, session]);

  const onSearchDevices = async () => {
    setDevicesLoading(true);
    try {
      const res = await fetchLinkedDevices(session.id);
      setLinkedDevices(res.devices);
      if (res.devices.length === 0) {
        toast.info("Nenhum outro aparelho vinculado encontrado neste número.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível buscar os dispositivos vinculados.");
    } finally {
      setDevicesLoading(false);
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
        externalBotDevice,
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
      <DialogContent className="max-w-md overflow-hidden p-0">
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

        <div className="space-y-5 px-6 py-5">
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
              <div className="flex-1">
                <div className="text-sm font-medium">Chatbot externo nesta conexão (opcional)</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Se este número de WhatsApp também tiver um bot externo pareado (ex.: GOWA/n8n), busque abaixo os
                  aparelhos vinculados e escolha qual é o do bot. O WhatsApp não manda um nome pra cada aparelho — só
                  o número —, então na primeira vez pode ser preciso testar (mandar uma mensagem pelo bot e ver qual
                  número aparece como "usado recentemente" antes de escolher).
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={onSearchDevices} disabled={devicesLoading}>
                    {devicesLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    Buscar dispositivos vinculados
                  </Button>
                </div>
                {linkedDevices !== null && linkedDevices.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {linkedDevices.map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setExternalBotDevice(d)}
                        className={`rounded-full border px-3 py-1 text-xs transition ${
                          externalBotDevice === d ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted"
                        }`}
                      >
                        Aparelho {d}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <Label htmlFor="external-bot-device" className="text-xs">Ou digite o número direto:</Label>
                  <Input
                    id="external-bot-device"
                    type="number"
                    min={0}
                    className="h-8 w-24"
                    value={externalBotDevice}
                    onChange={(e) => setExternalBotDevice(Math.max(0, Number(e.target.value) || 0))}
                  />
                  <span className="text-xs text-muted-foreground">(0 = desligado)</span>
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
