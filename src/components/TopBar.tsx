import { useEffect, useState } from "react";
import { getSandboxStatus, listWorkers, type TaskSummary, type WorkerInfo } from "../api/client";

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
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);

  // 首次掛載時探測（非 task 綁定的全域狀態）
  useEffect(() => {
    getSandboxStatus().then(setSandbox).catch(() => setSandbox({}));
    listWorkers().then(setWorkers).catch(() => setWorkers([]));
  }, []);

  const backendStatus = sandboxStatus ?? sandbox;

  // §45.4：TopBar 顯示目前 task 的 sandbox mode badge
  const taskSandbox = selectedTask?.sandboxMode;
  // 第一個 enabled worker 為目前預設 worker（Phase 1–5 只有 pi-local）
  const activeWorker = workers.find((w) => w.enabled) ?? workers[0];

  return (
    <header className="topbar">
      <span className="topbar-title">Agent Control Plane</span>
      <span className="topbar-sep">·</span>
      <span className="topbar-meta">worker: {activeWorker?.id ?? "—"}</span>
      <span className="topbar-meta">model: {activeWorker?.model ?? "—"}</span>
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
