#!/bin/bash
set -e

DB="/data/wacalls.db"
EMAIL="${WACALLS_ADMIN_EMAIL:-wacalls@admin.com}"
SENHA="${WACALLS_ADMIN_PASSWORD:-admin}"

# Inicia o servidor em background
./wacalls-server -addr :8080 -static /app/dist -db "$DB" &
SERVER_PID=$!

# Aguarda o banco ser criado pelo backend (até 30s)
i=0
while [ ! -f "$DB" ] && [ $i -lt 30 ]; do
  sleep 1
  i=$((i+1))
done

if [ -f "$DB" ]; then
  # Só semeia o admin se ainda não existir NENHUM usuário —
  # evita resetar senha já trocada pelo usuário em restarts futuros.
  COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")
  if [ "$COUNT" = "0" ]; then
    echo "Nenhum usuário encontrado — criando admin padrão..."
    HASH=$(htpasswd -nbBC 12 "" "$SENHA" 2>/dev/null | tr -d ':\n' | sed 's|^\$2y\$|\$2a\$|')
    ID=$(openssl rand -hex 16)
    NOW=$(($(date +%s) * 1000))
    sqlite3 "$DB" <<SQL
INSERT INTO users (id, email, password_hash, created_at, company_name, cpf, active, display_name)
VALUES ('$ID', '$EMAIL', '$HASH', $NOW, 'WaCalls', '', 1, 'Administrador');
INSERT OR IGNORE INTO user_roles (user_id, role)
SELECT id, 'admin' FROM users WHERE email='$EMAIL';
SQL
    echo "Admin criado: $EMAIL / (senha definida)"
  else
    echo "Usuários já existem ($COUNT) — pulando seed do admin."
  fi
fi

wait $SERVER_PID
