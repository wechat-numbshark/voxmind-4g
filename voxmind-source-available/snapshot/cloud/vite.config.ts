import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/* 前端和后端在同一个 package 里：Docker 只跑一次 npm ci，也保证网页引用的
 * 类型和服务端的 zod schema 永远是同一份（web/src 里用 import type 引
 * ../../src/domain.js，编译期就能发现字段对不上）。*/
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    /* 开发时前端在 5173、接口在 8080。同源代理，cookie 才带得过去。*/
    proxy: { "/v1": { target: "http://127.0.0.1:8080", changeOrigin: false } },
  },
});
