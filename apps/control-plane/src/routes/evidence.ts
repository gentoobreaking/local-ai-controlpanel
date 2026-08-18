// Evidence REST routes（Spec §13、§45.5）

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EvidenceModel } from "../evidence/model.js";
import type { EvidenceQuery, EvidenceType } from "../evidence/types.js";

const EvidenceQuerySchema = z.object({
  taskId: z.string().min(1),
  query: z.string().min(1),
  types: z.array(z.enum(["documentation", "code_execution", "external_api", "memory", "style_kb"])).optional(),
  minScore: z.number().min(0).max(1).optional(),
  maxResults: z.number().int().positive().max(50).optional(),
});

export interface EvidenceRouteDeps {
  evidenceModel: EvidenceModel;
}

export async function createEvidenceRouter(
  app: FastifyInstance,
  opts: { deps: EvidenceRouteDeps },
): Promise<void> {
  const { evidenceModel } = opts.deps;

  app.post("/api/v1/evidence", async (req, reply) => {
    const body = EvidenceQuerySchema.parse(req.body);
    const result = await evidenceModel.collectEvidence(body);
    return result;
  });

  app.get("/api/v1/evidence/:taskId", async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    const { query, types, minScore, maxResults } = req.query as {
      query?: string;
      types?: string;
      minScore?: string;
      maxResults?: string;
    };

    if (!query) {
      return reply.code(400).send({ error: "query parameter required" });
    }

    const typeArray = types?.split(",") as EvidenceType[] | undefined;

    const result = await evidenceModel.collectEvidence({
      taskId,
      query,
      types: typeArray,
      minScore: minScore ? parseFloat(minScore) : undefined,
      maxResults: maxResults ? parseInt(maxResults) : undefined,
    });
    return result;
  });
}