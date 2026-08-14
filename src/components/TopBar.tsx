import { useEffect, useState } from "react";
import { getSandboxStatus, type TaskSummary } from "../api/client";

const STATUS_COLOR: Record<string, string> = {
  bwrap: "badge badge-ok",
  seatbelt: "badge badge-ok",
  shuru: "badge badge-warn",
  docker: "badge badge-dim",
};

interface Props {
  selectedTask: TaskSummary | null;
  sandboxStatus?: Record<string, boolean>;
}

export default function TopBar({ selectedTask, sandboxStatus }: Props) {
  const [sandbox, setSandbox] = useState<Record<string, boolean>>({});

  // 首次掛載時探測（非 task 綁定的全域狀態）
  useEffect(() => {
    getSandboxStatus().then(setSandbox).catch(() => setSandbox({}));
  }, []);

  const backendStatus = sandboxStatus ?? sandbox;

  // §45.4：TopBar 顯示目前 task 的 sandbox mode badge
  const taskSandbox = selectedTask?.sandboxMode;

  return (
    <header className="topbar">
      <span className="topbar-title">Agent Control Plane</span>
      <span className="topbar-sep">·</span>
      <span className="topbar-meta">worker: pi-local</span>
      <span className="topbar-meta">model: qwen-9b</span>
      {taskSandbox && (
        <span className={STATUS_COLOR[taskSandbox] ?? "badge badge-dim"}>
          sandbox: {taskSandbox}
        </span>
      )}
      {!taskSandbox &&
        Object.entries(backendStatus)
          .filter(([, ok]) => ok)
          .map(([name]) => (
            <span key={name} className={STATUS_COLOR[name] ?? "badge badge-dim"}>
              sandbox: {name}
            </span>
          ))}
    </header>
  );
}
