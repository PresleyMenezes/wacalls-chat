# ---------- Stage 1: build do frontend ----------
FROM node:22 AS frontend
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---------- Stage 2: build do backend Go ----------
FROM golang:1.26 AS backend
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GO111MODULE=on go build -o wacalls-server ./cmd/server

# ---------- Stage 3: imagem final ----------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg sqlite3 apache2-utils openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=backend /app/wacalls-server ./wacalls-server
COPY --from=frontend /app/client/dist ./dist

RUN mkdir -p /data
EXPOSE 8080

CMD ["./wacalls-server", "-addr", ":8080", "-static", "/app/dist", "-db", "/data/wacalls.db"]
