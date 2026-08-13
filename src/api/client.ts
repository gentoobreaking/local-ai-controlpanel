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

export async function getSandboxStatus(): Promise<Record<string, boolean>> {
  const res = await fetch(`${cpBaseUrl}/api/v1/sandbox`);
  if (!res.ok) throw new Error(`getSandboxStatus ${res.status}`);
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
