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
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true, ws: false },
    },
  },
});
