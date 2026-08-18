// Evidence Gate REST routes（Spec §14、§45.5）

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EvidenceGate, GateInput } from "../evidence/gate-api.js";
import type { EvidenceSource } from "../evidence/types.js";

const GateInputSchema = z.object({
  evidence: z.array(z.object({
    type: z.enum(["documentation", "code_execution", "external_api", "memory", "style_kb"]),
    id: z.string(),
    title: z.string(),
    url: z.string().optional(),
    snippet: z.string(),
    fullContent: z.string().optional(),
    credibility: z.number().min(0).max(1),
    relevance: z.number().min(0).max(1),
    timeliness: z.number().min(0).max(1),
    score: z.number().min(0).max(1),
    accessedAt: z.string(),
    createdAt: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })),
  weights: z.object({
    documentation: z.number().positive().optional(),
    code_execution: z.number().positive().optional(),
    external_api: z.number().positive().optional(),
    memory: z.number().positive().optional(),
    style_kb: z.number().positive().optional(),
  }).optional(),
  thresholds: z.object({
    passThreshold: z.number().min(0).max(1).optional(),
    minEvidenceCount: z.number().int().positive().optional(),
    minSingleScore: z.number().min(0).max(1).optional(),
  }).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
});

export interface EvidenceGateRouteDeps {
  evidenceGate: EvidenceGate;
}

export async function createEvidenceGateRouter(
  app: FastifyInstance,
  opts: { deps: EvidenceGateRouteDeps },
): Promise<void> {
  const { evidenceGate } = opts.deps;

  app.post("/api/v1/evidence/gate", async (req, reply) => {
    const body = GateInputSchema.parse(req.body) as GateInput;
    const result = evidenceGate.evaluate(body);
    return result;
  });
}