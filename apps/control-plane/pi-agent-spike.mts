// Spike：驗證 pi Agent + ollama（qwen2.5-coder:7b）+ 自訂 web_search 工具
// 目標：證明 ReAct 迴圈可運作、工具被呼叫、行為可由 hooks 控制
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
// 動態載入 ACP 的檢索模組（避免相對路徑問題 → 直接 inline 簡化版）
const KNOWN: Record<string, true> = { requests: true, httpx: true, fastapi: true, pytest: true };

async function webSearch(query: string): Promise<string> {
  const pkgMatch = query.toLowerCase().match(/\b(requests|httpx|fastapi|pytest)\b/);
  if (pkgMatch) {
    const res = await fetch(`https://pypi.org/pypi/${pkgMatch[1]}/json`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const d = (await res.json()) as { info?: { summary?: string } };
      return `[PyPI:${pkgMatch[1]}] ${d.info?.summary ?? ""}`;
    }
  }
  return `(no results for: ${query})`;
}

const model: Model<"openai-completions"> = {
  id: "qwen2.5-coder:7b",
  name: "qwen2.5-coder 7b (ollama)",
  api: "openai-completions",
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 2048,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: true,
    supportsStrictMode: false,
    maxTokensField: "max_tokens",
  },
};

const searchTool = {
  name: "web_search",
  label: "Web Search",
  description: "搜尋套件官方資訊。任務涉及任何 library/API 用法時必須先呼叫。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "英文搜尋關鍵字" } },
    required: ["query"],
  } as never,
  execute: async (_id: string, params: { query: string }) => {
    const result = await webSearch(params.query);
    console.log(`🔧 [tool] web_search("${params.query}") → ${result.slice(0, 80)}`);
    return { output: result, title: `web_search(${params.query})` };
  },
} as never;

const agent = new Agent({
  initialState: {
    systemPrompt:
      "你是 coding agent。規則：寫程式前必須先用 web_search 查過相關 API 用法。完成後輸出最終答案。",
    model,
    tools: [searchTool],
  },
  getApiKey: () => "ollama", // ollama 免金鑰但 pi 要求非空值
  streamFn: (model, context, options) => {
      console.log("  [streamFn] messages:", JSON.stringify(context.messages).slice(0, 300));
      console.log("  [streamFn] tools:", JSON.stringify(context.tools).slice(0, 200));
      console.log("  [streamFn] systemPrompt:", String(context.systemPrompt).slice(0, 100));
      return streamSimple(model as never, context, options as never);
    },
  beforeToolCall: async (ctx) => {
    console.log(`  [hook] beforeToolCall: ${ctx.toolName ?? "?"}`);
  },
  shouldStopAfterTurn: async () => {
    // maxRounds 護欄：10 輪上限
    return searchCount > 0 && agent.state.messages.length > 20;
  },
});

agent.subscribe((event) => {
  const t = (event as { type: string }).type;
  console.log(`  [evt] ${t}`, t.includes("error") ? JSON.stringify(event).slice(0, 300) : "");
});

// ── ReAct 主迴圈：解析文字型 tool call（小模型適配）→ 執行 → 回灌 ──
let round = 0;
const MAX_ROUNDS = 10;
let searchCount = 0;
let lastSearchResult = "";
const seenQueries = new Set<string>();

while (round < MAX_ROUNDS) {
  round += 1;
  await agent.prompt(
      round === 1
        ? "寫一個 Python 函式：用 requests 上傳檔案並設定 5 秒 timeout。請先呼叫 web_search 查詢相關用法，再給出完整程式碼。"
        : `[web_search 結果]\n${lastSearchResult}\n\n證據已更新。若仍不足請再查（換不同關鍵字），否則給出最終程式碼。`,
  );
  const msgs = agent.state.messages;
  const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
  const content = (lastAssistant as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  console.log(`── Round ${round} ── ${text.slice(0, 150).replace(/\n/g, " ")}`);

  // 解析文字型 tool call
  const tcMatch = text.match(/\{\s*"name"\s*:\s*"([\w_]+)"[\s\S]*?"arguments"\s*:\s*(\{[^}]*\})\s*\}/);
  if (!tcMatch) {
    console.log(`✅ 最終答案（round ${round}）`);
    break;
  }
  const toolName = tcMatch[1]!;
  let args: { query?: string } = {};
  try { args = JSON.parse(tcMatch[2]!); } catch { break; }
  console.log(`🔧 tool: ${toolName}(${JSON.stringify(args)})`);
  // 退化偵測：相同查詢重複 → 強制收斂
  const norm = args.query!.trim().toLowerCase();
  if (seenQueries.has(norm)) {
    console.log(`⚠️ 重複查詢偵測 → 強制收斂（帶現有證據進入實作）`);
    break;
  }
  seenQueries.add(norm);
  searchCount += 1;
  const result = await webSearch(args.query ?? "");
  lastSearchResult = result;
}
console.log(`searchCount=${searchCount}, totalMessages=${agent.state.messages.length}`);