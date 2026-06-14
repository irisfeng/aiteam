import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // 整合到统一 Web App 后，AiTeam 前端整体挂载在 /aiteam/ 子路径下
  base: "/aiteam/",
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/aiteam/api": "http://localhost:8787",
      "/aiteam/assets": "http://localhost:8787",
      "/aiteam/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
