// MCP Prompt 模板（spec §18）：code_review / debug / refactor 等。
// Prompt 只是「模板」——以 `{{變數}}` 取代（prompts/get 帶 arguments），不執行任何動作。

import type { McpPrompt, McpPromptMessage } from "./types.js";

export interface McpPromptsOptions {
  /** 預設語言（用於模板內容） */
  language?: string;
}

const DEFAULT_LANGUAGE = "typescript";

interface PromptTemplate {
  prompt: McpPrompt;
  text: string;
}

export class McpPrompts {
  private readonly templates = new Map<string, PromptTemplate>();
  private readonly language: string;

  constructor(opts: McpPromptsOptions = {}) {
    this.language = opts.language ?? DEFAULT_LANGUAGE;
    this.registerDefault();
  }

  private define(
    name: string,
    description: string,
    args: McpPrompt["arguments"],
    text: string,
  ): void {
    this.templates.set(name, {
      prompt: { name, description, arguments: args },
      text,
    });
  }

  private registerDefault(): void {
    const lang = this.language;

    this.define(
      "code_review",
      "對 workspace 中的變更（git diff）進行程式碼審查",
      [
        { name: "scope", description: "審查範圍（如 src/、全部）", required: false },
        { name: "focus", description: "重點（correctness / security / performance / style）", required: false },
      ],
      `你是資深 ${lang} 工程師。請審查 git diff（scope: {{scope}}）。\n`
        + `審查重點: {{focus}}。\n`
        + `請輸出:\n1. 問題清單（嚴重度排序，標出檔案/行號）\n2. 必要修改建議\n3. 通過審查與否的結論`,
    );

    this.define(
      "debug",
      "針對失敗輸出（verification/reflection）進行除錯分析",
      [
        { name: "error", description: "失敗訊息或輸出" },
        { name: "context", description: "任務/變更背景", required: false },
      ],
      `以下是執行失敗的輸出，請分析根因並提出修復步驟（${lang}）。\n`
        + `背景: {{context}}\n`
        + `失敗輸出:\n\`\`\`\n{{error}}\n\`\`\`\n`
        + `請判斷屬於: environment_error / patch_error / knowledge_error / model_limitation`,
    );

    this.define(
      "refactor",
      "在維持行為的前提下重構程式碼",
      [
        { name: "target", description: "目標檔案或模組" },
        { name: "goal", description: "重構目標（可讀性 / 效能 / 解耦）", required: false },
      ],
      `請重構 {{target}}（${lang}，維持行為不變）。\n`
        + `目標: {{goal}}。\n`
        + `輸出格式: 逐步說明 → 變更方案 → 風險評估。勿直接改檔案。`,
    );

    this.define(
      "plan",
      "把任務要求展開為執行計畫（對應 §8 PLANNING 階段）",
      [
        { name: "request", description: "任務要求" },
        { name: "risk", description: "風險等級（low / medium / high）", required: false },
      ],
      `請把任務要求展開為可執行的計畫（${lang}）。\n`
        + `任務: {{request}}\n`
        + `風險: {{risk}}。\n`
        + `輸出: 步驟清單（每步含預期產出與驗證方式）、檔案變更範圍、不變更事項。`,
    );
  }

  list(): McpPrompt[] {
    return [...this.templates.values()].map((t) => t.prompt);
  }

  get(name: string): McpPrompt | undefined {
    return this.templates.get(name)?.prompt;
  }

  /**
   * 依 arguments 渲染 prompt 訊息（mcp.prompts.get 的資料來源）。
   * 以 `{{name}}` 取代；未提供的變數以「無」填入。
   */
  render(name: string, args: Record<string, string> = {}): McpPromptMessage[] | undefined {
    const template = this.templates.get(name);
    if (!template) return undefined;
    const text = template.text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
      const value = args[key];
      return value !== undefined && value !== "" ? value : "無";
    });
    return [{ role: "user", content: { type: "text", text } }];
  }
}