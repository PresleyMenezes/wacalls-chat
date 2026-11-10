# ---------- Stage 1: build do frontend ----------
FROM node:22 AS frontend
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build && \
    if [ ! -f /app/client/dist/index.html ]; then \
        echo "dist não encontrado em client/dist, procurando..." && \
        FOUND=$(find /app -maxdepth 3 -name "index.html" -path "*dist*" 2>/dev/null | head -n1) && \
        if [ -n "$FOUND" ]; then \
            echo "Encontrado em: $FOUND" && \
            mkdir -p /app/client/dist && \
            cp -r "$(dirname "$FOUND")"/. /app/client/dist/; \
        else \
            echo "ERRO: build não encontrado em nenhum lugar" && exit 1; \
        fi; \
    fi

# ---------- Stage 2: build do backend Go (com áudio nativo) ----------
FROM golang:1.26 AS backend
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libc6-dev pkg-config libopus-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Atualiza a biblioteca do WhatsApp para uma versão que CONFIRMA ("ack") os pacotes
# <status> que o WhatsApp passou a enviar. A versão fixada em go.mod (jun/2026) os
# ignora, e o servidor então para de entregar as mensagens. Fixa num commit exato.
RUN go get go.mau.fi/whatsmeow@d7b3e155697bd785cce4e7d5cc8e3a8ea64c198c && go mod download
RUN CGO_ENABLED=1 GO111MODULE=on go build -tags mlow -o wacalls-server ./cmd/server

# ---------- Stage 3: imagem final ----------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg sqlite3 apache2-utils openssl libopus0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /app/wacalls-server ./wacalls-server
COPY --from=frontend /app/client/dist ./dist
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh && mkdir -p /data
EXPOSE 8080
ENTRYPOINT ["./entrypoint.sh"]
