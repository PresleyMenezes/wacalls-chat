import { useEffect, useState } from "react";
import { MessageSquareText, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import {
  createQuickReply,
  deleteQuickReply,
  listQuickReplies,
  updateQuickReply,
} from "@/services/quickReplies";
import type { QuickReply } from "@/services/quickReplies";

const QuickRepliesPage = () => {
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<QuickReply | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [shortcut, setShortcut] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<QuickReply | null>(null);

  const reload = () => {
    setLoading(true);
    listQuickReplies()
      .then(setReplies)
      .catch(() => toast.error("Não foi possível carregar as respostas rápidas."))
      .finally(() => setLoading(false));
  };

  useEffect(() => { reload(); }, []);

  const openNew = () => {
    setEditing(null);
    setShortcut("");
    setText("");
    setShowForm(true);
  };

  const openEdit = (qr: QuickReply) => {
    setEditing(qr);
    setShortcut(qr.shortcut);
    setText(qr.text);
    setShowForm(true);
  };

  const onSave = async () => {
    const cleanShortcut = shortcut.trim().replace(/^\//, "");
    if (!cleanShortcut || !text.trim()) {
      toast.error("Preencha o atalho e o texto.");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateQuickReply(editing.id, cleanShortcut, text);
        toast.success("Resposta rápida atualizada.");
      } else {
        await createQuickReply(cleanShortcut, text);
        toast.success("Resposta rápida criada.");
      }
      setShowForm(false);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  const onConfirmDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteQuickReply(toDelete.id);
      toast.success("Resposta rápida removida.");
      setToDelete(null);
      reload();
    } catch {
      toast.error("Erro ao remover.");
    }
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <MessageSquareText className="h-5 w-5 text-primary" />
              Respostas rápidas
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Digite <code className="rounded bg-muted px-1 py-0.5 text-xs">/atalho</code> no
              campo de mensagem para inserir o texto rapidamente. Compartilhadas com toda a equipe.
            </p>
          </div>
          <Button onClick={openNew}>
            <Plus className="mr-1.5 h-4 w-4" />
            Nova
          </Button>
        </div>

        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Carregando...</div>
        ) : replies.length === 0 ? (
          <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
            Nenhuma resposta rápida cadastrada ainda.
          </div>
        ) : (
          <ul className="space-y-2">
            {replies.map((qr) => (
              <li
                key={qr.id}
                className="flex items-start justify-between gap-3 rounded-lg border bg-background p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-primary">/{qr.shortcut}</div>
                  <div className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                    {qr.text}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon" onClick={() => openEdit(qr)} aria-label="Editar">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setToDelete(qr)}
                    aria-label="Excluir"
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border bg-background p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">
                {editing ? "Editar resposta rápida" : "Nova resposta rápida"}
              </h2>
              <Button variant="ghost" size="icon" onClick={() => setShowForm(false)} aria-label="Fechar">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Atalho</label>
                <div className="flex items-center rounded-md border px-2">
                  <span className="text-sm text-muted-foreground">/</span>
                  <input
                    value={shortcut}
                    onChange={(e) => setShortcut(e.target.value)}
                    placeholder="boasvindas"
                    className="w-full bg-transparent px-1 py-2 text-sm outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Texto</label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={4}
                  placeholder="Olá! Seja bem-vindo(a), como posso ajudar?"
                  className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowForm(false)}>Cancelar</Button>
              <Button onClick={onSave} disabled={saving}>
                {saving ? "Salvando..." : "Salvar"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(v) => { if (!v) setToDelete(null); }}
        title="Excluir resposta rápida?"
        description={toDelete ? `O atalho /${toDelete.shortcut} será removido.` : ""}
        confirmLabel="Excluir"
        onConfirm={onConfirmDelete}
      />
    </AppShell>
  );
};

export default QuickRepliesPage;
