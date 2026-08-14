// SSE 串流（spec §45.5：GET /api/v1/tasks/:id/events）。
// EventSource 格式：`data: {json}\n\n`（client 以 addEventListener("message") 讀取）。
// 重連時先 replay 目前階段快照，之後即時轉播。

import type { FastifyInstance } from "fastify";
import type { TaskBus } from "../events/bus.js";
import type { TaskRunner } from "../runner.js";

export async function createEventRouter(
  app: FastifyInstance,
  opts: { deps: { bus: TaskBus; runner: TaskRunner } },
): Promise<void> {
  const { bus, runner } = opts.deps;

  app.get("/api/v1/tasks/:id/events", (req, reply) => {
    const { id } = req.params as { id: string };
    reply.hijack();

    const res = reply.raw;
    // §45.3 + §45.6：SSE hijack 後 bypass cors plugin → 手動補 access-control-allow-origin
    // （origin: true 對應 reflect request Origin；Control Plane 只 bind loopback，攻擊面為零）
    const origin = req.headers.origin;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    });
    res.write("\n");

    const send = (data: unknown) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 重連快照：目前進行中的階段
    const stage = runner.getStage(id);
    if (stage) {
      send({ type: "stage", stage: stage.stage, attempt: stage.attempt, ts: new Date().toISOString() });
    }

    const unsubscribe = bus.on(id, send);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
