// Control Plane HTTP client.
// The Control Plane (Fastify) binds to 127.0.0.1 only (spec §45.3).
// Port is overridable via VITE_CP_PORT / VITE_CP_URL.

const DEFAULT_PORT = 3001;

export const cpBaseUrl =
  import.meta.env.VITE_CP_URL ?? `http://127.0.0.1:${import.meta.env.VITE_CP_PORT ?? DEFAULT_PORT}`;

export interface TaskSummary {
  id: string;
  userRequest: string;
  status: string;
  attempt?: number;
  sandboxMode?: string;
  updatedAt?: string;
}

export interface TaskDetail extends TaskSummary {
  evidence?: {
    count: number;
    confidence?: number;
  };
  verification?: {
    verifier?: string;
    status?: string;
    sandbox?: string;
    durationMs?: number;
  };
}

export type StageEvent =
  | { type: "stage"; stage: string; attempt?: number; ts: string }
  | {
      type: "evidence";
      evidenceCount: number;
      confidence?: number;
      ts: string;
    }
  | {
      type: "verification";
      verifier: string;
      status: string;
      sandbox?: string;
      durationMs?: number;
      output?: string;
      ts: string;
    }
  | {
      type: "reflection";
      classification?: string;
      action?: string;
      ts: string;
    }
  | { type: "done"; status: string; ts: string };

export async function listTasks(): Promise<TaskSummary[]> {
  const res = await fetch(`${cpBaseUrl}/api/v1/tasks`);
  if (!res.ok) throw new Error(`listTasks ${res.status}`);
  return res.json();
}

export async function getTask(id: string): Promise<TaskDetail> {
  const res = await fetch(`${cpBaseUrl}/api/v1/tasks/${id}`);
  if (!res.ok) throw new Error(`getTask ${res.status}`);
  return res.json();
}

export async function createTask(
  userRequest: string,
  sandboxMode?: string,
): Promise<TaskDetail> {
  const res = await fetch(`${cpBaseUrl}/api/v1/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userRequest, sandboxMode }),
  });
  if (!res.ok) throw new Error(`createTask ${res.status}`);
  return res.json();
}

export async function cancelTask(id: string): Promise<void> {
  const res = await fetch(`${cpBaseUrl}/api/v1/tasks/${id}/cancel`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`cancelTask ${res.status}`);
}

export interface VerifyResult {
  taskId: string;
  attempt: number;
  workspace: string;
  sandbox: string;
  results: Array<{
    verifier: string;
    status: string;
    sandbox?: string;
    durationMs?: number;
    output?: string;
  }>;
}

/** POST /api/v1/tasks/:id/verify（§45.5）— 立即驗證（可選 sandbox mode） */
export async function verifyTask(
  id: string,
  opts: { sandboxMode?: string } = {},
): Promise<VerifyResult> {
  const res = await fetch(`${cpBaseUrl}/api/v1/tasks/${id}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts.sandboxMode ? { sandboxMode: opts.sandboxMode } : {}),
  });
  if (!res.ok) throw new Error(`verifyTask ${res.status}`);
  return res.json();
}

export interface StrategyResult {
  strategy: string;
  allowCloud: boolean;
  worker: string;
}

/** GET /api/v1/strategy/:id（§24）— 策略查詢 */
export async function getStrategy(id: string): Promise<StrategyResult> {
  const res = await fetch(`${cpBaseUrl}/api/v1/strategy/${id}`);
  if (!res.ok) throw new Error(`getStrategy ${res.status}`);
  return res.json();
}

export interface LogsResult {
  taskId: string;
  attempts: Array<Record<string, unknown>>;
  verifications: Array<Record<string, unknown>>;
  reflections: Array<Record<string, unknown>>;
}

/** GET /api/v1/tasks/:id/logs（§29）— 嘗試/驗證/反思記錄 */
export async function getTaskLogs(id: string): Promise<LogsResult> {
  const res = await fetch(`${cpBaseUrl}/api/v1/tasks/${id}/logs`);
  if (!res.ok) throw new Error(`getTaskLogs ${res.status}`);
  return res.json();
}

export type SandboxStatus = Record<string, boolean>;

export async function getSandboxStatus(): Promise<SandboxStatus> {
  const res = await fetch(`${cpBaseUrl}/api/v1/sandbox`);
  if (!res.ok) throw new Error(`getSandboxStatus ${res.status}`);
  return res.json();
}

export interface ApproveResult {
  id: string;
  status: string;
  approved: boolean;
  actor: string;
}
/**
 * POST /api/v1/tasks/:id/approve（§45.5）。
 * kind：artifact / degraded / escalation / block（schemas 內 enum）。
 */
export async function approveTask(
  id: string,
  opts: { kind?: string; actor?: string; reason?: string } = {},
): Promise<ApproveResult> {
  const res = await fetch(`${cpBaseUrl}/api/v1/tasks/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: opts.kind ?? "block",
      actor: opts.actor ?? "ui",
      ...(opts.reason ? { reason: opts.reason } : {}),
    }),
  });
  if (!res.ok) throw new Error(`approveTask ${res.status}`);
  return res.json();
}

// SSE event stream for a task (§45.5). Reconnects automatically.
export function subscribeTaskEvents(
  id: string,
  onEvent: (event: StageEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`${cpBaseUrl}/api/v1/tasks/${id}/events`);

  source.addEventListener("message", (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as StageEvent);
    } catch {
      // ignore malformed frames
    }
  });

  source.onopen = () => onStatus(true);
  source.onerror = () => {
    onStatus(false);
    // EventSource auto-reconnects; no manual loop needed.
  };

  return () => source.close();
}
