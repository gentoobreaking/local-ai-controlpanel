// Control Plane HTTP client（acp CLI 統一經由 REST/SSE 存取，§29 / §31.2）。

export interface CliHttpError extends Error {
  status: number;
  body: unknown;
}

export interface TaskDetailCli {
  id: string;
  status: string;
  attempt: number;
  sandboxMode: string | null;
  evidence?: { count: number; confidence?: number };
  verification?: { verifier: string; status: string; sandbox?: string; durationMs?: number };
  [key: string]: unknown;
}

export class ApiClient {
  constructor(
    public readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!res.ok) {
      const err = new Error(
        `HTTP ${res.status}: ${JSON.stringify(payload)}`,
      ) as CliHttpError;
      err.status = res.status;
      err.body = payload;
      throw err;
    }
    return payload as T;
  }

  /** 原始串流 request（SSE 用）；不進行 JSON 解析。 */
  stream(path: string, opts: { signal?: AbortSignal } = {}) {
    return this.fetchFn(`${this.baseUrl}${path}`, { method: "GET", signal: opts.signal });
  }

  createTask(input: { userRequest: string; workspace?: string; sandboxMode?: string }) {
    return this.request<TaskDetailCli>("POST", "/api/v1/tasks", input);
  }

  getTask(id: string) {
    return this.request<TaskDetailCli>("GET", `/api/v1/tasks/${id}`);
  }

  listTasks() {
    return this.request<TaskDetailCli[]>("GET", "/api/v1/tasks");
  }

  cancelTask(id: string) {
    return this.request<{ id: string; status: string }>("POST", `/api/v1/tasks/${id}/cancel`);
  }

  approveTask(id: string, body: { kind?: string; actor?: string; reason?: string } = {}) {
    return this.request<{ id: string; status: string; approved: boolean; actor: string }>(
      "POST",
      `/api/v1/tasks/${id}/approve`,
      body,
    );
  }

  retryTask(id: string) {
    return this.request<{ id: string; status: string; retried: boolean }>(
      "POST",
      `/api/v1/tasks/${id}/retry`,
    );
  }

  getPatches(id: string) {
    return this.request<{
      taskId: string;
      patches: Array<{
        id: string;
        attempt: number;
        path: string;
        status: string;
        workspace_dir: string | null;
        created_at: string;
      }>;
    }>("GET", `/api/v1/tasks/${id}/patches`);
  }

  workerPing() {
    return this.request<{
      ok: boolean;
      baseUrl: string;
      model: string;
      latencyMs?: number;
      detail?: string;
    }>("GET", "/api/v1/worker/ping");
  }

  workerModels() {
    return this.request<{
      baseUrl: string;
      defaultModel: string;
      registered: Array<{ worker: string; runtime: string; models: string[]; enabled: boolean }>;
      server: Array<{ id: string; object: string }> | null;
    }>("GET", "/api/v1/worker/models");
  }

  dbExport(table?: string) {
    const qs = table ? `?table=${encodeURIComponent(table)}` : "";
    return this.request<{
      exportedAt: string;
      tables: Record<string, Array<Record<string, unknown>>>;
    }>("GET", `/api/v1/db/export${qs}`);
  }

  getStrategy(id: string) {
    return this.request<Record<string, unknown>>("GET", `/api/v1/strategy/${id}`);
  }

  checkSandbox() {
    return this.request<Record<string, unknown>>("GET", "/api/v1/sandbox");
  }

  listWorkers() {
    return this.request<{ workers: Record<string, unknown>[] }>("GET", "/api/v1/workers");
  }

  validatePolicy() {
    return this.request<Record<string, unknown>>("GET", "/api/v1/policy/validate");
  }

  verifyTask(id: string, opts: { sandboxMode?: string } = {}) {
    return this.request<Record<string, unknown>>("POST", `/api/v1/tasks/${id}/verify`, opts);
  }

  getLogs(id: string) {
    return this.request<{ taskId: string; attempts: unknown[]; verifications: unknown[]; reflections: unknown[] }>(
      "GET",
      `/api/v1/tasks/${id}/logs`,
    );
  }
}