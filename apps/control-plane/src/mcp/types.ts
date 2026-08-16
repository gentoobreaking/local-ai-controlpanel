// MCP Layer 型別定義（spec §18）。
// 實作 Anthropic MCP Spec（2024）的 functional subset：以 JSON-RPC 2.0 為基底，
// 支援 initialize / tools/list / tools/call / resources/list / resources/read /
// prompts/list / prompts/get。雙傳輸：stdio（MCP Server）與 HTTP+SSE（MCP over HTTP）。

export const MCP_VERSION = "2024-11-05";
export const JSON_RPC_VERSION = "2.0";

export type McpProtocolVersion = "2024-11-05" | "2024-10-07" | "2024-09-31";

// ---- JSON-RPC 2.0 基本型別 ----

export interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: number | string;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // MCP 自訂
  RESOURCE_NOT_FOUND: -32002,
  TOOL_NOT_FOUND: -32002,
  PROMPT_NOT_FOUND: -32002,
} as const;

export class McpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

// ---- Tool（§18：MCP Server 以 Tool 暴露 Control Plane 內部能力）----

export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（object）形式的輸入驗證 */
  inputSchema: ToolInputSchema;
  /** 執行 handler（回傳純資料，MCP 層負責包裝） */
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<unknown>;
}

export interface ToolCallContext {
  /** 呼叫者（tool 名稱） */
  tool: string;
  /** §18 Rule 4：Tool Gateway → Policy Engine 的決策已通過 */
  verdict: "ALLOW" | "ALLOW_IN_SANDBOX";
  /** 允許的 workspace / sandbox 位置 */
  workspace: string;
  timeoutMs: number;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

// ---- Resource（§18：workspace / git history / project_memory 以 Resource 暴露）----

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType?: string;
}

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface ResourceReader {
  match(uri: string): boolean;
  read(uri: string): Promise<ResourceContent[]>;
}

// ---- Prompt（§18：code_review / debug / refactor 等模板）----

export type PromptArgumentValue = string | number | boolean;

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

// ---- initialize / 協定 ----

export interface ClientCapabilities {
  experimental?: Record<string, unknown>;
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
}

export interface ServerCapabilities {
  tools?: Record<string, unknown>;
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: Record<string, unknown>;
}

export interface InitializeParams {
  protocolVersion: string;
  capabilities: ClientCapabilities;
  clientInfo: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: { name: string; version: string };
  instructions?: string;
}