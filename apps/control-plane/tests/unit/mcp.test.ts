// MCP Layer 單元測試（T034 §18）：
// initialize / tools/list / tools/call（含 Tool Gateway DENY）/ resources/read /
// prompts + Fastify HTTP routes + MCP Client（HTTP transport）。

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyEngine } from "../../src/policy/engine.js";
import { loadPolicies } from "../../src/policy/loader.js";
import { SandboxRegistry } from "../../src/sandbox/registry.js";
import { createStubSandbox } from "../../src/sandbox/adapters.js";
import { McpServer, registerMcpRoutes } from "../../src/mcp/server.js";
import { McpClient } from "../../src/mcp/client.js";
import type { JsonRpcError, JsonRpcSuccess } from "../../src/mcp/types.js";
import Fastify from "fastify";

const policiesDir = new URL("../../../../policies", import.meta.url).pathname;

type McpResponse = JsonRpcSuccess | JsonRpcError;

let ws: string;
let mcp: McpServer;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "acp-mcp-ws-"));
  writeFileSync(join(ws, "hello.txt"), "hello mcp\n");
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src", "main.ts"), "export const x = 1;\n");
  const registry = new SandboxRegistry();
  registry.register("docker", () => createStubSandbox("docker"));
  mcp = new McpServer({
    policy: new PolicyEngine(loadPolicies(policiesDir)),
    sandboxRegistry: registry,
    workspace: ws,
  });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function call(method: string, params?: unknown): Promise<McpResponse> {
  return mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method,
    ...(params !== undefined ? { params } : {}),
  });
}

async function okResult(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const res = await call(method, params);
  if ("error" in res) assert.fail(res.error.message);
  return res.result as Record<string, unknown>;
}

test("initialize：protocolVersion / capabilities / serverInfo", async () => {
  const result = await okResult("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  assert.equal(result.protocolVersion, "2024-11-05");
  const caps = result.capabilities as Record<string, unknown>;
  assert.ok(caps.tools);
  assert.ok(caps.resources);
  const info = result.serverInfo as { name: string };
  assert.equal(info.name, "acp-control-plane");
});

test("tools/list：內部工具以 MCP Tool 形式暴露", async () => {
  const result = await okResult("tools/list");
  const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
  assert.ok(names.includes("filesystem.read_file"));
  assert.ok(names.includes("filesystem.write_file"));
  assert.ok(names.includes("git.status"));
  assert.ok(names.includes("shell.run"));
  assert.ok(names.includes("search.code"));
});

test("tools/call git.status：讀取 workspace repo 狀態（git read）", async () => {
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: ws });
  execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
  const result = await okResult("tools/call", { name: "git.status", arguments: {} });
  assert.equal(result.isError, false);
  const content = result.content as Array<{ text: string }>;
  assert.ok(content[0]!.text.includes("hello.txt"));
});

test("tools/call：不存在的工具 → TOOL_NOT_FOUND", async () => {
  const res = await call("tools/call", { name: "no.such.tool", arguments: {} });
  if ("result" in res) assert.fail("should error");
  assert.equal(res.error.code, -32002);
});

test("tools/call：路徑 traversal 拒絕（檔案超出 workspace）", async () => {
  const res = await call("tools/call", {
    name: "filesystem.read_file",
    arguments: { path: "../../etc/passwd" },
  });
  if ("result" in res) assert.fail("should error");
  assert.ok(res.error.message.includes("超出 workspace"));
});

test("resources/read：file:// workspace 掛載", async () => {
  const result = await okResult("resources/read", { uri: "file://hello.txt" });
  const contents = result.contents as Array<{ text: string }>;
  assert.equal(contents[0]!.text, "hello mcp\n");
});

test("resources/read：memory:// project_memory 掛載", async () => {
  const result = await okResult("resources/read", { uri: "memory://tasks" });
  const contents = result.contents as Array<{ mimeType: string }>;
  assert.equal(contents[0]!.mimeType, "application/json");
});

test("resources/read：未知 URI → RESOURCE_NOT_FOUND", async () => {
  const res = await call("resources/read", { uri: "ftp://foo" });
  if ("result" in res) assert.fail("should error");
  assert.equal(res.error.code, -32002);
});

test("prompts/list + prompts/get：code_review 模板", async () => {
  const list = await okResult("prompts/list");
  const names = (list.prompts as Array<{ name: string }>).map((p) => p.name);
  assert.ok(names.includes("code_review"));
  assert.ok(names.includes("debug"));
  assert.ok(names.includes("refactor"));

  const got = await okResult("prompts/get", { name: "code_review", arguments: { scope: "src/" } });
  const messages = got.messages as Array<{ role: string; content: { text: string } }>;
  assert.equal(messages[0]!.role, "user");
  assert.ok(messages[0]!.content.text.includes("src/"));
});

test("HTTP routes：POST /mcp initialize（Fastify inject）", async () => {
  const app = Fastify({ logger: false });
  await app.register(async (a) => {
    registerMcpRoutes(a, mcp);
  });
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as JsonRpcSuccess;
  const result = body.result as { serverInfo: { name: string } };
  assert.equal(result.serverInfo.name, "acp-control-plane");
  await app.close();
});

test("MCP Client（HTTP transport）：initialize → tools/list → read_resource", async () => {
  const app = Fastify({ logger: false });
  await app.register(async (a) => {
    registerMcpRoutes(a, mcp);
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;

  const client = new McpClient({ transport: { kind: "http", url: `http://127.0.0.1:${port}/mcp` } });
  await client.connect();
  const init = await client.initialize();
  assert.equal(init.serverInfo.name, "acp-control-plane");
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "git.status"));
  const resource = await client.readResource("file://hello.txt");
  assert.equal(resource.contents[0]?.text, "hello mcp\n");
  client.close();
  await app.close();
});