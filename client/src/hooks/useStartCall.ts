import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { openCall } from "@/lib/webrtc";
import { startCall, endCall } from "@/services/calls";
import { registerOwnConnection, waitForPendingClose } from "@/stores/calls";

export const useStartCall = (sid: string, micId: string | null, outId?: string | null) =>
  useMutation({
    mutationFn: async (vars: { phone: string; record: boolean; video: boolean }) => {
      // Espera a limpeza de áudio/WebRTC de uma chamada anterior NESSA
      // MESMA conexão terminar de verdade (se ainda estiver em andamento)
      // antes de tentar pegar o microfone de novo — desligar e discar de
      // novo rapidamente podia deixar a chamada nova muda dos dois lados.
      await waitForPendingClose(sid);
      // Testa o microfone ANTES de discar de verdade — sem isso, o pedido
      // de chamada já saía pro WhatsApp (o telefone da outra pessoa
      // chegava a tocar) e só depois a gente descobria que faltava
      // microfone, deixando a chamada real pendurada sem ninguém do nosso
      // lado conseguindo ouvir/atender/desligar.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({
          audio: micId ? { deviceId: { exact: micId } } : true,
        });
        probe.getTracks().forEach((t) => t.stop());
      } catch {
        throw new Error("Nenhum microfone encontrado. Verifique se há um microfone conectado e permitido no navegador.");
      }
      const { call } = await startCall(sid, vars.phone, vars.record, vars.video);
      try {
        const conn = await openCall(sid, call.callId, micId, { video: vars.video, outputDeviceId: outId });
        registerOwnConnection(call.callId, conn, sid);
      } catch (wrtcErr) {
        // Segurança extra: se o microfone falhar aqui mesmo depois do teste
        // acima (ex.: dispositivo desconectado nesse meio-tempo), encerra a
        // chamada que já tínhamos iniciado no WhatsApp, em vez de deixá-la
        // pendurada sem ninguém do nosso lado conseguindo controlá-la.
        try {
          await endCall(sid, call.callId);
        } catch {
          /* ignore */
        }
        throw wrtcErr;
      }
      return call.callId;
    },
    onError: (e: Error) => {
      const m = e.message;
      if (m.includes("429")) toast.error("Limit reached: max concurrent calls.");
      else if (m.includes("503")) toast.error("WhatsApp not paired.");
      else toast.error(m);
    },
  });
