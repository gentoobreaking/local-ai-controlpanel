// ACP Client（spec §19）：連接外部 ACP Agent（HTTP 長輪詢傳輸）。
// 提供 handshake / poll / control / heartbeat / terminate。

import { ACP_VERSION } from "./protocol.js";
import type {
  AcpControl,
  AcpControlAck,
  AcpEventBase,
  AcpHelloAck,
  AcpTaskRequest,
  AcpTaskResponse,
} from "./protocol.js";

export interface AcpClientOptions {
  baseUrl: string;
  clientName?: string;
  clientVersion?: string;
  pollTimeoutMs?: number;
}

export class AcpClient {
  private readonly opts: AcpClientOptions;
  private sessionId?: string;
  private lastAckSeq = 0;

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
  }

  get session(): string | undefined {
    return this.sessionId;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.pollTimeoutMs ?? 30_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`acp http ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  }

  /** §19 handshake（可 resume 既有 session）。 */
  async connect(resumeSessionId?: string): Promise<AcpHelloAck> {
    const ack = (await this.post("/acp/session", {
      type: "hello",
      protocolVersion: ACP_VERSION,
      clientName: this.opts.clientName ?? "acp-mcp-client",
      clientVersion: this.opts.clientVersion ?? "0.6.0",
      sessionId: resumeSessionId,
    })) as AcpHelloAck;
    this.sessionId = ack.sessionId;
    this.lastAckSeq = (ack.nextSeq ?? 1) - 1;
    return ack;
  }

  /** 長輪詢事件（timeout 內無事件回傳空陣列）。 */
  async poll(limit?: number): Promise<AcpEventBase[]> {
    if (!this.sessionId) throw new Error("acp client 未連線");
    const res = (await this.post("/acp/poll", {
      sessionId: this.sessionId,
      ackSeq: this.lastAckSeq,
      ...(limit !== undefined ? { limit } : {}),
    })) as { events: AcpEventBase[] };
    for (const e of res.events) {
      if (e.seq > this.lastAckSeq) this.lastAckSeq = e.seq;
    }
    return res.events;
  }

  /** 發出控制指令。 */
  async control(ctrl: Omit<AcpControl, "id" | "type">, id = `ctrl-${Date.now()}`): Promise<AcpControlAck> {
    return (await this.post("/acp/control", {
      type: "control",
      id,
      ...ctrl,
    })) as AcpControlAck;
  }

  /** 委派任務給 Control Plane。 */
  async createTask(req: Omit<AcpTaskRequest, "type" | "id">, id = `req-${Date.now()}`): Promise<AcpTaskResponse> {
    return (await this.post("/acp/tasks", {
      type: "task_request",
      id,
      ...req,
    })) as AcpTaskResponse;
  }

  async heartbeat(): Promise<void> {
    if (!this.sessionId) throw new Error("acp client 未連線");
    await this.post("/acp/heartbeat", { sessionId: this.sessionId });
  }

  async terminate(): Promise<boolean> {
    if (!this.sessionId) throw new Error("acp client 未連線");
    const res = (await this.post("/acp/session/terminate", {
      sessionId: this.sessionId,
    })) as { terminated: boolean };
    return res.terminated;
  }
}