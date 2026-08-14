import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskSummary } from "../api/client";
import type { Command } from "../App";

interface Props {
  tasks: TaskSummary[];
  onCommand: (cmd: Command) => void;
  onClose: () => void;
}

interface Entry {
  id: string;
  label: string;
  hint?: string;
  command: Command;
}

export default function CommandPalette({ tasks, onCommand, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const base: Entry[] = [
      { id: "sandbox-check", label: "sandbox check", hint: "檢查 sandbox 後端狀態", command: { kind: "sandbox-check" } },
    ];
    for (const t of tasks) {
      base.push(
        { id: `select-${t.id}`, label: `select ${t.id}`, hint: t.userRequest, command: { kind: "select", taskId: t.id } },
        { id: `verify-${t.id}`, label: `verify ${t.id}`, command: { kind: "verify", taskId: t.id } },
        { id: `research-${t.id}`, label: `research ${t.id}`, command: { kind: "research", taskId: t.id } },
        { id: `strategy-${t.id}`, label: `strategy ${t.id}`, command: { kind: "strategy", taskId: t.id } },
        { id: `logs-${t.id}`, label: `logs ${t.id}`, command: { kind: "logs", taskId: t.id } },
      );
    }
    const q = query.trim().toLowerCase();
    return q ? base.filter((e) => e.label.toLowerCase().includes(q)) : base;
  }, [query, tasks]);

  // 方向鍵歷史：游標移動（§45.4）
  useEffect(() => {
    setCursor(0);
  }, [query, entries.length]);

  useEffect(() => {
    listRef.current?.querySelector(".palette-item-active")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = (entry: Entry) => {
    onCommand(entry.command);
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="指令…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && entries[0]) {
              run(entries[cursor] ?? entries[0]!);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, entries.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
          }}
        />
        <ul className="palette-list" ref={listRef}>
          {entries.map((e, i) => (
            <li
              key={e.id}
              className={`palette-item ${i === cursor ? "palette-item-active" : ""}`}
              onClick={() => run(e)}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="palette-label">{e.label}</span>
              {e.hint ? <span className="palette-hint">{e.hint}</span> : null}
            </li>
          ))}
          {entries.length === 0 && <li className="palette-empty">no matches</li>}
        </ul>
      </div>
    </div>
  );
}
