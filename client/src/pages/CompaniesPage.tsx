import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, CheckCircle2, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as authApi from "@/services/auth";
import type { CompanyRow } from "@/services/auth";
import { toastError } from "@/lib/error-toast";

type Filter = "all" | "active" | "inactive";

const fmtDate = (ts: number) =>
  ts ? new Date(ts * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

export function CompaniesPage() {
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ companyName: "", email: "", password: "" });
  const [creating, setCreating] = useState(false);

  const [toggle, setToggle] = useState<CompanyRow | null>(null);
  const [toggling, setToggling] = useState(false);

  const [toDelete, setToDelete] = useState<CompanyRow | null>(null);
  const [delPassword, setDelPassword] = useState("");
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await authApi.listCompaniesOverview());
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((c) => {
      if (filter === "active" && !c.active) return false;
      if (filter === "inactive" && c.active) return false;
      if (!term) return true;
      return c.companyName.toLowerCase().includes(term) || c.email.toLowerCase().includes(term);
    });
  }, [rows, filter, q]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      active: rows.filter((c) => c.active).length,
      inactive: rows.filter((c) => !c.active).length,
    }),
    [rows],
  );

  const submitCreate = async () => {
    if (!form.companyName.trim() || !form.email.trim() || form.password.length < 8) {
      toast.error("Preencha nome, e-mail e uma senha de pelo menos 8 caracteres.");
      return;
    }
    setCreating(true);
    try {
      await authApi.createCompany({
        companyName: form.companyName.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      toast.success("Empresa criada.");
      setCreateOpen(false);
      setForm({ companyName: "", email: "", password: "" });
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setCreating(false);
    }
  };

  const confirmToggle = async () => {
    if (!toggle) return;
    setToggling(true);
    try {
      await authApi.setCompanyActiveAdmin(toggle.id, !toggle.active);
      toast.success(toggle.active ? "Empresa desativada. Todos os usuários foram desconectados." : "Empresa reativada.");
      setToggle(null);
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setToggling(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await authApi.deleteCompanyAdmin(toDelete.id, delPassword);
      toast.success("Empresa apagada.");
      setToDelete(null);
      setDelPassword("");
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setDeleting(false);
    }
  };

  const tabs: { id: Filter; label: string }[] = [
    { id: "all", label: `Todas (${counts.all})` },
    { id: "active", label: `Ativas (${counts.active})` },
    { id: "inactive", label: `Inativas (${counts.inactive})` },
  ];

  return (
    <AppShell>
      <div className="max-w-5xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Clientes do sistema. Desativar uma empresa bloqueia o acesso de todos os usuários dela.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Atualizar
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> Nova empresa
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border p-0.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setFilter(t.id)}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  filter === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-8" placeholder="Buscar por nome ou e-mail" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Empresa</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Criada em</th>
                <th className="px-3 py-2 text-center font-medium">Usuários</th>
                <th className="px-3 py-2 text-center font-medium">Conexões</th>
                <th className="px-3 py-2 text-right font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    Nenhuma empresa encontrada.
                  </td>
                </tr>
              ) : (
                filtered.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{c.companyName || "(sem nome)"}</div>
                      <div className="text-xs text-muted-foreground">{c.email}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          c.active
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                            : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                        }`}
                      >
                        {c.active ? "Ativa" : "Inativa"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{fmtDate(c.createdAt)}</td>
                    <td className="px-3 py-2 text-center">{c.usersCount}</td>
                    <td className="px-3 py-2 text-center">{c.sessionsCount}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setToggle(c)} title={c.active ? "Desativar" : "Reativar"}>
                          {c.active ? <Ban className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setDelPassword("");
                            setToDelete(c);
                          }}
                          title="Apagar"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Nova empresa */}
      <Dialog open={createOpen} onOpenChange={(o) => !creating && setCreateOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova empresa</DialogTitle>
            <DialogDescription>Cria a empresa e o administrador principal dela.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Nome da empresa</Label>
              <Input value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>E-mail do administrador</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Senha inicial (mín. 8 caracteres)</Label>
              <Input type="text" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancelar
            </Button>
            <Button onClick={() => void submitCreate()} disabled={creating}>
              {creating && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Criar empresa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Desativar / reativar (sem senha) */}
      <ConfirmDialog
        open={!!toggle}
        onOpenChange={(o) => !o && !toggling && setToggle(null)}
        title={toggle?.active ? "Desativar empresa?" : "Reativar empresa?"}
        description={
          toggle
            ? toggle.active
              ? `${toggle.companyName || toggle.email}: todos os usuários serão desconectados e não conseguirão entrar até você reativar. Os dados são mantidos.`
              : `${toggle.companyName || toggle.email} voltará a ter acesso normalmente.`
            : undefined
        }
        confirmLabel={toggle?.active ? "Desativar" : "Reativar"}
        destructive={!!toggle?.active}
        onConfirm={() => void confirmToggle()}
      />

      {/* Apagar (exige senha) */}
      <Dialog open={!!toDelete} onOpenChange={(o) => !o && !deleting && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apagar empresa</DialogTitle>
            <DialogDescription>
              {toDelete?.companyName || toDelete?.email} será apagada com todos os usuários, conexões do WhatsApp, equipes,
              quadros e mensagens. Isso não pode ser desfeito. Se só quer bloquear o acesso, use Desativar.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label>Digite a sua senha para confirmar</Label>
            <Input
              type="password"
              autoComplete="current-password"
              value={delPassword}
              onChange={(e) => setDelPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && delPassword) void confirmDelete();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting || !delPassword}>
              {deleting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Apagar definitivamente
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
