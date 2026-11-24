/* 语义检索用的向量。
 *
 * 为什么要它：现在的搜索是逐字匹配，说法一变就搜不到——「合同签了吗」搜不到
 * 「那个协议对方回了没」。把每句话变成一串数字（向量），意思相近的向量也相近，
 * 就能按意思找。文字比图像视频简单得多：转写已经是文字，直接算向量即可。
 *
 * 向量在这里就归一化（长度变成 1），检索时余弦相似度退化成点积，
 * 数据库里少一半计算。*/

export interface EmbeddingResult {
  vectors: number[][];
  inputTokens: number;
  model: string;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export function normalize(vector: number[]) {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const len = Math.sqrt(sum) || 1;
  return vector.map((v) => v / len);
}

export class DisabledEmbeddingProvider implements EmbeddingProvider {
  readonly name = "disabled";
  readonly model = "";
  readonly dimensions = 0;
  async embed(): Promise<EmbeddingResult> { return { vectors: [], inputTokens: 0, model: "" }; }
}

/** 百炼 /embeddings 的批量上限，超了会整批报 InvalidParameter */
const MAX_BATCH = 10;

/** 阿里云百炼的嵌入模型，走 OpenAI 兼容接口，和转写/意图共用同一把 Key。 */
export class DashScopeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "dashscope";
  constructor(private readonly options: { apiKey: string; baseUrl: string; model: string; dimensions: number; fetchImpl?: typeof fetch }) {}
  get model() { return this.options.model; }
  get dimensions() { return this.options.dimensions; }

  /** 百炼一次最多收 10 条，多了整批 400，所以在这里切好再发。 */
  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (!texts.length) return { vectors: [], inputTokens: 0, model: this.model };
    if (texts.length > MAX_BATCH) {
      const vectors: number[][] = [];
      let inputTokens = 0;
      for (let i = 0; i < texts.length; i += MAX_BATCH) {
        const part = await this.embed(texts.slice(i, i + MAX_BATCH));
        vectors.push(...part.vectors);
        inputTokens += part.inputTokens;
      }
      return { vectors, inputTokens, model: this.model };
    }
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: this.options.dimensions, encoding_format: "float" }),
    });
    const body = await response.json() as { data?: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number; prompt_tokens?: number }; error?: { message?: string } };
    if (!response.ok || !body.data) throw new Error(`嵌入模型请求失败: ${body.error?.message ?? response.status}`);
    const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
    return { vectors, inputTokens: body.usage?.total_tokens ?? body.usage?.prompt_tokens ?? 0, model: this.model };
  }
}
