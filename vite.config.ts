import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "web",
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, "")
      },
      "/healthz": "http://localhost:3000"
    }
  }
});
