import { useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
            if (e.key === "Enter" && entries[0]) onCommand(entries[0].command);
          }}
        />
        <ul className="palette-list">
          {entries.map((e) => (
            <li key={e.id} className="palette-item" onClick={() => onCommand(e.command)}>
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
