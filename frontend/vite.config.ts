import { defineConfig } from "vite";

// In dev, the UI runs on Vite and proxies the API to the FastAPI backend.
export default defineConfig({
  server: {
    proxy: { "/api": `http://localhost:${process.env.PORT ?? 8000}` },
  },
  build: { chunkSizeWarningLimit: 900 },
});
