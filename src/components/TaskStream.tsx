import { useEffect, useRef } from "react";
import type { StageEvent } from "../api/client";

interface Props {
  selectedId: string | null;
  events: StageEvent[];
  connected: boolean;
  running: boolean;
}

function renderEvent(event: StageEvent): { line: string; cls: string } {
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
      };
    case "reflection":
      return {
        line: `reflection → ${event.classification ?? ""}${event.action ? ` (${event.action})` : ""}`,
        cls: "ev-reflection",
      };
    case "done":
      return { line: `done → ${event.status}`, cls: "ev-done" };
  }
}

export default function TaskStream({ selectedId, events, connected, running }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  return (
    <main className="stream">
      <div className="stream-header">
        <span>{selectedId ?? "—"}</span>
        <span className={connected ? "conn-ok" : "conn-bad"}>
          {connected ? "● connected" : "○ reconnecting"}
        </span>
      </div>

      <div className="stream-body">
        {!selectedId && <div className="stream-empty">select a task from the left</div>}
        {events.map((e, i) => {
          const { line, cls } = renderEvent(e);
          return (
            <div key={i} className={`ev ${cls}`}>
              {line}
              {"output" in e && e.output ? (
                <pre className="ev-output">{e.output}</pre>
              ) : null}
            </div>
          );
        })}
        {running && <div className="ev ev-stage">▸ running…</div>}
        <div ref={endRef} />
      </div>
    </main>
  );
}
