// Plugin Registry 核心實作

import type {
  Plugin,
  PluginRegistry,
  PluginContext,
  PluginConfigSchema,
  PluginHealth,
  PluginLogger,
  PluginEventBus,
  PluginService,
  PluginLoadOptions,
} from "./types.js";

/** 簡單日誌器實作 */
class ConsoleLogger implements PluginLogger {
  constructor(private prefix: string) {}

  private log(level: "debug" | "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    console[level](`[${timestamp}] [${this.prefix}] ${msg}`, meta ?? "");
  }

  debug(msg: string, meta?: Record<string, unknown>) { this.log("debug", msg, meta); }
  info(msg: string, meta?: Record<string, unknown>) { this.log("info", msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>) { this.log("warn", msg, meta); }
  error(msg: string, meta?: Record<string, unknown>) { this.log("error", msg, meta); }
}

/** 簡單事件總線實作 */
class SimpleEventBus implements PluginEventBus {
  private handlers = new Map<string, Set<(data: unknown) => void>>();

  on(event: string, handler: (data: unknown) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: (data: unknown) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, data: unknown): void {
    this.handlers.get(event)?.forEach((h) => {
      try { h(data); } catch (e) { console.error(`Event handler error for ${event}:`, e); }
    });
  }
}

/** Plugin Registry 實作 */
export class DefaultPluginRegistry implements PluginRegistry {
  private plugins = new Map<string, Plugin>();
  private enabled = new Set<string>();
  private services = new Map<string, PluginService>();
  private context: PluginContext;
  private loadOptions: Required<PluginLoadOptions>;

  constructor(options: PluginLoadOptions = {}) {
    this.loadOptions = {
      pluginDirs: options.pluginDirs ?? [],
      externalPrefixes: options.externalPrefixes ?? ["@askjo/", "@local-ai/"],
      autoLoad: options.autoLoad ?? true,
    };

    this.context = {
      dataDir: "",
      config: {},
      logger: new ConsoleLogger("plugin-registry"),
      events: new SimpleEventBus(),
      services: new Map(),
    };
  }

  /** 設定共享上下文 */
  setContext(context: Partial<PluginContext>): void {
    this.context = { ...this.context, ...context };
    // 更新所有已註冊 plugin 的 logger prefix
    for (const plugin of this.plugins.values()) {
      if (!plugin.core) {
        // 重新綁定 logger（簡化實作）
      }
    }
  }

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin ${plugin.id} already registered`);
    }
    // 驗證依賴
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new Error(`Plugin ${plugin.id} depends on missing plugin: ${dep}`);
        }
      }
    }
    this.plugins.set(plugin.id, plugin);
    this.context.logger.info(`Plugin registered: ${plugin.id} v${plugin.version}`);
    
    // 註冊服務
    if (plugin.services) {
      for (const svc of plugin.services) {
        this.services.set(svc.name, svc);
        this.context.services.set(svc.name, svc.instance);
      }
    }
  }

  unregister(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    if (plugin.core) {
      throw new Error(`Cannot unregister core plugin: ${pluginId}`);
    }
    // 檢查是否有其他 plugin 依賴它
    for (const p of this.plugins.values()) {
      if (p.dependencies?.includes(pluginId)) {
        throw new Error(`Plugin ${p.id} depends on ${pluginId}, unregister it first`);
      }
    }
    // 清理服務
    if (plugin.services) {
      for (const svc of plugin.services) {
        this.services.delete(svc.name);
        this.context.services.delete(svc.name);
      }
    }
    this.enabled.delete(pluginId);
    this.plugins.delete(pluginId);
    this.context.logger.info(`Plugin unregistered: ${pluginId}`);
    return true;
  }

  get(pluginId: string): Plugin | undefined {
    return this.plugins.get(pluginId);
  }

  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  async enable(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
    if (this.enabled.has(pluginId)) return;

    // 先啟用依賴
    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        await this.enable(dep);
      }
    }

    const logger = new ConsoleLogger(`plugin:${pluginId}`);
    const pluginContext: PluginContext = {
      ...this.context,
      logger,
      dataDir: `${this.context.dataDir}/plugins/${pluginId}`,
    };

    try {
      if (plugin.init) await plugin.init(pluginContext);
      if (plugin.start) await plugin.start(pluginContext);
      this.enabled.add(pluginId);
      this.context.logger.info(`Plugin enabled: ${pluginId}`);
      this.context.events.emit("plugin:enabled", { pluginId });
    } catch (e) {
      this.context.logger.error(`Failed to enable plugin ${pluginId}:`, { error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  async disable(pluginId: string): Promise<void> {
    if (!this.enabled.has(pluginId)) return;
    if (this.plugins.get(pluginId)?.core) {
      throw new Error(`Cannot disable core plugin: ${pluginId}`);
    }
    // 檢查反向依賴
    for (const p of this.plugins.values()) {
      if (p.dependencies?.includes(pluginId) && this.enabled.has(p.id)) {
        throw new Error(`Plugin ${p.id} depends on ${pluginId}, disable it first`);
      }
    }

    const plugin = this.plugins.get(pluginId)!;
    const logger = new ConsoleLogger(`plugin:${pluginId}`);
    const pluginContext: PluginContext = { ...this.context, logger };

    try {
      if (plugin.stop) await plugin.stop(pluginContext);
      if (plugin.shutdown) await plugin.shutdown(pluginContext);
      this.enabled.delete(pluginId);
      this.context.logger.info(`Plugin disabled: ${pluginId}`);
      this.context.events.emit("plugin:disabled", { pluginId });
    } catch (e) {
      this.context.logger.error(`Failed to disable plugin ${pluginId}:`, { error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  getService<T>(serviceName: string): T | undefined {
    return this.services.get(serviceName)?.instance as T | undefined;
  }

  listServices(): PluginService[] {
    return Array.from(this.services.values());
  }

  /** 載入外部 Plugin（npm 套件） */
  async loadExternal(packageName: string): Promise<Plugin> {
    const mod = await import(packageName);
    const plugin = mod.default || mod.plugin || mod;
    if (!plugin || !plugin.id) {
      throw new Error(`Invalid plugin export from ${packageName}`);
    }
    this.register(plugin);
    return plugin;
  }

  /** 從目錄載入本地 Plugin */
  async loadFromDirectory(dir: string): Promise<Plugin[]> {
    // 實作：掃描目錄、動態 import、驗證並註冊
    // 這裡簡化，實際需用 fs/promises + dynamic import
    return [];
  }

  /** 取得啟用狀態 */
  isEnabled(pluginId: string): boolean {
    return this.enabled.has(pluginId);
  }

  /** 拓撲排序啟用順序 */
  getLoadOrder(): Plugin[] {
    const visited = new Set<string>();
    const order: Plugin[] = [];

    const visit = (pluginId: string) => {
      if (visited.has(pluginId)) return;
      const plugin = this.plugins.get(pluginId);
      if (!plugin) return;
      
      if (plugin.dependencies) {
        for (const dep of plugin.dependencies) visit(dep);
      }
      visited.add(pluginId);
      order.push(plugin);
    };

    for (const plugin of this.plugins.values()) {
      visit(plugin.id);
    }
    return order;
  }
}

/** 建立預設 Registry */
export function createPluginRegistry(options?: PluginLoadOptions): DefaultPluginRegistry {
  return new DefaultPluginRegistry(options);
}