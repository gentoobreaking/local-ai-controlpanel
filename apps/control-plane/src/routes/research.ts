// Research Engine REST routes（Spec §11、§45.5）

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResearchEngine } from "../research/engine.js";

const ResearchQuerySchema = z.object({
  taskId: z.string().min(1),
  query: z.string().min(1),
  language: z.string().optional(),
  errorType: z.string().optional(),
  project: z.string().optional(),
  topK: z.number().int().positive().max(20).optional(),
  maxAgeDays: z.number().int().positive().max(365).optional(),
});

export interface ResearchRouteDeps {
  researchEngine: ResearchEngine;
}

export async function createResearchRouter(
  app: FastifyInstance,
  opts: { deps: ResearchRouteDeps },
): Promise<void> {
  const { researchEngine } = opts.deps;

  app.post("/api/v1/research", async (req, reply) => {
    const body = ResearchQuerySchema.parse(req.body);
    const result = await researchEngine.research(body);
    return result;
  });

  app.get("/api/v1/research/:taskId", async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    const { query, language, errorType, topK, maxAgeDays } = req.query as {
      query?: string;
      language?: string;
      errorType?: string;
      topK?: string;
      maxAgeDays?: string;
    };

    if (!query) {
      return reply.code(400).send({ error: "query parameter required" });
    }

    const result = await researchEngine.research({
      taskId,
      query,
      language,
      errorType,
      topK: topK ? parseInt(topK) : undefined,
      maxAgeDays: maxAgeDays ? parseInt(maxAgeDays) : undefined,
    });
    return result;
  });
}