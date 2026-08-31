import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // Temporário: liga sourcemaps no build de produção pra conseguir ler o
    // erro real (arquivo/linha de verdade) no DevTools, em vez de nomes
    // minificados tipo "pl" ou "mne" — depois que acharmos e corrigirmos o
    // bug, pode voltar pra false (arquivos ficam menores sem os mapas).
    sourcemap: true,
  },
  esbuild: {
    // O erro "Cannot access 'X' before initialization" apontou pra uma
    // linha cujas variáveis já estavam todas declaradas corretamente antes
    // dela no código-fonte — sinal de que o problema é o próprio
    // minificador reaproveitando um nome curto (tipo "pl") pra duas
    // variáveis diferentes por engano, um bug raro de minificação, não do
    // nosso código. Desligar só a compactação de NOMES (mantendo o resto
    // da minificação) evita essa classe de bug, trocando um bundle
    // levemente maior por correção garantida.
    minifyIdentifiers: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true, ws: false },
    },
  },
});
