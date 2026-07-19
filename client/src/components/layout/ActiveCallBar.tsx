import { useMemo } from "react";
import { Phone, PhoneOff } from "lucide-react";
import { useCalls } from "@/stores/calls";
import { useEndCall } from "@/hooks/useEndCall";
import { formatPhone } from "@/lib/phone-format";

export const ActiveCallBar = () => {
  const calls = useCalls((s) => s.calls);
  const ownConnections = useCalls((s) => s.ownConnections);
  const ownSessions = useCalls((s) => s.ownSessions);
  const endCall = useEndCall();

  const activeCallId = useMemo(() => {
    const ids = Array.from(ownConnections.keys());
    return ids.length > 0 ? ids[0] : null;
  }, [ownConnections]);

  if (!activeCallId) return null;

  const sessionId = ownSessions.get(activeCallId);
  const callInfo = calls.find((c) => c.callId === activeCallId);
  const phoneLabel = callInfo ? formatPhone(callInfo.peer) || callInfo.peer : "Em chamada";

  const onHangup = () => {
    if (!sessionId) return;
    endCall.mutate({ sid: sessionId, callId: activeCallId });
  };

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-4 rounded-full bg-neutral-900 text-white shadow-2xl ring-1 ring-white/10 px-5 py-3 animate-in fade-in slide-in-from-bottom-4">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-emerald-500/20 text-emerald-400">
        <Phone className="h-4 w-4" />
      </span>
      <div className="flex flex-col">
        <span className="text-sm font-medium">{phoneLabel}</span>
        <span className="text-xs text-white/50">{callInfo?.status || "Em chamada"}</span>
      </div>
      <button
        type="button"
        aria-label="Encerrar chamada"
        onClick={onHangup}
        disabled={endCall.isPending || !sessionId}
        className="grid h-10 w-10 place-items-center rounded-full bg-red-600 hover:bg-red-500 active:scale-95 transition disabled:opacity-60"
      >
        <PhoneOff className="h-5 w-5" />
      </button>
    </div>
  );
};
