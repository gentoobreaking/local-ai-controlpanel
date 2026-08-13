import type { TaskSummary } from "../api/client";

interface Props {
  tasks: TaskSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_CLASS: Record<string, string> = {
  COMPLETE: "st-pass",
  PASS: "st-pass",
  FAIL: "st-fail",
  RUNNING: "st-run",
  RESEARCHING: "st-run",
  VERIFYING: "st-run",
};

function statusClass(status: string): string {
  return STATUS_CLASS[status] ?? "st-idle";
}

export default function TaskList({ tasks, selectedId, onSelect }: Props) {
  return (
    <aside className="tasklist">
      <div className="tasklist-header">tasks</div>
      {tasks.length === 0 && <div className="tasklist-empty">no tasks</div>}
      <ul>
        {tasks.map((t) => (
          <li
            key={t.id}
            className={`task-item ${t.id === selectedId ? "task-item-active" : ""}`}
            onClick={() => onSelect(t.id)}
          >
            <span className={statusClass(t.status)}>{t.id}</span>
            <span className="task-item-title">{t.userRequest}</span>
            {t.attempt ? <span className="task-item-attempt">#{t.attempt}</span> : null}
          </li>
        ))}
      </ul>
    </aside>
  );
}
