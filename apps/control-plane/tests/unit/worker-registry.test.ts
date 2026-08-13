// T022 Worker Registry / Router 測試（spec §17）
// 覆蓋：
// - register / get / list
// - WorkerDescriptor v0.4 完整欄位
// - Router.select 依 ExecutionStrategy 回傳 worker
// - Phase 1–5 只註冊 pi-local
// - 未註冊 id 錯誤處理
// - allow_cloud / 非 local tier 拒絕

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkerRegistry,
  WorkerRouter,
  WorkerRegistryError,
  createDefaultWorkerRegistry,
} from "../../src/worker/registry.js";
import { PiWorker } from "../../src/worker/pi-worker.js";
import type { ExecutionStrategy } from "../../src/policy/types.js";

const LOCAL_STRATEGY: ExecutionStrategy = {
  strategy: "local_only",
  tier: "local",
  worker: "pi-local",
  model: "qwen2.5-coder:7b",
  allowCloud: false,
  maxAttempts: 3,
};

test("預設 registry：Phase 1–5 只註冊 pi-local（§17）", () => {
  const registry = createDefaultWorkerRegistry();
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, "pi-local");
  assert.equal(list[0]!.runtime, "pi");
  assert.equal(list[0]!.locality, "local");
  assert.equal(list[0]!.costClass, "free");
  assert.equal(list[0]!.enabled, true);
});

test("WorkerDescriptor v0.4 完整欄位（§17）", () => {
  const registry = createDefaultWorkerRegistry();
  const [d] = registry.list();
  assert.ok(d!.capabilities.includes("coding"));
  assert.ok(d!.models.includes("qwen2.5-coder:7b"));
  assert.equal(d!.supportsACP, true);
  assert.equal(d!.supportsMCP, true);
  assert.equal(typeof d!.id, "string");
  assert.equal(typeof d!.runtime, "string");
});

test("register / get / list 基本操作", () => {
  const registry = new WorkerRegistry();
  const worker = new PiWorker({ allowStub: true });
  registry.register(
    {
      id: "pi-local",
      runtime: "pi",
      capabilities: ["coding"],
      models: ["qwen2.5-coder:7b"],
      locality: "local",
      costClass: "free",
      supportsACP: true,
      supportsMCP: true,
      enabled: true,
    },
    worker,
  );
  assert.equal(registry.get("pi-local"), worker);
  assert.equal(registry.has("pi-local"), true);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.listEnabled().length, 1);
});

test("重複註冊同一 id 拋錯", () => {
  const registry = new WorkerRegistry();
  const w = new PiWorker({ allowStub: true });
  const desc = {
    id: "pi-local",
    runtime: "pi",
    capabilities: [],
    models: [],
    locality: "local" as const,
    costClass: "free" as const,
    supportsACP: true,
    supportsMCP: true,
    enabled: true,
  };
  registry.register(desc, w);
  assert.throws(() => registry.register(desc, w), WorkerRegistryError);
});

test("未註冊 id：get 拋 WorkerRegistryError（錯誤處理）", () => {
  const registry = createDefaultWorkerRegistry();
  assert.throws(() => registry.get("pi-remote"), WorkerRegistryError);
  assert.equal(registry.has("pi-remote"), false);
});

test("Router.select：依 ExecutionStrategy 回傳 pi-local（§17 Phase 1–5 單一結果）", () => {
  const registry = createDefaultWorkerRegistry();
  const router = new WorkerRouter(registry);
  const { worker, descriptor } = router.select({}, LOCAL_STRATEGY);
  assert.ok(worker instanceof PiWorker);
  assert.equal(descriptor.id, "pi-local");
});

test("Router.select：未指定 worker 時回傳第一個 enabled local worker", () => {
  const registry = createDefaultWorkerRegistry();
  const router = new WorkerRouter(registry);
  const { descriptor } = router.select({}, { ...LOCAL_STRATEGY, worker: "" });
  assert.equal(descriptor.id, "pi-local");
});

test("Router.select：allow_cloud=true 拒絕（Phase 1–5 硬性，§24）", () => {
  const registry = createDefaultWorkerRegistry();
  const router = new WorkerRouter(registry);
  assert.throws(
    () => router.select({}, { ...LOCAL_STRATEGY, allowCloud: true as boolean } as ExecutionStrategy),
    WorkerRegistryError,
  );
});

test("Router.select：非 local tier 拒絕", () => {
  const registry = createDefaultWorkerRegistry();
  const router = new WorkerRouter(registry);
  assert.throws(
    () =>
      router.select(
        {},
        { ...LOCAL_STRATEGY, tier: "cloud" as never },
      ),
    WorkerRegistryError,
  );
});

test("Router.select：strategy 指定未註冊 worker 拋錯", () => {
  const registry = createDefaultWorkerRegistry();
  const router = new WorkerRouter(registry);
  assert.throws(
    () => router.select({}, { ...LOCAL_STRATEGY, worker: "opencode-local" }),
    WorkerRegistryError,
  );
});

test("enabled=false 的 worker 不被 listEnabled 選中", () => {
  const registry = new WorkerRegistry();
  const w = new PiWorker({ allowStub: true });
  const mk = (id: string, enabled: boolean) => ({
    id,
    runtime: "pi",
    capabilities: [],
    models: ["qwen2.5-coder:7b"],
    locality: "local" as const,
    costClass: "free" as const,
    supportsACP: true,
    supportsMCP: true,
    enabled,
  });
  registry.register(mk("pi-local", true), w);
  registry.register(mk("pi-local-14b", false), w);
  const router = new WorkerRouter(registry);
  const { descriptor } = router.select({}, { ...LOCAL_STRATEGY, worker: "" });
  assert.equal(descriptor.id, "pi-local");
  assert.equal(registry.listEnabled().length, 1);
});
