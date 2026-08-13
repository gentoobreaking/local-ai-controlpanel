// Worker Registry / Router（spec §17）。
// Phase 1–5 只註冊 `pi-local` 一個 worker（§17「Phase 1–5 期間只回傳一個結果」）；
// v0.4 的多 worker 清單僅為 schema 預留（enabled 由 Policy 決定）。

import type { CodingWorker } from "./types.js";
import { PiWorker } from "./pi-worker.js";
import type { ExecutionStrategy } from "../policy/types.js";

/**
 * WorkerDescriptor（§17）— v0.4 完整欄位。
 * Worker / Model / Execution Tier 三者分離（§25.3、Rule 7）。
 */
export interface WorkerDescriptor {
  id: string;
  /** Runtime（pi / opencode / goose…）。 */
  runtime: string;
  /** 能力清單（coding / testing / planning…）。 */
  capabilities: string[];
  /** 支援的模型（9B / 14B / cloud-model…）。 */
  models: string[];
  /** local | remote（§17）。 */
  locality: "local" | "remote";
  /** free | low | high（v0.4）。 */
  costClass: "free" | "low" | "high";
  /** 支援 ACP-Protocol（Control Plane ↔ Agent Runtime）。 */
  supportsACP: boolean;
  /** 支援 MCP（Agent ↔ Tools/Resources）。 */
  supportsMCP: boolean;
  /** 啟用與否由 Policy 決定（§17 v0.4 預先登錄）。 */
  enabled: boolean;
}

export class WorkerRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerRegistryError";
  }
}

/** WorkerRegistry（§17）：register / get / list。 */
export class WorkerRegistry {
  private workers = new Map<string, CodingWorker>();
  private descriptors = new Map<string, WorkerDescriptor>();

  register(descriptor: WorkerDescriptor, worker: CodingWorker): void {
    if (this.descriptors.has(descriptor.id)) {
      throw new WorkerRegistryError(`worker already registered: ${descriptor.id}`);
    }
    this.descriptors.set(descriptor.id, descriptor);
    this.workers.set(descriptor.id, worker);
  }

  /** 取 worker；未註冊拋錯（測試：未註冊 id 錯誤處理）。 */
  get(workerId: string): CodingWorker {
    const w = this.workers.get(workerId);
    if (!w) {
      throw new WorkerRegistryError(`worker not registered: ${workerId}`);
    }
    return w;
  }

  has(workerId: string): boolean {
    return this.workers.has(workerId);
  }

  list(): WorkerDescriptor[] {
    return [...this.descriptors.values()];
  }

  /** 列出已註冊且 enabled 的 descriptor（供 router 選派）。 */
  listEnabled(): WorkerDescriptor[] {
    return this.list().filter((d) => d.enabled);
  }
}

export interface WorkerSelection {
  worker: CodingWorker;
  descriptor: WorkerDescriptor;
}

/** WorkerRouter（§17）：select(task, strategy) → worker。 */
export class WorkerRouter {
  constructor(private readonly registry: WorkerRegistry) {}

  /**
   * 依 ExecutionStrategy 選派 worker。
   * Phase 1–5：strategy.tier 必須是 local，且只回傳 pi-local（單一結果，§17）。
   * strategy.worker 指定時優先；否則回傳第一個 enabled local worker。
   */
  select(_task: unknown, strategy: ExecutionStrategy): WorkerSelection {
    if (strategy.allowCloud) {
      throw new WorkerRegistryError(
        "Phase 1–5 禁止 cloud worker（§24）：allow_cloud 必須為 false",
      );
    }
    if (strategy.tier !== "local") {
      throw new WorkerRegistryError(
        `Phase 1–5 只支援 local tier，收到: ${strategy.tier}`,
      );
    }

    // 策略指定 worker id → 必須存在且 enabled
    if (strategy.worker) {
      const desc = this.registry
        .list()
        .find((d) => d.id === strategy.worker);
      if (!desc) {
        throw new WorkerRegistryError(
          `strategy 指定的 worker 未註冊: ${strategy.worker}`,
        );
      }
      if (!desc.enabled) {
        throw new WorkerRegistryError(
          `strategy 指定的 worker 未啟用: ${strategy.worker}`,
        );
      }
      return { worker: this.registry.get(strategy.worker), descriptor: desc };
    }

    // 未指定 → 第一個 enabled local worker（Phase 1–5 只有 pi-local）
    const enabled = this.registry.listEnabled();
    if (enabled.length === 0) {
      throw new WorkerRegistryError("no enabled worker registered");
    }
    const first = enabled[0]!;
    return { worker: this.registry.get(first.id), descriptor: first };
  }
}

/**
 * 建立預設 registry：Phase 1–5 只註冊 pi-local（§17）。
 * qwen-9b、tier: local、enabled（對應 policies/default.yaml execution.local）。
 */
export function createDefaultWorkerRegistry(): WorkerRegistry {
  const registry = new WorkerRegistry();
  // pi-local descriptor（v0.4 schema 完整欄位）
  // PiWorker 為 lazy：initialize(context) 時才探測 llama.cpp（baseUrl/model 由 policy/config 指定）
  registry.register(
    {
      id: "pi-local",
      runtime: "pi",
      capabilities: ["coding", "testing"],
      models: ["qwen-9b"],
      locality: "local",
      costClass: "free",
      supportsACP: true,
      supportsMCP: true,
      enabled: true,
    },
    new PiWorker(),
  );
  return registry;
}
