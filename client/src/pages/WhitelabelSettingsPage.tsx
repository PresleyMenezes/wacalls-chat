import { useEffect, useRef, useState } from "react";
import { Loader2, Palette, Upload } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as settingsApi from "@/services/settings";
import type { Whitelabel } from "@/services/settings";
import { emitWhitelabelChanged } from "@/lib/whitelabel";

// Campos de imagem suportados pelo backend — cada um tem seu próprio
// endpoint de upload (POST /api/settings/whitelabel/asset com kind=...).
const IMAGE_FIELDS: { key: keyof Whitelabel; label: string; hint: string }[] = [
  { key: "logoLight", label: "Logo (tema claro)", hint: "Aparece no menu lateral e telas claras." },
  { key: "logoDark", label: "Logo (tema escuro)", hint: "Aparece quando o usuário está no modo escuro." },
  { key: "favicon", label: "Favicon", hint: "Ícone da aba do navegador." },
];

const WhitelabelSettingsPage = () => {
  const [wl, setWl] = useState<Whitelabel>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    void settingsApi
      .getWhitelabel()
      .then(setWl)
      .catch(() => toast.error("Não foi possível carregar a marca atual."))
      .finally(() => setLoading(false));
  }, []);

  const onUpload = async (key: keyof Whitelabel, file: File) => {
    setUploadingKey(key);
    try {
      const { url } = await settingsApi.uploadWhitelabelAsset(key, file);
      setWl((w) => ({ ...w, [key]: url }));
      toast.success("Imagem enviada. Clique em Salvar para aplicar.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao enviar imagem.");
    } finally {
      setUploadingKey(null);
    }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const saved = await settingsApi.saveWhitelabel(wl);
      setWl(saved);
      // Aplica imediatamente nesta sessão (nome, favicon, cor primária),
      // sem precisar recarregar a página.
      emitWhitelabelChanged(saved);
      toast.success("Marca do sistema atualizada.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AppShell>
        <div className="grid h-full place-items-center text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Palette className="h-5 w-5 text-primary" />
            Marca do sistema
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Nome, logo e cor exibidos em todo o sistema, inclusive na tela de login. Só o super
            administrador vê esta tela.
          </p>
        </div>

        <div className="space-y-4 rounded-lg border p-4">
          <div>
            <Label htmlFor="wl-name">Nome do sistema</Label>
            <Input
              id="wl-name"
              value={wl.appName ?? ""}
              onChange={(e) => setWl((w) => ({ ...w, appName: e.target.value }))}
              placeholder="Ex.: Send Connect"
              className="mt-1"
            />
          </div>

          {IMAGE_FIELDS.map(({ key, label, hint }) => (
            <div key={key} className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted/40">
                  {wl[key] ? (
                    <img src={wl[key]} alt={label} className="h-full w-full object-contain" />
                  ) : (
                    <Upload className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{label}</div>
                  <div className="truncate text-xs text-muted-foreground">{hint}</div>
                </div>
              </div>
              <input
                ref={(el) => { fileInputs.current[key] = el; }}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onUpload(key, file);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploadingKey === key}
                onClick={() => fileInputs.current[key]?.click()}
              >
                {uploadingKey === key ? <Loader2 className="h-4 w-4 animate-spin" /> : "Trocar"}
              </Button>
            </div>
          ))}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="wl-primary-light">Cor primária (tema claro)</Label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  id="wl-primary-light"
                  type="color"
                  value={wl.primaryLight || "#22c55e"}
                  onChange={(e) => setWl((w) => ({ ...w, primaryLight: e.target.value }))}
                  className="h-9 w-12 cursor-pointer rounded border bg-transparent"
                />
                <Input
                  value={wl.primaryLight ?? ""}
                  onChange={(e) => setWl((w) => ({ ...w, primaryLight: e.target.value }))}
                  placeholder="#22c55e"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="wl-primary-dark">Cor primária (tema escuro)</Label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  id="wl-primary-dark"
                  type="color"
                  value={wl.primaryDark || "#22c55e"}
                  onChange={(e) => setWl((w) => ({ ...w, primaryDark: e.target.value }))}
                  className="h-9 w-12 cursor-pointer rounded border bg-transparent"
                />
                <Input
                  value={wl.primaryDark ?? ""}
                  onChange={(e) => setWl((w) => ({ ...w, primaryDark: e.target.value }))}
                  placeholder="#22c55e"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => void onSave()} disabled={saving}>
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </div>
    </AppShell>
  );
};

export default WhitelabelSettingsPage;
