import { useState } from "react";
import { Loader2, User as UserIcon } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as authApi from "@/services/auth";
import { useAuth } from "@/stores/auth";

const ProfilePage = () => {
  const user = useAuth((s) => s.user);
  const refresh = useAuth((s) => s.refresh);
  const [email, setEmail] = useState(user?.email ?? "");
  const [name, setName] = useState(user?.name ?? "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    if (!email.trim() || !name.trim()) {
      toast.error("Preencha email e nome.");
      return;
    }
    setSaving(true);
    try {
      await authApi.updateProfile(email.trim(), name.trim(), password.trim() || undefined);
      setPassword("");
      await refresh();
      toast.success("Perfil atualizado.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-md space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <UserIcon className="h-5 w-5 text-primary" />
            Meu perfil
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Atualize seus dados de acesso. Deixe a senha em branco para mantê-la.
          </p>
        </div>

        <div className="space-y-4 rounded-lg border p-4">
          <div>
            <Label htmlFor="profile-email">Email</Label>
            <Input
              id="profile-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="profile-name">Nome do usuário</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="profile-password">
              Senha <span className="font-normal text-muted-foreground">(opcional)</span>
            </Label>
            <Input
              id="profile-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Deixe em branco para manter"
              className="mt-1"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => void onSave()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
          </Button>
        </div>
      </div>
    </AppShell>
  );
};

export default ProfilePage;
