// SandboxRegistry（spec §21.1，Strategy Pattern：register / get）。
// 預設註冊 bwrap / seatbelt / shuru / docker 四種後端。

import type { Sandbox } from "./types.js";
import { createStubSandbox } from "./adapters.js";
import { createSeatbeltSandbox } from "./seatbelt.js";
import { createBwrapSandbox } from "./bwrap.js";

export class SandboxRegistry {
  private factories = new Map<string, () => Sandbox>();
  private instances = new Map<string, Sandbox>();

  register(name: string, factory: () => Sandbox): void {
    this.factories.set(name, factory);
    this.instances.delete(name);
  }

  get(name: string): Sandbox | undefined {
    if (!this.factories.has(name)) return undefined;
    let sb = this.instances.get(name);
    if (!sb) {
      sb = this.factories.get(name)!();
      this.instances.set(name, sb);
    }
    return sb;
  }

  names(): string[] {
    return [...this.factories.keys()];
  }
}

export interface DefaultRegistryConfig {
  /** seatbelt profile 路徑（§30 verification.sandbox.seatbelt.profile；預設 repo sandbox-profiles/verification-default.sb） */
  seatbeltProfile?: string;
}

/** 預設註冊四種後端（§21.1；bwrap/shuru 實作於 T014/T015） */
export function createDefaultRegistry(config: DefaultRegistryConfig = {}): SandboxRegistry {
  const registry = new SandboxRegistry();
  registry.register("bwrap", () => createBwrapSandbox());
  registry.register("seatbelt", () =>
    config.seatbeltProfile
      ? createSeatbeltSandbox(config.seatbeltProfile)
      : createStubSandbox("seatbelt"),
  );
  registry.register("shuru", () => createStubSandbox("shuru"));
  registry.register("docker", () => createStubSandbox("docker"));
  return registry;
}
