// Plugin System 核心類型定義（Spec §Plugin）

/** Plugin 生命週期階段 */
export type PluginStage = "init" | "start" | "stop" | "health" | "shutdown";

/** Plugin 基本資訊 */
export interface PluginMetadata {
  /** 唯一識別碼 */
  id: string;
  /** 顯示名稱 */
  name: string;
  /** 版本 */
  version: string;
  /** 描述 */
  description: string;
  /** 作者 */
  author?: string;
  /** 依賴的其他 Plugin ID */
  dependencies?: string[];
  /** 是否為核心 Plugin（不可停用） */
  core?: boolean;
  /** 啟用順序（數字越小越早） */
  priority?: number;
}

/** Plugin 設定 Schema */
export interface PluginConfigSchema {
  [key: string]: {
    type: "string" | "number" | "boolean" | "object" | "array";
    description: string;
    required?: boolean;
    default?: unknown;
    enum?: unknown[];
  };
}

/** Plugin 執行上下文 */
export interface PluginContext {
  /** Plugin 專屬資料目錄 */
  dataDir: string;
  /** 共享配置 */
  config: Record<string, unknown>;
  /** 日誌器 */
  logger: PluginLogger;
  /** 事件總線 */
  events: PluginEventBus;
  /** 其他 Plugin 服務存取 */
  services: Map<string, unknown>;
}

/** Plugin 日誌介面 */
export interface PluginLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Plugin 事件總線 */
export interface PluginEventBus {
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
  emit(event: string, data: unknown): void;
}

/** Plugin 生命週期 Hook */
export interface PluginLifecycle {
  /** 初始化（同步/異步） */
  init?(context: PluginContext): Promise<void> | void;
  /** 啟動服務 */
  start?(context: PluginContext): Promise<void> | void;
  /** 停止服務 */
  stop?(context: PluginContext): Promise<void> | void;
  /** 健康檢查 */
  health?(context: PluginContext): Promise<PluginHealth> | PluginHealth;
  /** 完全關閉 */
  shutdown?(context: PluginContext): Promise<void> | void;
}

/** Plugin 健康狀態 */
export interface PluginHealth {
  status: "healthy" | "degraded" | "unhealthy";
  checks: Record<string, { status: "pass" | "fail" | "warn"; message?: string }>;
  timestamp: string;
}

/** Plugin 暴露的服務/工具 */
export interface PluginService {
  /** 服務名稱 */
  name: string;
  /** 服務類型 */
  type: "mcp" | "browser" | "api" | "tool" | "custom";
  /** 服務描述 */
  description: string;
  /** 服務實例 */
  instance: unknown;
}

/** 完整 Plugin 定義 */
export interface Plugin extends PluginMetadata, PluginLifecycle {
  /** 設定 Schema（用於驗證） */
  configSchema?: PluginConfigSchema;
  /** 預設設定 */
  defaultConfig?: Record<string, unknown>;
  /** 暴露的服務 */
  services?: PluginService[];
}

/** Plugin Registry 介面 */
export interface PluginRegistry {
  /** 註冊 Plugin */
  register(plugin: Plugin): void;
  /** 註銷 Plugin */
  unregister(pluginId: string): boolean;
  /** 取得 Plugin */
  get(pluginId: string): Plugin | undefined;
  /** 列出所有 Plugin */
  list(): Plugin[];
  /** 依 ID 啟用 */
  enable(pluginId: string): Promise<void>;
  /** 依 ID 停用 */
  disable(pluginId: string): Promise<void>;
  /** 取得服務 */
  getService<T>(serviceName: string): T | undefined;
  /** 列出所有服務 */
  listServices(): PluginService[];
}

/** Plugin 載入選項 */
export interface PluginLoadOptions {
  /** Plugin 目錄路徑 */
  pluginDirs?: string[];
  /** 外部 Plugin 套件名稱前綴 */
  externalPrefixes?: string[];
  /** 是否自動載入 */
  autoLoad?: boolean;
}