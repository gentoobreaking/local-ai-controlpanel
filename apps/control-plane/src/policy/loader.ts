// Policies YAML 載入器：讀取 policies/*.yaml、以 Zod schema 驗證，產出驗證報告。
// 啟動時 default.yaml 無效 → throw（fail fast）；其餘無效 → 記入 report，
// `acp policy validate` 可檢視（§10 / §30）。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  PolicyFileSchemas,
  type CodingPolicy,
  type DefaultPolicy,
  type EscalationPolicy,
  type ResearchPolicyFile,
  type SandboxPolicy,
  type SecurityPolicy,
} from "./schemas.js";

export interface PolicyReportEntry {
  name: string;
  valid: boolean;
  errors: string[];
}

export interface LoadedPolicies {
  dir: string;
  defaultPolicy: DefaultPolicy;
  coding?: CodingPolicy;
  researchFile?: ResearchPolicyFile;
  security?: SecurityPolicy;
  escalation?: EscalationPolicy;
  sandbox?: SandboxPolicy;
  kubernetes?: unknown;
  report: PolicyReportEntry[];
}

export function loadPolicies(policiesDir: string): LoadedPolicies {
  const entries = readdirSync(policiesDir).filter((f) => f.endsWith(".yaml"));
  const report: PolicyReportEntry[] = [];
  const loaded: Partial<LoadedPolicies> = { dir: policiesDir, report };

  for (const file of entries) {
    const name = file.replace(/\.yaml$/, "");
    const filename = join(policiesDir, file);
    const yaml = readFileSync(filename, "utf8");
    const raw = parseYaml(yaml);
    const schema = PolicyFileSchemas[name as keyof typeof PolicyFileSchemas];
    const entry: PolicyReportEntry = { name, valid: true, errors: [] };
    if (!schema) {
      // kubernetes.yaml 等尚未定義 schema 的檔案：只做語法檢查
      entry.valid = true;
      entry.errors = ["（未定義 schema，僅語法檢查）"];
      if (name === "kubernetes") loaded.kubernetes = raw;
      report.push(entry);
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      entry.valid = false;
      entry.errors = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      );
    } else {
      switch (name) {
        case "default":
          loaded.defaultPolicy = parsed.data as DefaultPolicy;
          break;
        case "coding":
          loaded.coding = parsed.data as CodingPolicy;
          break;
        case "research":
          loaded.researchFile = parsed.data as ResearchPolicyFile;
          break;
        case "security":
          loaded.security = parsed.data as SecurityPolicy;
          break;
        case "escalation":
          loaded.escalation = parsed.data as EscalationPolicy;
          break;
        case "sandbox":
          loaded.sandbox = parsed.data as SandboxPolicy;
          break;
      }
    }
    report.push(entry);
  }

  if (!loaded.defaultPolicy) {
    throw new Error(
      `policies/default.yaml 載入失敗或缺失：${JSON.stringify(report)}`,
    );
  }
  const invalid = report.filter((r) => !r.valid);
  if (invalid.length > 0) {
    throw new Error(
      `政策檔案驗證失敗（fail fast，§30）：${invalid
        .map((i) => `${i.name}: ${i.errors.join("; ")}`)
        .join(" | ")}`,
    );
  }
  return loaded as LoadedPolicies;
}