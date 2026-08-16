// MCP 標準工具定義 + Tool Gateway（spec §18）。
// Control Plane 內部工具（filesystem / git / shell / network / search）以 MCP Tool
// 形式暴露；每次呼叫先過 Policy Engine（§18 Rule 4：MCP 不可繞過 Control Plane Policy）。

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { PolicyEngine } from "../policy/engine.js";
import type { SandboxRegistry } from "../sandbox/registry.js";
import {
  McpError,
  MCP_ERROR_CODES,
  type McpTool,
  type ToolCallContext,
  type ToolDefinition,
} from "./types.js";

export interface McpToolsOptions {
  policy: PolicyEngine;
  sandboxRegistry?: SandboxRegistry;
  /** 工具預設工作目錄（workspace 根；未指定時以 process.cwd() 為準） */
  workspace: string;
  timeoutMs?: number;
  /** 內部工具集合（Phase 1–5：filesystem / git / shell / network / search） */
  tools?: Array<keyof typeof DEFAULT_TOOL_NAMES>;
}

export const DEFAULT_TOOL_NAMES = {
  filesystem: "filesystem",
  git: "git",
  shell: "shell",
  network: "network",
  search: "search",
} as const;

/** MCP 工具名稱 → Policy Engine ToolKind（§28：policy 以類別管制）。 */
function toToolKind(tool: string): import("../policy/types.js").ToolKind {
  if (tool.startsWith("filesystem.write")) return "filesystem_write";
  if (tool.startsWith("filesystem.")) return "filesystem_read";
  if (tool.startsWith("git.")) return "git_read";
  if (tool.startsWith("shell.")) return "shell";
  if (tool.startsWith("network.")) return "network";
  if (tool.startsWith("search.")) return "filesystem_read";
  return "filesystem_read";
}

export class McpToolGateway {
  private readonly toolMap = new Map<string, ToolDefinition>();
  readonly policy: PolicyEngine;
  private readonly sandboxRegistry?: SandboxRegistry;
  readonly workspace: string;
  readonly timeoutMs: number;

  constructor(opts: McpToolsOptions) {
    this.policy = opts.policy;
    this.sandboxRegistry = opts.sandboxRegistry;
    this.workspace = opts.workspace;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.registerDefaults(opts.tools);
  }

  /** §18 Rule 4：Tool Gateway → internal Policy Engine → ALLOW/DENY。 */
  private gate(tool: string): "ALLOW" | "ALLOW_IN_SANDBOX" {
    const decision = this.policy.evaluateTool({ tool: toToolKind(tool) });
    if (decision.verdict === "DENY") {
      throw new McpError(
        MCP_ERROR_CODES.TOOL_NOT_FOUND,
        `tool denied by policy: ${tool}（${decision.reason}）`,
        { tool, reason: decision.reason },
      );
    }
    return decision.verdict;
  }

  private registerDefaults(
    tools?: Array<keyof typeof DEFAULT_TOOL_NAMES>,
  ): void {
    const wanted = tools ?? (Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof typeof DEFAULT_TOOL_NAMES>);
    for (const key of wanted) {
      switch (key) {
        case "filesystem":
          this.registerFilesystem();
          break;
        case "git":
          this.registerGit();
          break;
        case "shell":
          this.registerShell();
          break;
        case "network":
          this.registerNetwork();
          break;
        case "search":
          this.registerSearch();
          break;
      }
    }
  }

  register(def: ToolDefinition): void {
    this.toolMap.set(def.name, def);
  }

  list(): McpTool[] {
    return [...this.toolMap.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  has(name: string): boolean {
    return this.toolMap.has(name);
  }

  /** 呼叫工具：驗證 Policy → 驗證輸入 → 執行 handler。 */
  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const def = this.toolMap.get(name);
    if (!def) throw new McpError(MCP_ERROR_CODES.TOOL_NOT_FOUND, `tool not found: ${name}`);
    const verdict = this.gate(name);
    return def.handler(args, {
      tool: name,
      verdict,
      workspace: this.workspace,
      timeoutMs: this.timeoutMs,
    });
  }

  // ---- 工具實作 ----

  private resolvePath(ctx: ToolCallContext, rel: string): string {
    const target = resolve(ctx.workspace, rel);
    const root = resolve(ctx.workspace) + sep;
    if (target !== resolve(ctx.workspace) && !target.startsWith(root)) {
      throw new McpError(
        MCP_ERROR_CODES.INTERNAL_ERROR,
        "path 超出 workspace 範圍",
        { rel, resolved: target },
      );
    }
    return target;
  }

  private registerFilesystem(): void {
    this.register({
      name: DEFAULT_TOOL_NAMES.filesystem + ".read_file",
      description: "讀取 workspace 內的檔案內容",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "workspace 相對路徑" } },
        required: ["path"],
      },
      handler: async (args, ctx) => {
        const path = this.resolvePath(ctx, String(args.path));
        return { path, content: readFileSync(path, "utf-8") };
      },
    });
    this.register({
      name: DEFAULT_TOOL_NAMES.filesystem + ".list_dir",
      description: "列出 workspace 內目錄的項目",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "workspace 相對路徑（預設 .）" },
        },
        required: [],
      },
      handler: async (args, ctx) => {
        const path = this.resolvePath(ctx, String(args.path ?? "."));
        const entries = readdirSync(path).map((name) => {
          const full = join(path, name);
          const st = statSync(full);
          return {
            name,
            type: st.isDirectory() ? "directory" : "file",
            size: st.isDirectory() ? undefined : st.size,
          };
        });
        return { path, entries };
      },
    });
    this.register({
      name: DEFAULT_TOOL_NAMES.filesystem + ".write_file",
      description: "寫入檔案（須通過 §20 Artifact Policy；write 僅 ALLOW_IN_SANDBOX）",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "workspace 相對路徑" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      handler: async (args, ctx) => {
        const path = this.resolvePath(ctx, String(args.path));
        const artifact = this.policy.evaluateArtifact([basename(path)]);
        if (artifact.verdict === "DENIED") {
          throw new McpError(
            MCP_ERROR_CODES.INTERNAL_ERROR,
            `write denied by artifact policy（${artifact.violations.map((v) => v.file).join(", ")}）`,
            { violations: artifact.violations },
          );
        }
        writeFileSync(path, String(args.content), "utf-8");
        return { path, written: true };
      },
    });
  }

  private runGit(ctx: ToolCallContext, args: string[]): Promise<{ code: number; output: string }> {
    return new Promise((resolveRun) => {
      execFile(
        "git",
        ["-C", ctx.workspace, ...args],
        { timeout: ctx.timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException & { code?: number }).code === "ENOENT") {
            resolveRun({ code: -1, output: `git not found: ${(err as Error).message}` });
            return;
          }
          if (err) {
            resolveRun({
              code: typeof (err as { code?: unknown }).code === "number"
                ? ((err as { code: number }).code)
                : 1,
              output: stderr || stdout,
            });
            return;
          }
          resolveRun({ code: 0, output: stdout });
        },
      );
    });
  }

  private registerGit(): void {
    const gitTool = (
      name: string,
      description: string,
      args: (a: Record<string, unknown>) => string[],
      schema: ToolDefinition["inputSchema"],
    ): void => {
      this.register({
        name,
        description,
        inputSchema: schema,
        handler: async (argsIn, ctx) => {
          const r = await this.runGit(ctx, args(argsIn));
          if (r.code !== 0) {
            throw new McpError(MCP_ERROR_CODES.INTERNAL_ERROR, `git failed: ${r.output}`, { code: r.code });
          }
          return { output: r.output.trimEnd() };
        },
      });
    };
    gitTool(
      DEFAULT_TOOL_NAMES.git + ".diff",
      "取得 workspace 的 git diff（唯讀）",
      () => ["diff", "HEAD"],
      { type: "object", properties: {}, required: [] },
    );
    gitTool(
      DEFAULT_TOOL_NAMES.git + ".log",
      "取得 git log（唯讀）",
      (a) => ["log", "--oneline", "-n", String(a.limit ?? 20)],
      {
        type: "object",
        properties: { limit: { type: "integer", description: "筆數（預設 20）" } },
        required: [],
      },
    );
    gitTool(
      DEFAULT_TOOL_NAMES.git + ".status",
      "取得 git status --porcelain（唯讀）",
      () => ["status", "--porcelain"],
      { type: "object", properties: {}, required: [] },
    );
  }

  private registerShell(): void {
    this.register({
      name: DEFAULT_TOOL_NAMES.shell + ".run",
      description:
        "於 workspace 執行 shell 指令（§28 Rule 8：預設須在 sandbox 內執行；network 預設禁）",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          network: { type: "boolean", description: "default-deny（§28.1）" },
          timeoutMs: { type: "integer" },
        },
        required: ["command"],
      },
      handler: async (args, ctx) => {
        const cmd = String(args.command);
        if (ctx.verdict === "ALLOW_IN_SANDBOX") {
          const sandbox = this.sandboxRegistry;
          if (!sandbox) {
            throw new McpError(
              MCP_ERROR_CODES.INTERNAL_ERROR,
              "shell 需 sandbox 執行但未掛載 sandbox registry（§28 Rule 8）",
            );
          }
          // 選一個可用後端執行
          for (const name of sandbox.names()) {
            const sb = sandbox.get(name);
            if (!sb) continue;
            if (!(await sb.isAvailable())) continue;
            const r = await sb.run({
              command: ["/bin/sh", "-c", cmd],
              cwd: ctx.workspace,
              network: args.network === true,
              timeout: Math.min(Number(args.timeoutMs ?? ctx.timeoutMs / 1000) || 30, 120),
            });
            return { sandbox: sb.name, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
          }
          throw new McpError(
            MCP_ERROR_CODES.INTERNAL_ERROR,
            "shell 需 sandbox 執行但無可用後端（§28 Rule 8）",
          );
        }
        const r = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
          (resolveRun) => {
            execFile(
              "/bin/sh",
              ["-c", cmd],
              { cwd: ctx.workspace, timeout: ctx.timeoutMs },
              (err, stdout, stderr) => {
                resolveRun({
                  exitCode: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0,
                  stdout,
                  stderr,
                });
              },
            );
          },
        );
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      },
    });
  }

  private registerNetwork(): void {
    this.register({
      name: DEFAULT_TOOL_NAMES.network + ".http_get",
      description: "HTTP GET（§28：本地 Worker 預設禁網，需 policy network.enabled=true）",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, timeoutMs: { type: "integer" } },
        required: ["url"],
      },
      handler: async (args, ctx) => {
        const url = String(args.url);
        const res = await fetch(url, {
          signal: AbortSignal.timeout(Math.min(Number(args.timeoutMs ?? ctx.timeoutMs), 30_000)),
        });
        return { status: res.status, contentType: res.headers.get("content-type"), text: await res.text() };
      },
    });
  }

  private registerSearch(): void {
    const walk = (dir: string, depth: number, out: string[]): void => {
      if (depth > 8 || out.length >= 50) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === ".git" || name === "node_modules") continue;
        const full = join(dir, name);
        try {
          if (statSync(full).isDirectory()) walk(full, depth + 1, out);
          else out.push(full);
        } catch {
          // 忽略無法讀取的項目
        }
      }
    };
    this.register({
      name: DEFAULT_TOOL_NAMES.search + ".code",
      description: "在 workspace 中搜尋文字（排除 .git / node_modules）",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "搜尋字串（substring match）" },
          ext: { type: "string", description: "副檔名過濾（如 .ts）" },
          limit: { type: "integer" },
        },
        required: ["pattern"],
      },
      handler: async (args, ctx) => {
        const needle = String(args.pattern);
        const ext = args.ext ? String(args.ext) : undefined;
        const limit = Number(args.limit ?? 20);
        const files: string[] = [];
        walk(ctx.workspace, 0, files);
        const hits: Array<{ path: string; line: number; text: string }> = [];
        for (const file of files) {
          if (ext && !file.endsWith(ext)) continue;
          let lines: string[];
          try {
            lines = readFileSync(file, "utf-8").split("\n");
          } catch {
            continue;
          }
          for (let i = 0; i < lines.length && hits.length < limit; i++) {
            if (lines[i]!.includes(needle)) {
              hits.push({ path: file.slice(ctx.workspace.length + 1), line: i + 1, text: lines[i]!.slice(0, 200) });
            }
          }
        }
        return { matches: hits.slice(0, limit) };
      },
    });
  }
}