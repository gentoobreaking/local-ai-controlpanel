// Evidence Gate Task-based REST routes（Spec §14、§45.5）
// 根據 taskId 獲取證據並執行 Gate 判斷

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EvidenceGate } from "../evidence/gate-api.js";
import type { EvidenceModel } from "../evidence/model.js";
import type { EvidenceQuery } from "../evidence/types.js";

const VerifyGateSchema = z.object({
  taskId: z.string().min(1),
  query: z.string().optional(),
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
  maxResults: z.number().int().positive().max(50).optional(),
});

export interface VerifyGateRouteDeps {
  evidenceGate: ReturnType<typeof import("../evidence/gate-api.js").createEvidenceGate>;
  evidenceModel: EvidenceModel;
}

export async function createVerifyGateRouter(
  app: FastifyInstance,
  opts: { deps: VerifyGateRouteDeps },
): Promise<void> {
  const { evidenceGate, evidenceModel } = opts.deps;

  app.post("/api/v1/evidence/verify-gate", async (req, reply) => {
    const body = VerifyGateSchema.parse(req.body);
    const { taskId, ...gateOpts } = body;

    // 1. 為任務收集證據
    const evidenceQuery: EvidenceQuery = {
      taskId,
      query: body.query ?? "",
      maxResults: body.maxResults ?? 20,
    };

    const evidenceResult = await evidenceModel.collectEvidence(evidenceQuery);

    // 2. 執行 Gate 判斷
    const gateResult = evidenceGate.evaluate({
      evidence: evidenceResult.evidence,
      weights: body.weights,
      thresholds: body.thresholds,
      risk: body.risk,
    });

    return {
      taskId,
      gate: gateResult,
      evidenceSummary: {
        totalEvidence: evidenceResult.evidence.length,
        totalScore: evidenceResult.totalScore,
        passed: evidenceResult.passed,
      },
    };
  });
}