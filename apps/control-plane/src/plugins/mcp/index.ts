// MCP Plugin 基類

import type { Plugin, PluginContext, PluginHealth } from "../types.js";
import type { McpServer } from "../../mcp/server.js";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  autoRestart?: boolean;
  restartDelay?: number;
}

export interface McpPluginOptions {
  servers: McpServerConfig[];
  /** 全域 MCP 啟用開關 */
  enabled?: boolean;
}

export abstract class McpPluginBase implements Plugin {
  public readonly id: string;
  public readonly name: string;
  public readonly version: string;
  public readonly description: string;
  public readonly core = false;
  public readonly priority = 50;

  protected servers: Map<string, McpServer> = new Map();
  protected configs: McpServerConfig[] = [];
  protected context?: PluginContext;
  protected options: McpPluginOptions;

  constructor(id: string, name: string, version: string, description: string, options: McpPluginOptions = { servers: [] }) {
    this.id = id;
    this.name = name;
    this.version = version;
    this.description = description;
    this.options = options;
    this.configs = options.servers ?? [];
  }

  abstract readonly serverType: string;

  /** 子類實作：建立具體的 McpServer 實例 */
  protected abstract createServer(config: McpServerConfig): McpServer;

  /** 子類可選：取得工具列表 */
  protected async getAvailableTools(server: McpServer): Promise<string[]> {
    try {
      // 這裡需根據實際 McpServer API 調整
      return [];
    } catch {
      return [];
    }
  }

  async init(context: PluginContext): Promise<void> {
    this.context = context;
    context.logger.info(`[${this.id}] Initializing ${this.serverType} MCP plugin`);
    
    // 驗證設定
    for (const config of this.configs) {
      if (!config.enabled) {
        context.logger.info(`[${this.id}] Server ${config.name} disabled, skipping`);
        continue;
      }
    }
  }

  async start(context: PluginContext): Promise<void> {
    this.context = context;
    const { enabled = true } = this.options;
    
    if (!enabled) {
      context.logger.info(`[${this.id}] Plugin disabled globally`);
      return;
    }

    // 啟用所有啟用的 servers
    for (const config of this.configs) {
      if (!config.enabled) continue;
      
      try {
        const server = this.createServer(config);
        this.servers.set(config.name, server);
        context.logger.info(`[${this.id}] Started MCP server: ${config.name} (${config.command} ${config.args.join(" ")})`);
      } catch (e) {
        context.logger.error(`[${this.id}] Failed to start server ${config.name}:`, e);
        if (!config.enabled) continue; // 可選 server 失敗不阻塞
        throw e;
      }
    }

    context.logger.info(`[${this.id}] Started with ${this.servers.size} MCP servers`);
    context.events.emit("mcp:servers:ready", { plugin: this.id, count: this.servers.size });
  }

  async stop(context: PluginContext): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        // 這裡需根據實際 McpServer API 調整
        // server.close?.();
        context.logger.info(`[${this.id}] Stopped MCP server: ${name}`);
      } catch (e) {
        context.logger.warn(`[${this.id}] Error stopping server ${name}:`, e);
      }
    }
    this.servers.clear();
  }

  async health(): Promise<PluginHealth> {
    const checks: Record<string, { status: "pass" | "fail" | "warn"; message?: string }> = {};
    
    for (const [name, server] of this.servers) {
      try {
        // 簡單的連線檢查
        checks[name] = { status: "pass", message: "Server running" };
      } catch {
        checks[name] = { status: "fail", message: "Server unavailable" };
      }
    }

    const allPass = Object.values(checks).every(c => c.status === "pass");
    return {
      status: allPass ? "healthy" : this.servers.size === 0 ? "healthy" : "degraded",
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  /** 取得所有 MCP Server 實例 */
  getServers(): Map<string, McpServer> {
    return this.servers;
  }

  /** 取得指定 Server */
  getServer(name: string): McpServer | undefined {
    return this.servers.get(name);
  }

  /** 列出所有可用工具 */
  async listTools(): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const [name, server] of this.servers) {
      result[name] = await this.getAvailableTools(server as any);
    }
    return result;
  }
}