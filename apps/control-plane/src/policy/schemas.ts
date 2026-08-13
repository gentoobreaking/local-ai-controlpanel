// Policies/*.yaml 的 Zod schema（spec §10 範例 / §30）。
// T009 `acp policy validate` 與 T010 PolicyEngine 共用此定義。

import { z } from "zod";

const ResearchPolicySchema = z.object({
  enabled: z.boolean(),
  required_when: z.array(z.string()),
  minimum_sources: z.number().int().min(1),
  official_source_preferred: z.boolean().optional(),
  preferred_sources: z.array(z.string()).optional(),
  max_rounds: z.number().int().min(1).optional(),
  retrievers: z
    .object({
      repository: z.boolean().optional(),
      documentation: z.boolean().optional(),
      git_history: z.boolean().optional(),
      web: z.boolean().optional(),
    })
    .optional(),
});

const EvidencePolicySchema = z.object({
  max_tokens: z.number().int().positive().optional(),
  min_relevance: z.number().min(0).max(1).optional(),
  budget_percent: z.number().min(0).max(1).optional(),
});

const ArtifactPolicySchema = z.object({
  allowed: z.array(z.string()),
  readonly: z.array(z.string()),
  forbidden: z.array(z.string()),
});

const VerificationPolicySchema = z.object({
  required: z.array(z.enum(["unit_test", "lint", "build", "typecheck", "git_diff"])),
});

const RetryPolicySchema = z.object({
  enabled: z.boolean(),
  max_attempts: z.number().int().min(1),
  on: z
    .object({
      coding_error: z.enum(["retry", "research", "ask_user", "repair", "stop"]),
      knowledge_error: z.enum(["retry", "research", "ask_user", "repair", "stop"]),
      requirement_error: z.enum(["retry", "research", "ask_user", "repair", "stop"]),
      environment_error: z.enum(["retry", "research", "ask_user", "repair", "stop"]),
      tool_error: z.enum(["retry", "research", "ask_user", "repair", "stop"]),
      model_limitation: z.enum(["retry", "research", "ask_user", "repair", "stop", "stronger_model"]),
    })
    .optional(),
});

const ExecutionPolicySchema = z.object({
  strategy: z.enum(["local_first", "local_only", "hybrid"]),
  local: z.object({
    worker: z.string(),
    model: z.string(),
    max_attempts: z.number().int().min(1),
  }),
  allow_cloud: z.boolean(),
});

const PermissionsPolicySchema = z.object({
  filesystem: z.object({ read: z.boolean(), write: z.string() }).optional(),
  shell: z.object({ enabled: z.boolean(), sandbox: z.boolean() }).optional(),
  git: z.object({ read: z.boolean(), write: z.string() }).optional(),
  network: z.object({ enabled: z.boolean() }).optional(),
});

const SandboxPolicySchema = z.object({
  mode: z.enum(["auto", "bwrap", "seatbelt", "shuru", "docker"]),
  macos_default: z.enum(["seatbelt"]).optional(),
  linux_default: z.enum(["bwrap"]).optional(),
  bwrap: z
    .object({
      ro_bind: z.array(z.string()).optional(),
      bind: z.array(z.string()).optional(),
      unshare: z.object({ net: z.boolean(), ipc: z.boolean(), pid: z.boolean() }).optional(),
      cap_drop: z.string().optional(),
    })
    .optional(),
  seatbelt: z.object({ profile: z.string() }).optional(),
  shuru: z
    .object({
      image: z.string().optional(),
      memory: z.string().optional(),
      cpus: z.string().optional(),
      network: z.boolean().optional(),
      snapshot: z.boolean().optional(),
    })
    .optional(),
  docker: z.object({ image: z.string().optional(), network: z.boolean().optional() }).optional(),
});

const EscalationPolicySchema = z.object({
  enabled: z.boolean(),
  conditions: z.array(z.string()).optional(),
  target: z.object({ worker: z.string(), model: z.string() }).optional(),
  cloud: z.object({ mode: z.string() }).optional(),
});

// default.yaml — 完整政策（§10 範例）
export const DefaultPolicySchema = z.object({
  version: z.string(),
  execution: ExecutionPolicySchema,
  research: ResearchPolicySchema,
  evidence: EvidencePolicySchema.optional(),
  artifact: ArtifactPolicySchema.optional(),
  verification: VerificationPolicySchema.optional(),
  retry: RetryPolicySchema.optional(),
  permissions: PermissionsPolicySchema.optional(),
  sandbox: SandboxPolicySchema.optional(),
});

// 單一面向政策檔：只允許各自定義的 section，未知 section 視為寫錯
const ResearchFileSchema = z.object({ research: ResearchPolicySchema }).strict();
const CodingFileSchema = z
  .object({
    artifact: ArtifactPolicySchema,
    verification: VerificationPolicySchema,
    permissions: PermissionsPolicySchema.optional(),
  })
  .strict();
const SecurityFileSchema = z
  .object({
    securityLevel: z.string().optional(),
    permissions: PermissionsPolicySchema,
    sandbox: SandboxPolicySchema.optional(),
    escalation: EscalationPolicySchema.optional(),
  })
  .strict();
const EscalationFileSchema = z.object({ escalation: EscalationPolicySchema }).strict();
const SandboxFileSchema = z.object({ sandbox: SandboxPolicySchema }).strict();

export const PolicyFileSchemas = {
  default: DefaultPolicySchema,
  coding: CodingFileSchema,
  research: ResearchFileSchema,
  security: SecurityFileSchema,
  escalation: EscalationFileSchema,
  sandbox: SandboxFileSchema,
} as const;

export type DefaultPolicy = z.infer<typeof DefaultPolicySchema>;
export type CodingPolicy = z.infer<typeof CodingFileSchema>;
export type ResearchPolicyFile = z.infer<typeof ResearchFileSchema>;
export type SecurityPolicy = z.infer<typeof SecurityFileSchema>;
export type EscalationPolicy = z.infer<typeof EscalationFileSchema>;
export type SandboxPolicy = z.infer<typeof SandboxFileSchema>;
