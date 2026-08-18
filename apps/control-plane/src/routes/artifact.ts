// Artifact Controller REST routes（Spec §20）

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ArtifactController, canonicalizeDiff } from "../artifact/controller.js";

const CanonicalizeDiffSchema = z.object({
  diff: z.string().min(1),
  workspaceDir: z.string().min(1),
});

export interface ArtifactRouteDeps {
  artifactController: ArtifactController;
}

export async function createArtifactRouter(
  app: FastifyInstance,
  opts: { deps: ArtifactRouteDeps },
): Promise<void> {
  const { artifactController } = opts.deps;

  app.post("/api/v1/artifact/canonicalize", async (req, reply) => {
    const body = CanonicalizeDiffSchema.parse(req.body);
    // canonicalizeDiff is a standalone exported function
    const { canonicalizeDiff } = await import("../artifact/controller.js");
    const canonical = await canonicalizeDiff(body.diff, body.workspaceDir);
    return { canonicalDiff: canonical };
  });
}