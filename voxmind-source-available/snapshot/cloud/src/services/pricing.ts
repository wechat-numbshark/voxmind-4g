import type { Repository } from "../store/repository.js";

/* 单价表。阿里云会调价，所以放在库里、管理员后台可改；这里只是出厂默认值。
 * 每条都标了来源是否核实过——没核实的请以百炼控制台「费用中心」的账单为准，改掉它。*/
export interface ModelPrice {
  label: string;
  /** 语音识别：每秒音频多少元 */
  perSecond?: number;
  /** 大模型：每百万 token 多少元 */
  inputPerM?: number;
  outputPerM?: number;
  source: string;
  verified: boolean;
}

export interface PriceBook {
  models: Record<string, ModelPrice>;
  /** 服务器月费（元），按天摊进成本 */
  serverMonthly: number;
}

export const DEFAULT_PRICES: PriceBook = {
  serverMonthly: 0,
  models: {
    "qwen3-asr-flash": { label: "千问3 语音识别", perSecond: 0.00024, source: "按国际价 $0.000035/秒折算", verified: false },
    "fun-asr-realtime": { label: "Fun-ASR 实时识别", perSecond: 0.00033, source: "第三方整理页", verified: false },
    "paraformer-realtime-v2": { label: "Paraformer 实时识别", perSecond: 0.00008, source: "第三方整理页", verified: false },
    "sensevoice-local": { label: "本地 SenseVoice", perSecond: 0, source: "自己的服务器，只算月费", verified: true },
    "qwen3.8-flash": { label: "千问 3.8 Flash", inputPerM: 0.8, outputPerM: 2.7, source: "阿里云官方价格页 2026-09-19", verified: true },
    "text-embedding-v4": { label: "千问文本向量", inputPerM: 0.5, source: "第三方整理，待核实", verified: false },
    "qwen-flash": { label: "千问 Flash", inputPerM: 0.15, outputPerM: 1.5, source: "阿里云官方价格页 2026-09-19（0–128K 档）", verified: true },
  },
};

const KEY = "prices";

export class PricingService {
  private cache: { book: PriceBook; at: number } | null = null;
  constructor(private readonly repository: Repository) {}

  async book(): Promise<PriceBook> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.book;
    const stored = await this.repository.getConfig<Partial<PriceBook>>(KEY);
    const book: PriceBook = {
      serverMonthly: stored?.serverMonthly ?? DEFAULT_PRICES.serverMonthly,
      models: { ...DEFAULT_PRICES.models, ...(stored?.models ?? {}) },
    };
    this.cache = { book, at: Date.now() };
    return book;
  }

  async save(book: PriceBook) {
    await this.repository.putConfig(KEY, book);
    this.cache = null;
  }

  /** 查不到单价时记 0 并照样记用量——之后补上单价，用量还在，成本可以重算 */
  async asrCost(model: string, audioMs: number) {
    const p = (await this.book()).models[model];
    return (p?.perSecond ?? 0) * (audioMs / 1000);
  }
  async llmCost(model: string, inputTokens: number, outputTokens: number) {
    const p = (await this.book()).models[model];
    return ((p?.inputPerM ?? 0) * inputTokens + (p?.outputPerM ?? 0) * outputTokens) / 1_000_000;
  }
}
