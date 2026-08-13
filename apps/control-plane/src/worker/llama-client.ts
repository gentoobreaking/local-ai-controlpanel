// llama.cpp OpenAI-compatible client（§16）。
// 只做「把 request 送到本地 llama-server endpoint」的最小職責：
// POST {baseUrl}/v1/chat/completions，stream=false，拿 completion text。
// 不做 retry / fallback / 複雜 prompt 工程——那是 Control Plane 的職責。

export interface LlamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlamaChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 外部注入的 timeout（ms）。 */
  timeoutMs?: number;
}

export interface LlamaChatResult {
  text: string;
  /** completion tokens（模型回傳或估算）。 */
  usage?: { promptTokens: number; completionTokens: number };
}

/** llama.cpp OpenAI-compatible server 連線錯誤。 */
export class LlamaConnectionError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LlamaConnectionError";
  }
}

export interface LlamaClientConfig {
  baseUrl: string;
  model: string;
  /** 預設 request timeout（ms）。 */
  timeoutMs?: number;
  /** endpoint 探測（ping）超時（ms），預設 3000。 */
  pingTimeoutMs?: number;
}

/**
 * 極簡 OpenAI-compatible chat completions client。
 * 用原生 fetch（Node 18+），零依賴；串接 llama-server 的 /v1 端點。
 * interrupt() 會 abort 進行中的 request（§15 CodingWorker.interrupt）。
 */
export class LlamaClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly timeoutMs: number;
  private readonly pingTimeoutMs: number;
  private controller: AbortController | null = null;

  constructor(config: LlamaClientConfig) {
    // 去掉尾部斜線，避免 //v1
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.pingTimeoutMs = config.pingTimeoutMs ?? 3_000;
  }

  get endpoint(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  /** 檢查 endpoint 是否可達（llama-server 的 /health 或根路徑）。 */
  async ping(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    const signal = AbortSignal.timeout(this.pingTimeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal });
      const detail = (await res.text()).slice(0, 200);
      return { ok: res.ok, latencyMs: Date.now() - started, detail };
    } catch {
      // llama-server 無 /health 時退回根路徑
      try {
        const res = await fetch(`${this.baseUrl}/`, { signal });
        return { ok: res.ok, latencyMs: Date.now() - started };
      } catch {
        return { ok: false, latencyMs: Date.now() - started };
      }
    }
  }

  /** 中斷進行中的 request（配合 CodingWorker.interrupt，§15）。 */
  interrupt(): void {
    this.controller?.abort();
  }

  async chat(
    messages: LlamaChatMessage[],
    opts: LlamaChatOptions = {},
  ): Promise<LlamaChatResult> {
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 4096,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 500);
        throw new LlamaConnectionError(`llama-server HTTP ${res.status}: ${body}`, res.status);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      return {
        text,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
        },
      };
    } catch (err) {
      const e = err as Error;
      if (e.name === "AbortError") {
        throw new LlamaConnectionError(
          this.interrupted ? "request aborted by interrupt()" : `llama-server timeout after ${opts.timeoutMs ?? this.timeoutMs}ms`,
        );
      }
      throw new LlamaConnectionError(`llama-server unreachable at ${this.endpoint}: ${e.message}`);
    } finally {
      clearTimeout(timer);
      this.controller = null;
    }
  }

  private get interrupted(): boolean {
    return this.controller?.signal.aborted === true;
  }
}
