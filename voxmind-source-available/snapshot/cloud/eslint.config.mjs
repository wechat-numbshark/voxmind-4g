import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/* 只查 React Hook 的调用规则，别的风格问题不管。
 *
 * 为什么单独上这一条：类型检查和测试都抓不住"Hook 写在了提前 return 后面"，
 * 它只会在浏览器里第二次渲染时直接崩、整页白屏（2026-10-01「我的」页面就是这么上线的）。
 * 登记 typescript-eslint 插件只是为了让代码里已有的 eslint-disable 注释能认出规则名，不启用它的规则。*/
export default [
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "react-hooks": reactHooks, "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
