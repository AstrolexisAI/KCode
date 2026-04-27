// Vite configuration for KCode Web UI
// Build: bun run build:web (outputs to src/web/dist/)
// Dev:   bun run dev:web (hot-reload on localhost:10101)

import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "client"),
  base: "/",

  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    rollupOptions: {
      input: resolve(__dirname, "client/index.html"),
    },
  },

  server: {
    port: 10101,
    proxy: {
      // Proxy API and WebSocket to the KCode web server
      "/api": {
        target: "http://localhost:10101",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:10101",
        ws: true,
      },
    },
  },
});
