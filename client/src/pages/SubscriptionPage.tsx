import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CreditCard, Gift, Loader2, RefreshCw } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import * as authApi from "@/services/auth";
import type { MySubscription } from "@/services/auth";
import { toastError } from "@/lib/error-toast";

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDate = (ts: number) => (ts ? new Date(ts * 1000).toLocaleDateString("pt-BR") : "—");

export function SubscriptionPage() {
  const [sub, setSub] = useState<MySubscription | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setSub(await authApi.getMySubscription());
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  let banner: { tone: "ok" | "warn" | "bad" | "info"; icon: typeof CheckCircle2; title: string; text: string } | null = null;
  if (sub) {
    if (sub.courtesy) {
      banner = { tone: "info", icon: Gift, title: "Cortesia", text: "Sua empresa tem acesso liberado, sem cobrança." };
    } else if (sub.status === "active") {
      banner = { tone: "ok", icon: CheckCircle2, title: "Assinatura em dia", text: sub.nextDue ? `Próxima cobrança em ${fmtDate(sub.nextDue)}.` : "Tudo certo com o seu pagamento." };
    } else if (sub.status === "pending") {
      banner = { tone: "warn", icon: AlertTriangle, title: "Aguardando pagamento", text: "Conclua o cadastro do cartão para ativar a assinatura." };
    } else if (sub.status === "overdue") {
      banner = {
        tone: "warn",
        icon: AlertTriangle,
        title: "Pagamento em atraso",
        text: `Seu acesso continua liberado por mais ${sub.graceDaysLeft ?? 0} dia(s). Depois disso a conta será suspensa. Regularize o pagamento.`,
      };
    } else if (sub.status === "suspended" || sub.status === "canceled") {
      banner = { tone: "bad", icon: AlertTriangle, title: sub.status === "canceled" ? "Assinatura cancelada" : "Conta suspensa", text: "Regularize o pagamento para voltar a usar o sistema." };
    } else {
      banner = { tone: "info", icon: CreditCard, title: "Sem assinatura", text: "Nenhuma assinatura ativa. Fale com o suporte para contratar um plano." };
    }
  }

  const tones = {
    ok: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    warn: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
    bad: "border-red-300 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
    info: "border-violet-300 bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  };

  const needsPay = !!sub && !sub.courtesy && !!sub.initPoint && ["pending", "overdue", "suspended"].includes(sub.status);

  return (
    <AppShell>
      <div className="max-w-2xl space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Status do plano e do pagamento da sua empresa.</p>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Atualizar
          </Button>
        </div>

        {loading && !sub && <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />}

        {banner && (
          <div className={`flex gap-3 rounded-lg border p-4 ${tones[banner.tone]}`}>
            <banner.icon className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <div className="font-semibold">{banner.title}</div>
              <div className="text-sm">{banner.text}</div>
            </div>
          </div>
        )}

        {sub && !sub.courtesy && sub.plan && (
          <div className="grid grid-cols-2 gap-3 rounded-lg border p-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Plano</div>
              <div className="font-medium">{sub.plan.name}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Valor mensal</div>
              <div className="font-medium">{money(sub.plan.priceCents)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Usuários</div>
              <div className="font-medium">
                {sub.usersCount ?? 0} de {sub.plan.maxUsers}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Próxima cobrança</div>
              <div className="font-medium">{fmtDate(sub.nextDue)}</div>
            </div>
          </div>
        )}

        {needsPay && (
          <Button asChild size="lg">
            <a href={sub!.initPoint} target="_blank" rel="noreferrer">
              <CreditCard className="mr-2 h-4 w-4" />
              {sub!.status === "pending" ? "Cadastrar cartão e ativar" : "Regularizar pagamento"}
            </a>
          </Button>
        )}
      </div>
    </AppShell>
  );
}
