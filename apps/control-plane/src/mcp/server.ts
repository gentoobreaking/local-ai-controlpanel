// MCP Server（spec §18）：stdio / HTTP+SSE 雙模式。
// 以 JSON-RPC 2.0 實作 MCP functional subset：
// initialize / tools/list / tools/call / resources/list / resources/read /
// resources/templates/list / prompts/list / prompts/get。

import { createInterface } from "node:readline";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PolicyEngine } from "../policy/engine.js";
import type { SandboxRegistry } from "../sandbox/registry.js";
import { McpPrompts } from "./prompts.js";
import { McpResources } from "./resources.js";
import { McpToolGateway } from "./tools.js";
import {
  MCP_ERROR_CODES,
  MCP_VERSION,
  McpError,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type ServerCapabilities,
} from "./types.js";

export interface McpServerOptions {
  policy: PolicyEngine;
  sandboxRegistry?: SandboxRegistry;
  workspace: string;
  /** 允許的傳輸模式：stdio（預設）、http（由 routes 掛載）、both */
  transport?: "stdio" | "http" | "both";
  serverName?: string;
  serverVersion?: string;
  /** tools 子集（缺省全部） */
  tools?: string[];
  memoryDir?: string;
}

export class McpServer {
  readonly tools: McpToolGateway;
  readonly resources: McpResources;
  readonly prompts: McpPrompts;
  private readonly serverInfo: { name: string; version: string };

  constructor(opts: McpServerOptions) {
    this.tools = new McpToolGateway({
      policy: opts.policy,
      sandboxRegistry: opts.sandboxRegistry,
      workspace: opts.workspace,
    });
    this.resources = new McpResources({
      workspace: opts.workspace,
      memoryDir: opts.memoryDir,
    });
    this.prompts = new McpPrompts();
    this.serverInfo = {
      name: opts.serverName ?? "acp-control-plane",
      version: opts.serverVersion ?? "0.6.0",
    };
  }

  capabilities(): ServerCapabilities {
    return {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    };
  }

  // ---- JSON-RPC request 處理（MCP 層）----

  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcSuccess | JsonRpcError> {
    if (req.jsonrpc !== "2.0") {
      return this.error(req.id, MCP_ERROR_CODES.INVALID_REQUEST, "jsonrpc 必須為 2.0");
    }
    try {
      switch (req.method) {
        case "initialize": {
          const p = req.params as InitializeParams;
          if (!p?.protocolVersion) {
            return this.error(req.id, MCP_ERROR_CODES.INVALID_PARAMS, "缺少 protocolVersion");
          }
          const result: InitializeResult = {
            protocolVersion: MCP_VERSION,
            capabilities: this.capabilities(),
            serverInfo: this.serverInfo,
            instructions: "Control Plane MCP Layer（spec §18）：Tools/Resources/Prompts 皆受 Policy Engine 管制",
          };
          return this.ok(req.id, result);
        }
        case "tools/list": {
          const tools = this.tools.list();
          return this.ok(req.id, { tools, nextCursor: null });
        }
        case "tools/call": {
          const p = req.params as { name?: string; arguments?: Record<string, unknown> };
          if (!p?.name) return this.error(req.id, MCP_ERROR_CODES.INVALID_PARAMS, "缺少 tool name");
          const content = await this.tools.call(p.name, p.arguments ?? {});
          return this.ok(req.id, {
            content: [{ type: "text", text: JSON.stringify(content, null, 2) }],
            isError: false,
          });
        }
        case "resources/list": {
          return this.ok(req.id, { resources: this.resources.listResources(), nextCursor: null });
        }
        case "resources/templates/list": {
          return this.ok(req.id, { resourceTemplates: this.resources.templates(), nextCursor: null });
        }
        case "resources/read": {
          const p = req.params as { uri?: string };
          if (!p?.uri) return this.error(req.id, MCP_ERROR_CODES.INVALID_PARAMS, "缺少 resource uri");
          const contents = await this.resources.read(p.uri);
          return this.ok(req.id, { contents });
        }
        case "prompts/list": {
          return this.ok(req.id, { prompts: this.prompts.list(), nextCursor: null });
        }
        case "prompts/get": {
          const p = req.params as { name?: string; arguments?: Record<string, string> };
          if (!p?.name) return this.error(req.id, MCP_ERROR_CODES.INVALID_PARAMS, "缺少 prompt name");
          const messages = this.prompts.render(p.name, p.arguments ?? {});
          if (!messages) {
            throw new McpError(MCP_ERROR_CODES.PROMPT_NOT_FOUND, `prompt not found: ${p.name}`);
          }
          return this.ok(req.id, { description: this.prompts.get(p.name)?.description, messages });
        }
        case "notifications/initialized":
        case "notifications/cancelled":
          // notification：無 response
          return { jsonrpc: "2.0", id: req.id, result: null };
        default:
          return this.error(req.id, MCP_ERROR_CODES.METHOD_NOT_FOUND, `unknown method: ${req.method}`);
      }
    } catch (err) {
      if (err instanceof McpError) return this.error(req.id, err.code, err.message, err.data);
      return this.error(req.id, MCP_ERROR_CODES.INTERNAL_ERROR, (err as Error).message);
    }
  }

  private ok(id: number | string, result: unknown): JsonRpcSuccess {
    return { jsonrpc: "2.0", id, result };
  }

  private error(
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcError {
    return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
  }

  // ---- stdio 傳輸 ----

  /** 以 stdio 為 transport 執行 MCP session（如 `cp protocol start --mcp` 之後的 MCP subprocess）。 */
  runStdio(): void {
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        const err: JsonRpcError = {
          jsonrpc: "2.0",
          id: null,
          error: { code: MCP_ERROR_CODES.PARSE_ERROR, message: "parse error" },
        };
        process.stdout.write(`${JSON.stringify(err)}\n`);
        return;
      }
      if ("method" in req) {
        void this.handleRequest(req).then((res) => {
          process.stdout.write(`${JSON.stringify(res)}\n`);
        });
      }
    });
  }
}

// ---- HTTP + SSE 傳輸（Fastify routes）----
// 以 POST /mcp 做 JSON-RPC request/response（MCP over HTTP），
// 支援 `Accept: text/event-stream` 的 SSE 格式響應。

export function registerMcpRoutes(
  app: FastifyInstance,
  server: McpServer,
): void {
  const send = async (res: import("node:http").ServerResponse, msg: unknown): Promise<void> => {
    const body = JSON.stringify(msg);
    if (res.destroyed) return;
    res.write(`data: ${body}\n\n`);
  };

  app.post("/mcp", async (req: FastifyRequest, reply) => {
    const wantsSse = (req.headers.accept ?? "").includes("text/event-stream");

    if (typeof req.body !== "object" || req.body === null || !("method" in (req.body as object))) {
      const err: JsonRpcError = {
        jsonrpc: "2.0",
        id: null,
        error: { code: MCP_ERROR_CODES.INVALID_REQUEST, message: "invalid request" },
      };
      return reply.code(400).send(err);
    }
    const request = req.body as JsonRpcRequest;

    // notification（無 id）
    if (request.id === undefined) {
      return reply.code(202).send({});
    }

    if (!wantsSse) {
      const res = await server.handleRequest(request);
      return reply.code(200).send(res);
    }

    // SSE 響應：單一 JSON-RPC 結果以 event-stream 回傳（MCP over HTTP+SSE）
    reply.hijack();
    const res = reply.raw;
    const origin = req.headers.origin;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: null, result: { started: true } })}\n\n`);
    const result = await server.handleRequest(request);
    await send(res, result);
    res.end();
  });

  app.get("/mcp/health", async () => ({
    status: "ok",
    server: { name: "acp-control-plane" },
    tools: server.tools.list().length,
    protocol: MCP_VERSION,
  }));
}

export { MCP_VERSION, MCP_ERROR_CODES } from "./types.js";