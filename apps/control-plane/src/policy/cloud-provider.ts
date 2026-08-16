// Cloud Provider 介面與實作（Spec §25 Phase 9）。
// 統一呼叫 Anthropic / OpenAI / Gemini 等雲端 LLM 供應商。

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  usage?: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
}

interface OpenAIResponse {
  choices: Array<{ message: { content: string }; finish_reason: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface GeminiResponse {
  candidates?: Array<{ content: { parts: Array<{ text: string }> }; finish_reason: string }>;
  usage_metadata?: { prompt_token_count: number; candidates_token_count: number };
}

export interface CloudProviderConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}
  export interface CloudChatRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model: string;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

export type CloudProviderType = "anthropic" | "openai" | "gemini";

export interface CloudChatResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
  raw?: unknown;
}

export interface CloudProvider {
  readonly type: CloudProviderType;
  readonly defaultModel: string;
  chat(request: CloudChatRequest): Promise<CloudChatResponse>;
  estimateCost(inputTokens: number, outputTokens: number): number;
  isAvailable(): Promise<boolean>;
}

/** Anthropic Claude Provider */
export class AnthropicProvider implements CloudProvider {
  readonly type: CloudProviderType = "anthropic";
  readonly defaultModel = "claude-3.5-sonnet-20241022";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: CloudProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async chat(request: CloudChatRequest): Promise<CloudChatResponse> {
    const messages = request.messages.map((m) => ({
      role: m.role === "system" ? "user" : m.role,
      content: m.content,
    }));

    const body = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages,
      temperature: request.temperature ?? 0.2,
      top_p: request.topP,
      stop_sequences: request.stopSequences,
    };

    const res = (await this.post("/v1/messages", body)) as AnthropicResponse;
    const text = res.content?.[0]?.text ?? "";
    return {
      text,
      usage: res.usage
        ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
        : undefined,
      finishReason: res.stop_reason,
      raw: res,
    };
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    // 近似成本：Claude 3.5 Sonnet $3/M input, $15/M output
    return (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { "x-api-key": this.apiKey },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let lastError: Error | null = null;
    for (let i = 0; i <= (this.maxRetries ?? 3); i++) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Anthropic API ${res.status}: ${errText}`);
        }
        return await res.json();
      } catch (e) {
        lastError = e as Error;
        if (i < (this.maxRetries ?? 3)) {
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      }
    }
    throw lastError ?? new Error("Anthropic API failed after retries");
  }
}

/** OpenAI Provider */
export class OpenAIProvider implements CloudProvider {
  readonly type: CloudProviderType = "openai";
  readonly defaultModel = "gpt-4o-2024-08-06";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: CloudProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com";
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async chat(request: CloudChatRequest): Promise<CloudChatResponse> {
    const body = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.2,
      top_p: request.topP,
      stop: request.stopSequences,
    };

    const res = (await this.post("/v1/chat/completions", body)) as OpenAIResponse;
    const choice = res.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      usage: res.usage
        ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
        : undefined,
      finishReason: choice?.finish_reason,
      raw: res,
    };
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    // GPT-4o: $2.50/M input, $10/M output
    return (inputTokens / 1_000_000) * 2.5 + (outputTokens / 1_000_000) * 10.0;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let lastError: Error | null = null;
    for (let i = 0; i <= (this.maxRetries ?? 3); i++) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`OpenAI API ${res.status}: ${errText}`);
        }
        return await res.json();
      } catch (e) {
        lastError = e as Error;
        if (i < (this.maxRetries ?? 3)) {
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      }
    }
    throw lastError ?? new Error("OpenAI API failed after retries");
  }
}

/** Google Gemini Provider */
export class GeminiProvider implements CloudProvider {
  readonly type: CloudProviderType = "gemini";
  readonly defaultModel = "gemini-1.5-pro-002";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: CloudProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com";
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  async chat(request: CloudChatRequest): Promise<CloudChatResponse> {
    // 轉換 messages 為 Gemini 格式
    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const systemInstruction = request.messages.find((m) => m.role === "system")?.content;

    const body = {
      contents,
      system_instruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
      generation_config: {
        max_output_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.2,
        top_p: request.topP,
        stop_sequences: request.stopSequences,
      },
    };

    const res = (await this.post(`/v1beta/models/${request.model}:generateContent`, body)) as GeminiResponse;
    const candidate = res.candidates?.[0];
    return {
      text: candidate?.content?.parts?.[0]?.text ?? "",
      usage: res.usage_metadata
        ? { inputTokens: res.usage_metadata.prompt_token_count, outputTokens: res.usage_metadata.candidates_token_count }
        : undefined,
      finishReason: candidate?.finish_reason,
      raw: res,
    };
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    // Gemini 1.5 Pro: $3.50/M input, $10.50/M output
    return (inputTokens / 1_000_000) * 3.5 + (outputTokens / 1_000_000) * 10.5;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1beta/models?key=${this.apiKey}`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let lastError: Error | null = null;
    for (let i = 0; i <= (this.maxRetries ?? 3); i++) {
      try {
        const res = await fetch(`${this.baseUrl}${path}?key=${this.apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Gemini API ${res.status}: ${errText}`);
        }
        return await res.json();
      } catch (e) {
        lastError = e as Error;
        if (i < (this.maxRetries ?? 3)) {
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      }
    }
    throw lastError ?? new Error("Gemini API failed after retries");
  }
}

/** Provider Factory */
export function createCloudProvider(
  type: CloudProviderType,
  config: CloudProviderConfig,
): CloudProvider {
  switch (type) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "gemini":
      return new GeminiProvider(config);
    default:
      throw new Error(`Unknown cloud provider: ${type}`);
  }
}

/** 多 Provider 管理器 */
export class CloudProviderManager {
  private providers = new Map<CloudProviderType, CloudProvider>();
  private dailyCostUsd = 0;
  private costDate = new Date().toDateString();

  register(provider: CloudProvider): void {
    this.providers.set(provider.type, provider);
  }

  get(type: CloudProviderType): CloudProvider | undefined {
    return this.providers.get(type);
  }

  getDefault(type: CloudProviderType = "anthropic"): CloudProvider | undefined {
    return this.providers.get(type);
  }

  list(): CloudProvider[] {
    return [...this.providers.values()];
  }

  trackCost(costUsd: number): void {
    const today = new Date().toDateString();
    if (today !== this.costDate) {
      this.dailyCostUsd = 0;
      this.costDate = today;
    }
    this.dailyCostUsd += costUsd;
  }

  getDailyCost(): number {
    return this.dailyCostUsd;
  }

  canAfford(costUsd: number, maxDailyUsd: number): boolean {
    return this.dailyCostUsd + costUsd <= maxDailyUsd;
  }
}