import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { clearAuthClientState, useAuth } from "@/stores/auth";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

// Conexão SSE de invalidação de sessão — feita UMA ÚNICA VEZ pra vida toda
// da aba do navegador, não uma por página. RequireAuth remonta a cada troca
// de menu (cada página tem seu próprio <RequireAuth>), então se essa
// conexão fosse aberta/fechada dentro do componente, trocar de página
// repetidamente rapidamente abria várias conexões antes da anterior
// terminar de fechar — estourando o limite de conexões simultâneas do
// navegador por site (~6 em HTTP/1.1) e travando o carregamento de tudo,
// inclusive a própria página nova.
let authStreamStarted = false;
function ensureAuthStreamConnected(onInvalidated: () => void) {
  if (authStreamStarted) return;
  authStreamStarted = true;
  window.addEventListener("auth:invalidated", onInvalidated);
  const es = new EventSource("/api/auth/stream", { withCredentials: true });
  es.addEventListener("revoked", () => {
    onInvalidated();
  });
  es.onerror = () => {
    // O navegador reconecta sozinho; nada a fazer aqui.
  };
}

export const RequireAuth = ({ children, adminOnly = false, superAdminOnly = false }: { children: ReactNode; adminOnly?: boolean; superAdminOnly?: boolean }) => {
  const user = useAuth((s) => s.user);
  const loading = useAuth((s) => s.loading);
  const refresh = useAuth((s) => s.refresh);
  const loc = useLocation();
  const nav = useNavigate();

  useEffect(() => {
    if (loading) void refresh();
  }, [loading, refresh]);

  // Política de sessão única: se outro navegador fizer login com o mesmo
  // usuário, o backend revoga o token atual — recebido em tempo real pela
  // conexão SSE (aberta uma única vez, ver ensureAuthStreamConnected acima).
  useEffect(() => {
    if (!user) return;
    ensureAuthStreamConnected(() => {
      toast.error("Sua sessão foi encerrada porque você entrou em outro navegador.");
      clearAuthClientState();
      useAuth.setState({ user: null });
      nav("/login", { replace: true });
    });
  }, [user, nav]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  if (adminOnly && !user.roles.includes("admin")) {
    return <Navigate to="/" replace />;
  }
  if (superAdminOnly && !user.isSuperAdmin) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
};
