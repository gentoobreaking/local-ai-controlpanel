import { useEffect, useMemo, useRef, useState } from "react";
import type { StageEvent } from "../api/client";

interface Props {
  selectedId: string | null;
  events: StageEvent[];
  connected: boolean;
  running: boolean;
}

// ── Agentic 搜尋區塊：連續 search/tool 事件分組 + missing 收斂追蹤 ──

interface SearchEventView {
  round: number;
  maxRounds: number;
  query?: string;
  foundCount?: number;
  sources?: string[];
  evidence?: Array<{ title?: string; url?: string; snippet?: string }>;
  sufficient?: boolean;
  missing?: string[];
}

function isSearchRelated(e: StageEvent): boolean {
  return e.type === "search" || e.type === "tool_execution_start";
}

/** 把事件序列切成分段：一般事件原樣；連續 search 相關事件合成一個 block */
type Segment<T> = { kind: "single"; event: T; index: number } | { kind: "search"; events: SearchEventView[]; index: number };

function segmentEvents(events: StageEvent[]): Segment<StageEvent>[] {
  const segments: Segment<StageEvent>[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i]!;
    if (!isSearchRelated(e)) {
      segments.push({ kind: "single", event: e, index: i });
      i += 1;
      continue;
    }
    const group: SearchEventView[] = [];
    while (i < events.length && isSearchRelated(events[i]!)) {
      const cur = events[i]!;
      if (cur.type === "search") {
        group.push({
          round: cur.round,
          maxRounds: cur.maxRounds,
          query: cur.queries?.[0]?.query,
          foundCount: cur.foundCount,
          sources: cur.sources,
          evidence: cur.evidence,
          sufficient: cur.sufficient,
          missing: cur.missing,
        });
      } else if (group.length === 0) {
        // tool_execution_start 開頭而無 search 事件 → 不成組，原樣顯示
        break;
      }
      i += 1;
    }
    if (group.length > 0) {
      segments.push({ kind: "search", events: group, index: i - group.length });
    } else {
      segments.push({ kind: "single", event: cur0(events, i), index: i });
      i += 1;
    }
  }
  return segments;
}

// helper：避免上面 break 路徑的型別問題
function cur0(events: StageEvent[], i: number): StageEvent {
  return events[i]!;
}

/** missing 收斂追蹤：逐輪比對，標記 新增/持續/已解決 */
function trackMissing(rounds: SearchEventView[]): Array<{ round: number; items: Array<{ text: string; status: "new" | "open" | "resolved" }> }> {
  const result: Array<{ round: number; items: Array<{ text: string; status: "new" | "open" | "resolved" }> }> = [];
  let prev = new Set<string>();
  for (const r of rounds) {
    if (r.missing === undefined) continue;
    const curr = new Set(r.missing);
    const items: Array<{ text: string; status: "new" | "open" | "resolved" }> = [];
    for (const item of r.missing) {
      items.push({ text: item, status: prev.has(item) ? "open" : "new" });
    }
    for (const item of prev) {
      if (!curr.has(item)) items.push({ text: item, status: "resolved" });
    }
    // 已解決的排後面
    items.sort((a, b) => (a.status === "resolved" ? 1 : 0) - (b.status === "resolved" ? 1 : 0));
    result.push({ round: r.round, items });
    prev = curr;
  }
  return result;
}

function SearchBlock({ rounds }: { rounds: SearchEventView[] }) {
  const [expanded, setExpanded] = useState(false);
  const totalEvidence = rounds.reduce((sum, r) => sum + (r.foundCount ?? 0), 0);
  const allSources = [...new Set(rounds.flatMap((r) => r.sources ?? []))];
  const converged = rounds.some((r) => r.sufficient);
  const missingTrack = useMemo(() => trackMissing(rounds), [rounds]);
  const totalQueries = rounds.filter((r) => r.query).length;

  return (
    <div className="ev search-block">
      <div
        className="search-block-header"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
      >
        <span className="search-block-icon">{expanded ? "▾" : "▸"}</span>
        <span>
          🔍 agentic search · {rounds.length} eval / {totalQueries} queries ·{" "}
          {totalEvidence} evidence
          {allSources.length > 0 ? ` · ${allSources.join(", ")}` : ""}
          {converged ? " · ✓ converged" : ""}
        </span>
        {!expanded && <span className="search-block-hint">click to expand</span>}
      </div>

      {expanded && (
        <div className="search-block-body">
          {rounds.map((r, idx) => (
            <div key={idx} className="search-round">
              <div className="search-round-header">
                Round {r.round}/{r.maxRounds}
                {r.sufficient ? <span className="missing-tag resolved">✓ sufficient</span> : null}
              </div>
              {r.query ? (
                <div className="search-round-query">🔍 {r.query}</div>
              ) : null}
              {r.foundCount !== undefined ? (
                <div className="search-round-found">
                  📄 {r.foundCount} results{r.sources?.length ? ` (${r.sources.join(", ")})` : ""}
                </div>
              ) : null}
              {r.evidence?.length ? (
                <div className="evidence-list">
                  {r.evidence.map((e, j) => (
                    <div key={j} className="evidence-item">
                      <div className="evidence-title">
                        {e.url ? (
                          <a href={e.url} target="_blank" rel="noreferrer">
                            {e.title || e.url}
                          </a>
                        ) : (
                          e.title
                        )}
                      </div>
                      {e.snippet ? <div className="evidence-snippet">{e.snippet.slice(0, 200)}</div> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}

          {missingTrack.length > 0 && (
            <div className="missing-track">
              <div className="missing-track-header">缺口收斂</div>
              {missingTrack.map((m) => (
                <div key={m.round} className="missing-track-round">
                  <span className="missing-track-round-label">r{m.round}</span>
                  {m.items.map((it, j) => (
                    <span key={j} className={`missing-tag ${it.status}`}>
                      {it.status === "resolved" ? "− " : it.status === "new" ? "+ " : "= "}
                      {it.text}
                    </span>
                  ))}
                  {m.items.length === 0 && <span className="missing-tag resolved">✓ 無缺口</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 單一事件渲染（非搜尋類） ───────────────────────────────────────────

function renderEvent(event: StageEvent): { line: string; cls: string; output?: string } {
  switch (event.type) {
    case "stage":
      return { line: `${event.stage}${event.attempt ? ` (attempt ${event.attempt})` : ""}`, cls: "ev-stage" };
    case "evidence":
      return {
        line: `evidence → ${event.evidenceCount} facts${event.confidence != null ? ` (conf ${event.confidence})` : ""}`,
        cls: "ev-evidence",
      };
    case "verification":
      return {
        line: `verify → ${event.verifier} ${event.status}${event.sandbox ? ` [sandbox: ${event.sandbox}]` : ""}${event.durationMs != null ? ` ${event.durationMs}ms` : ""}`,
        cls: event.status === "PASS" ? "ev-pass" : "ev-fail",
        output: "output" in event ? event.output : undefined,
      };
    case "reflection":
      return {
        line: `reflection → ${event.classification ?? ""}${event.action ? ` (${event.action})` : ""}`,
        cls: "ev-reflection",
      };
    case "done":
      return { line: `done → ${event.status}`, cls: "ev-done" };
    default:
      return { line: "", cls: "ev-stage" };
  }
}

export default function TaskStream({ selectedId, events, connected, running }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  useEffect(() => {
    if (connected) {
      setReconnecting(false);
    } else if (selectedId) {
      setReconnecting(true);
    }
  }, [connected, selectedId]);

  const segments = useMemo(() => segmentEvents(events), [events]);

  return (
    <main className="stream">
      <div className="stream-header">
        <span>{selectedId ?? "—"}</span>
        <span className={connected ? "conn-ok" : reconnecting ? "conn-reconnecting" : "conn-bad"}>
          {connected ? "● connected" : reconnecting ? "⟳ reconnecting…" : "○ disconnected"}
        </span>
      </div>

      <div className="stream-body">
        {!selectedId && <div className="stream-empty">select a task from the left</div>}
        {selectedId && events.length === 0 && !connected && (
          <div className="stream-empty">connecting to event stream…</div>
        )}
        {selectedId && events.length === 0 && connected && (
          <div className="stream-empty">waiting for events…</div>
        )}
        {segments.map((seg) => {
          if (seg.kind === "search") {
            return <SearchBlock key={`sb-${seg.index}`} rounds={seg.events} />;
          }
          const { line, cls, output } = renderEvent(seg.event);
          return (
            <div key={seg.index} className={`ev ${cls}`}>
              {line}
              {output ? <pre className="ev-output">{output}</pre> : null}
            </div>
          );
        })}
        {running && <div className="ev ev-stage">▸ running…</div>}
        <div ref={endRef} />
      </div>
    </main>
  );
}
