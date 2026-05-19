import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_BASE_URL || "http://localhost:4000";

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true
        },
        "/proxy": {
          target: apiTarget,
          changeOrigin: true
        },
        "/stream": {
          target: apiTarget,
          changeOrigin: true
        },
        "/m3u": {
          target: apiTarget,
          changeOrigin: true
        },
        "/health": {
          target: apiTarget,
          changeOrigin: true
        }
      }
    },
    preview: {
      host: true,
      port: 4173
    }
  };
});
