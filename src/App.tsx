import { useState, useEffect, useCallback, useRef } from "react";
import TopBar from "./components/TopBar";
import TaskList from "./components/TaskList";
import TaskStream from "./components/TaskStream";
import InputBar from "./components/InputBar";
import CommandPalette from "./components/CommandPalette";
import ApproveDialog from "./components/ApproveDialog";
import {
  createTask,
  listTasks,
  subscribeTaskEvents,
  getSandboxStatus,
  approveTask,
  verifyTask,
  type StageEvent,
  type TaskSummary,
} from "./api/client";

export type Command =
  | { kind: "run"; input: string }
  | { kind: "select"; taskId: string }
  | { kind: "cancel" }
  | { kind: "verify"; taskId: string }
  | { kind: "research"; taskId: string }
  | { kind: "logs"; taskId: string }
  | { kind: "sandbox-check" }
  | { kind: "strategy"; taskId: string };

export interface SandboxCheckResult {
  statuses: Record<string, boolean>;
  at: string;
}

export default function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<StageEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [approvePending, setApprovePending] = useState(false);
  const [sandboxCheck, setSandboxCheck] = useState<SandboxCheckResult | null>(null);
  const [zoom, setZoom] = useState(1.0);

  const refreshTasks = useCallback(() => {
    listTasks().then(setTasks).catch(() => setTasks([]));
  }, []);

  // Zoom controls
  const zoomIn = useCallback(() => setZoom((z) => Math.min(2.0, z + 0.1)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(0.5, z - 0.1)), []);
  const zoomReset = useCallback(() => setZoom(1.0), []);

  useEffect(() => {
    refreshTasks();
    const t = setInterval(refreshTasks, 5000);
    return () => clearInterval(t);
  }, [refreshTasks]);

  useEffect(() => {
    if (!selectedId) return;
    setEvents([]);
    const unsubscribe = subscribeTaskEvents(
      selectedId,
      (e) => setEvents((prev) => [...prev, e]),
      setConnected,
    );
    refreshTasks();
    return unsubscribe;
  }, [selectedId, refreshTasks]);

  // §45.5：approve 流程 — task 進入 ASK_USER 時跳出 approve dialog
  useEffect(() => {
    if (!selectedId) return;
    const selected = tasks.find((t) => t.id === selectedId);
    if (selected?.status === "ASK_USER") {
      setApprovePending(true);
    }
  }, [tasks, selectedId]);

  const handleApprove = async (opts: { kind: string; reason?: string }) => {
    if (!selectedId) return;
    try {
      await approveTask(selectedId, opts);
    } catch {
      // Control Plane unreachable; dialog stays for retry
      return;
    }
    setApprovePending(false);
    refreshTasks();
  };

  const handleSandboxCheck = async () => {
    const statuses = await getSandboxStatus();
    setSandboxCheck({ statuses, at: new Date().toISOString() });
    setPaletteOpen(false);
    refreshTasks();
  };

  const handleCommand = async (cmd: Command) => {
    switch (cmd.kind) {
      case "run":
        setPaletteOpen(false);
        setRunning(true);
        try {
          const task = await createTask(cmd.input);
          setSelectedId(task.id);
          refreshTasks();
        } catch {
          // Control Plane unreachable; keep running=false on failure
        } finally {
          setRunning(false);
        }
        break;
      case "sandbox-check":
        try {
          await handleSandboxCheck();
        } catch {
          setPaletteOpen(false);
        }
        break;
      case "select":
        setSelectedId(cmd.taskId);
        setPaletteOpen(false);
        break;
      case "cancel":
        setRunning(false);
        setPaletteOpen(false);
        refreshTasks();
        break;
      case "verify":
        setSelectedId(cmd.taskId);
        setPaletteOpen(false);
        try {
          await verifyTask(cmd.taskId);
          refreshTasks();
        } catch {
          // verify failed; keep selection so user sees logs
        }
        break;
      case "research":
        // research 為立即驗證（research OFF 對照）— 先選中再驗證
        setSelectedId(cmd.taskId);
        setPaletteOpen(false);
        try {
          await verifyTask(cmd.taskId);
          refreshTasks();
        } catch {
          // keep selection on failure
        }
        break;
      case "strategy":
      case "logs":
        setSelectedId(cmd.taskId);
        setPaletteOpen(false);
        refreshTasks();
        break;
      default:
        setPaletteOpen(false);
        refreshTasks();
    }
  };

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="app" style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}>
      <TopBar
        selectedTask={selectedTask}
        sandboxStatus={sandboxCheck?.statuses ?? undefined}
      />
      <div className="app-body">
        <TaskList
          tasks={tasks}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
        />
        <TaskStream
          selectedId={selectedId}
          events={events}
          connected={connected}
          running={running}
        />
      </div>
      {sandboxCheck && (
        <SandboxCheckPanel
          result={sandboxCheck}
          onClose={() => setSandboxCheck(null)}
        />
      )}
      <InputBar
        onRun={(input) => handleCommand({ kind: "run", input })}
        onCancel={() => handleCommand({ kind: "cancel" })}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <div className="zoom-controls">
        <button className="zoom-btn" onClick={zoomOut} title="Zoom Out (Ctrl+-)" aria-label="Zoom Out">−</button>
        <span className="zoom-level">{Math.round(zoom * 100)}%</span>
        <button className="zoom-btn" onClick={zoomIn} title="Zoom In (Ctrl+=)" aria-label="Zoom In">+</button>
        <button className="zoom-btn" onClick={zoomReset} title="Reset Zoom (Ctrl+0)" aria-label="Reset Zoom">⟲</button>
      </div>
      {paletteOpen && (
        <CommandPalette
          tasks={tasks}
          onCommand={handleCommand}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {approvePending && selectedTask && (
        <ApproveDialog
          task={selectedTask}
          onApprove={handleApprove}
          onReject={() => setApprovePending(false)}
        />
      )}
    </div>
  );
}

function SandboxCheckPanel({
  result,
  onClose,
}: {
  result: SandboxCheckResult;
  onClose: () => void;
}) {
  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input sb-title">sandbox 探測</div>
        <ul className="palette-list">
          {Object.entries(result.statuses).map(([name, ok]) => (
            <li key={name} className="palette-item">
              <span className="palette-label">{name}</span>
              <span className={ok ? "sb-ok" : "sb-bad"}>
                {ok ? "可用" : "不可用"}
              </span>
            </li>
          ))}
        </ul>
        <div className="sb-footer">{new Date(result.at).toLocaleTimeString()}</div>
      </div>
    </div>
  );
}
