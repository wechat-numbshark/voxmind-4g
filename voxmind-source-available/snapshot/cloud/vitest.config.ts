import { defineConfig } from "vitest/config";

/* 单独一份：vite.config.ts 的 root 是 web/，vitest 会跟着去 web/ 下找测试 */
export default defineConfig({
  test: { root: ".", include: ["test/**/*.test.ts"] },
});
