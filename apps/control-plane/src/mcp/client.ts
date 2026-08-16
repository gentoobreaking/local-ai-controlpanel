// MCP Client（spec §18）：連接外部 MCP Server（stdio / HTTP+SSE）。
// 支援 initialize / tools/list / tools/call / resources/list / resources/read /
// prompts/list。

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  MCP_ERROR_CODES,
  MCP_VERSION,
  type InitializeResult,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type McpPrompt,
  type McpTool,
  type Resource,
  type ResourceContent,
  type ResourceTemplate,
} from "./types.js";

export type McpClientTransport =
  | { kind: "stdio"; command: string; args?: string[]; cwd?: string }
  | { kind: "http"; url: string; headers?: Record<string, string> };

export interface McpClientOptions {
  transport: McpClientTransport;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
}

export class McpClient {
  private readonly opts: McpClientOptions;
  private nextId = 1;
  private readonly pending = new Map<number | string, (r: JsonRpcSuccess | Error) => void>();
  private child?: ChildProcess;
  private rl?: import("node:readline").Interface;
  private closed = false;
  private initialized = false;
  private serverInfo?: InitializeResult["serverInfo"];
  private capabilities?: InitializeResult["capabilities"];

  constructor(opts: McpClientOptions) {
    this.opts = opts;
  }

  /** 建立連線（stdio：spawn process；http：驗證可達性）。 */
  async connect(): Promise<void> {
    if (this.opts.transport.kind === "stdio") {
      const t = this.opts.transport;
      this.child = spawn(t.command, t.args ?? [], { cwd: t.cwd, stdio: ["pipe", "pipe", "inherit"] });
      this.rl = createInterface({ input: this.child.stdout!, terminal: false });
      this.child.on("error", (err) => this.failAll(new Error(`mcp client stdio error: ${err.message}`)));
      this.rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: JsonRpcSuccess | JsonRpcError;
        try {
          msg = JSON.parse(trimmed) as JsonRpcSuccess | JsonRpcError;
        } catch {
          return;
        }
        if (typeof msg.id !== "number" && typeof msg.id !== "string") return;
        if ("error" in msg && msg.error) {
          this.pending.delete(msg.id);
          this.failAll(new Error(`mcp server error: ${msg.error.message}`));
          return;
        }
        const resolver = this.pending.get(msg.id);
        if (resolver) {
          this.pending.delete(msg.id);
          resolver(msg as JsonRpcSuccess);
        }
      });
      this.child.stdin!.on("error", () => undefined);
    }
    // http：不做連線驗證，defer 到第一個 request
    this.initialized = false;
  }

  isConnected(): boolean {
    return this.opts.transport.kind === "http" || (!this.closed && this.child !== undefined);
  }

  private failAll(err: Error): void {
    for (const reject of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private request(id: number | string): Promise<JsonRpcSuccess> {
    const timeoutMs = this.opts.requestTimeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request timeout: ${String(id)}`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        if (r instanceof Error) reject(r);
        else resolve(r);
      });
    });
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    if (this.opts.transport.kind === "stdio") {
      if (!this.child?.stdin) throw new Error("mcp client 未連線");
      const id = this.nextId++;
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
      const result = this.request(id);
      this.child.stdin.write(`${JSON.stringify(req)}\n`);
      return (await result).result;
    }
    const t = this.opts.transport;
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    const res = await fetch(t.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(t.headers ?? {}) },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`mcp http error: ${res.status} ${await res.text()}`);
    const msg = (await res.json()) as JsonRpcSuccess | JsonRpcError;
    if ("error" in msg && msg.error) {
      const e = msg.error;
      throw new Error(`mcp server error ${e.code}: ${e.message}`);
    }
    return (msg as JsonRpcSuccess).result;
  }

  async initialize(): Promise<InitializeResult> {
    if (this.initialized) {
      return {
        protocolVersion: MCP_VERSION,
        capabilities: this.capabilities ?? {},
        serverInfo: this.serverInfo ?? { name: "unknown", version: "0.0.0" },
      };
    }
    const result = (await this.call("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: { name: this.opts.clientName ?? "acp-mcp-client", version: this.opts.clientVersion ?? "0.6.0" },
    })) as InitializeResult;
    this.initialized = true;
    this.serverInfo = result.serverInfo;
    this.capabilities = result.capabilities;
    await this.call("notifications/initialized", {}).catch(() => undefined);
    return result;
  }

  listTools(): Promise<{ tools: McpTool[]; nextCursor: string | null }> {
    return this.call("tools/list", {}) as Promise<{ tools: McpTool[]; nextCursor: string | null }>;
  }

  callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.call("tools/call", { name, arguments: args });
  }

  listResources(): Promise<{ resources: Resource[]; nextCursor: string | null }> {
    return this.call("resources/list", {}) as Promise<{ resources: Resource[]; nextCursor: string | null }>;
  }

  listResourceTemplates(): Promise<{ resourceTemplates: ResourceTemplate[]; nextCursor: string | null }> {
    return this.call("resources/templates/list", {}) as Promise<{ resourceTemplates: ResourceTemplate[]; nextCursor: string | null }>;
  }

  readResource(uri: string): Promise<{ contents: ResourceContent[] }> {
    return this.call("resources/read", { uri }) as Promise<{ contents: ResourceContent[] }>;
  }

  listPrompts(): Promise<{ prompts: McpPrompt[]; nextCursor: string | null }> {
    return this.call("prompts/list", {}) as Promise<{ prompts: McpPrompt[]; nextCursor: string | null }>;
  }

  getPrompt(name: string, args: Record<string, string> = {}): Promise<unknown> {
    return this.call("prompts/get", { name, arguments: args });
  }

  close(): void {
    this.closed = true;
    this.child?.kill();
    this.rl?.close();
  }
}

export function isMcpError(err: unknown): err is { code: number; message: string } {
  return typeof err === "object" && err !== null && "code" in err;
}

export { MCP_ERROR_CODES, MCP_VERSION } from "./types.js";