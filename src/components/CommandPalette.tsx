import { useEffect, useMemo, useRef, useState, useCallback } from "react";
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
      { id: "help", label: "help", hint: "顯示所有快捷鍵與指令", command: { kind: "help" } },
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

  // 防止鍵盤事件衝突
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && entries[0]) {
      e.preventDefault();
      const entry = entries[cursor] ?? entries[0]!;
      onCommand(entry.command);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, entries.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Escape") {
      onClose();
    }
  }, [cursor, entries, onCommand, onClose]);

  // 確保點擊能正確觸發命令
  const run = useCallback((entry: Entry) => {
    onCommand(entry.command);
  }, [onCommand]);

  // 確保 entries 變化時 cursor 重置
  useEffect(() => {
    setCursor(0);
  }, [query, entries.length]);

  // 確保 entries 更新時 cursor 在範圍內
  useEffect(() => {
    if (cursor >= entries.length) {
      setCursor(Math.max(0, entries.length - 1));
    }
  }, [entries.length]);

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
              e.preventDefault();
              const entry = entries[cursor] ?? entries[0]!;
              onCommand(entry.command);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, entries.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <ul className="palette-list" ref={listRef}>
          {entries.map((e, i) => (
            <li
              key={e.id}
              className={`palette-item ${i === cursor ? "palette-item-active" : ""}`}
              onClick={() => onCommand(e.command)}
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
