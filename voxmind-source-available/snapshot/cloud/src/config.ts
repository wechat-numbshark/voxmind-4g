import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().default("postgres://voxmind:voxmind@127.0.0.1:5432/voxmind"),
  AUDIO_STORAGE_DIR: z.string().default("./data/audio"),
  DEVICE_API_KEY: z.string().min(16).default("dev-device-key-change-me"),
  ADMIN_API_KEY: z.string().min(16).default("dev-admin-key-change-me"),
  TOKEN_ENCRYPTION_KEY: z.string().min(24).default("dev-token-encryption-key-change-me"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  /* 库里一个账号都没有时自动建的第一个管理员。不填密码就随机生成一个，
   * 只在服务器日志里出现一次——所以首次部署后要马上去看日志并改掉。*/
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().default("owner@voxmind.local"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().default(""),
  /* 会话 cookie 带不带 Secure。留空则按环境推断，见下面的 cookieSecure */
  COOKIE_SECURE: z.string().default(""),
  PROCESSING_ENABLED: z.string().default("true").transform((v) => v !== "false"),
  PROCESSING_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2000),
  ASR_PROVIDER: z.enum(["disabled", "mock", "aliyun", "dashscope"]).default("disabled"),
  DASHSCOPE_API_KEY: z.string().default(""),
  DASHSCOPE_BASE_URL: z.string().url().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  ASR_MODEL: z.string().default("qwen3-asr-flash"),
  /* 两档。用户没设置时用 DEFAULT_TIER。
   * 经济档识别：same＝和高质量档同一个云端引擎（迁移服务器之前）；sensevoice＝本地（迁移之后）；
   * funasr / paraformer＝百炼实时识别（协议已实测可用，但据查不比 qwen3-asr-flash 便宜）。*/
  DEFAULT_TIER: z.enum(["high", "economy"]).default("high"),
  ECONOMY_ASR: z.enum(["same", "sensevoice", "funasr", "paraformer"]).default("same"),
  SENSEVOICE_URL: z.string().default(""),
  ECONOMY_LLM_MODEL: z.string().default("qwen-flash"),
  /* 聊天要会调工具，可能需要比抽意图更强的模型。留空＝跟档位走（高质量档用 LLM_MODEL） */
  CHAT_MODEL: z.string().default(""),
  /* 语义检索的向量。512 维足够中文短句检索，比默认 1024 维省一半存储和计算 */
  EMBEDDING_PROVIDER: z.enum(["disabled", "dashscope"]).default("dashscope"),
  EMBEDDING_MODEL: z.string().default("text-embedding-v4"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(2048).default(512),
  ASR_APP_KEY: z.string().default(""),
  ASR_ACCESS_KEY_ID: z.string().default(""),
  ASR_ACCESS_KEY_SECRET: z.string().default(""),
  ASR_GATEWAY: z.string().url().default("wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1"),
  LLM_PROVIDER: z.enum(["disabled", "anthropic", "openai-compatible"]).default("disabled"),
  LLM_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),
  EXECUTION_MODE: z.enum(["mock", "live"]).default("mock"),
  LARK_APP_ID: z.string().default(""),
  LARK_APP_SECRET: z.string().default(""),
  LARK_OWNER_OPEN_ID: z.string().default(""),
  WEBHOOK_ALLOWED_ORIGINS: z.string().default(""),
  HOME_ASSISTANT_URL: z.string().default(""),
  HOME_ASSISTANT_TOKEN: z.string().default(""),
  EVA_BASE_URL: z.string().default(""),
  EVA_API_KEY: z.string().default(""),
  EVA_SITE_ID: z.string().default("farm-main"),
  EVA_EXECUTION_MODE: z.enum(["inherit", "mock", "live"]).default("inherit"),
  /** 给意图模型看的非敏感设备别名和已登记命令；不放令牌、地址等秘密。 */
  EVA_DEVICE_HINTS: z.string().default(""),
});

/** cookieSecure 是推导出来的：生产走 HTTPS 必须带 Secure，本地 http 调试
 *  不能带，否则浏览器会直接丢掉登录 cookie，表现成"登录了但一刷新就掉"。*/
export type AppConfig = z.infer<typeof ConfigSchema> & { cookieSecure: boolean };

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.parse(source);
  const cookieSecure = parsed.COOKIE_SECURE === ""
    ? parsed.NODE_ENV === "production"
    : parsed.COOKIE_SECURE !== "false";
  if (parsed.NODE_ENV === "production") {
    const unsafe = [
      parsed.DEVICE_API_KEY === "dev-device-key-change-me" ? "DEVICE_API_KEY" : "",
      parsed.ADMIN_API_KEY === "dev-admin-key-change-me" ? "ADMIN_API_KEY" : "",
      parsed.TOKEN_ENCRYPTION_KEY === "dev-token-encryption-key-change-me" ? "TOKEN_ENCRYPTION_KEY" : "",
    ].filter(Boolean);
    if (unsafe.length) throw new Error(`生产环境必须设置安全密钥：${unsafe.join(", ")}`);
    if (parsed.ASR_PROVIDER === "dashscope" && !parsed.DASHSCOPE_API_KEY) {
      throw new Error("DashScope 语音识别需要 DASHSCOPE_API_KEY");
    }
    if (parsed.PROCESSING_ENABLED && parsed.ASR_PROVIDER === "aliyun" &&
      (!parsed.ASR_APP_KEY || !parsed.ASR_ACCESS_KEY_ID || !parsed.ASR_ACCESS_KEY_SECRET)) {
      throw new Error("阿里云 ASR 需要 ASR_APP_KEY、ASR_ACCESS_KEY_ID 和 ASR_ACCESS_KEY_SECRET");
    }
    if (parsed.LLM_PROVIDER === "openai-compatible" && (!parsed.LLM_API_KEY || !parsed.LLM_MODEL)) {
      throw new Error("OpenAI 兼容模型需要 LLM_API_KEY 和 LLM_MODEL");
    }
    if (parsed.LLM_PROVIDER === "anthropic" && !parsed.ANTHROPIC_API_KEY) {
      throw new Error("Anthropic 模型需要 ANTHROPIC_API_KEY");
    }
  }
  return { ...parsed, cookieSecure };
}
