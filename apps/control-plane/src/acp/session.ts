// ACP Session 管理（spec §19：create / resume / terminate / heartbeat）。
// 每個 session 有獨立的 event queue；resume 時從 lastAckSeq 之後 replay。

import { randomUUID } from "node:crypto";
import type { AcpEventBase } from "./protocol.js";

export interface AcpSession {
  id: string;
  clientName: string;
  clientVersion: string;
  createdAt: string;
  lastActiveAt: string;
  /** 已送出且未確認的最高 seq */
  lastSentSeq: number;
  /** client 已確認的最高 seq */
  lastAckSeq: number;
  /** 待 delivery 的事件（long-poll 時由 server 端 pop） */
  queue: AcpEventBase[];
  terminated: boolean;
}

export interface AcpSessionStore {
  create(clientName: string, clientVersion: string): AcpSession;
  get(id: string): AcpSession | undefined;
  resume(id: string): AcpSession | undefined;
  terminate(id: string): boolean;
  heartbeat(id: string): void;
  append(sessionId: string, event: AcpEventBase): void;
  /** 取出 session 的事件（至多 limit 筆） */
  drain(sessionId: string, limit: number): AcpEventBase[];
  ack(sessionId: string, seq: number): void;
  nextSeq(sessionId: string): number;
  list(): AcpSession[];
}

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 分鐘無心跳視為過期

export class AcpSessionManager implements AcpSessionStore {
  private readonly sessions = new Map<string, AcpSession>();

  create(clientName: string, clientVersion: string): AcpSession {
    const session: AcpSession = {
      id: randomUUID(),
      clientName,
      clientVersion,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastSentSeq: 0,
      lastAckSeq: 0,
      queue: [],
      terminated: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): AcpSession | undefined {
    return this.sessions.get(id);
  }

  resume(id: string): AcpSession | undefined {
    const session = this.sessions.get(id);
    if (!session || session.terminated) return undefined;
    session.lastActiveAt = new Date().toISOString();
    return session;
  }

  terminate(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.terminated = true;
    this.sessions.delete(id);
    return true;
  }

  heartbeat(id: string): void {
    const session = this.sessions.get(id);
    if (session && !session.terminated) {
      session.lastActiveAt = new Date().toISOString();
    }
  }

  append(sessionId: string, event: AcpEventBase): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.terminated) return;
    session.queue.push(event);
    session.lastSentSeq = event.seq;
  }

  drain(sessionId: string, limit: number): AcpEventBase[] {
    const session = this.sessions.get(sessionId);
    if (!session || session.terminated) return [];
    const events = session.queue.splice(0, limit);
    session.lastActiveAt = new Date().toISOString();
    return events;
  }

  ack(sessionId: string, seq: number): void {
    const session = this.sessions.get(sessionId);
    if (session && seq > session.lastAckSeq) {
      session.lastAckSeq = seq;
      session.lastActiveAt = new Date().toISOString();
    }
  }

  nextSeq(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    return session ? session.lastSentSeq + 1 : 1;
  }

  list(): AcpSession[] {
    return [...this.sessions.values()];
  }

  /** 清除過期 session（供定期 GC 呼叫）。 */
  reap(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - new Date(session.lastActiveAt).getTime() > SESSION_TTL_MS) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }
}