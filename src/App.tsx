import { useState, useEffect, useCallback } from "react";
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
import { invoke } from "@tauri-apps/api/core";

export type Command =
  | { kind: "run"; input: string }
  | { kind: "select"; taskId: string }
  | { kind: "cancel" }
  | { kind: "verify"; taskId: string }
  | { kind: "research"; taskId: string }
  | { kind: "logs"; taskId: string }
  | { kind: "sandbox-check" }
  | { kind: "strategy"; taskId: string }
  | { kind: "help" };

export interface SandboxCheckResult {
  statuses: Record<string, boolean>;
  at: string;
}
// 預設工作目錄：可用 VITE_WORKSPACE 環境變數覆寫（僅支援 Vite 注入的變數）
const DEFAULT_WORKSPACE =
  import.meta.env.VITE_WORKSPACE ?? "/tmp";

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
  const [fontScale, setFontScale] = useState(1.0);
  const [apiError, setApiError] = useState<string | null>(null);

  const refreshTasks = useCallback(() => {
    listTasks()
      .then((data) => {
        setTasks(data);
        setApiError(null);
      })
      .catch((err) => {
        setTasks([]);
        setApiError(`無法連線 Control Plane: ${err.message}`);
      });
  }, []);

  // 基礎視窗尺寸（可依需求調整）
  const BASE_WIDTH = 1280;
  const BASE_HEIGHT = 800;

  // Zoom 控制：實際調整視窗大小
  const zoomIn = useCallback(async () => {
    setZoom((z) => {
      const newZoom = Math.min(2.0, z + 0.1);
      invoke("set_window_size", { width: BASE_WIDTH * newZoom, height: BASE_HEIGHT * newZoom }).catch(console.error);
      return newZoom;
    });
  }, []);
  const zoomOut = useCallback(async () => {
    setZoom((z) => {
      const newZoom = Math.max(0.5, z - 0.1);
      invoke("set_window_size", { width: BASE_WIDTH * newZoom, height: BASE_HEIGHT * newZoom }).catch(console.error);
      return newZoom;
    });
  }, []);
  const zoomReset = useCallback(async () => {
    setZoom(1.0);
    await invoke("set_window_size", { width: BASE_WIDTH, height: BASE_HEIGHT }).catch(console.error);
  }, []);

  // 字體縮放：CSS zoom 重排內容（WebKit 支援），不影響視窗大小
  const fontIn = useCallback(() => setFontScale((f) => Math.min(1.6, +(f + 0.1).toFixed(2))), []);
  const fontOut = useCallback(() => setFontScale((f) => Math.max(0.7, +(f - 0.1).toFixed(2))), []);
  const fontReset = useCallback(() => setFontScale(1.0), []);
  // Keyboard shortcuts for zoom / font / palette
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          if (e.shiftKey) fontIn(); else zoomIn();
        } else if (e.key === "-") {
          e.preventDefault();
          if (e.shiftKey) fontOut(); else zoomOut();
        } else if (e.key === "0") {
          e.preventDefault();
          if (e.shiftKey) fontReset(); else zoomReset();
        } else if (e.key === "k") {
          e.preventDefault();
          setPaletteOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomIn, zoomOut, zoomReset, fontIn, fontOut, fontReset]);
  useEffect(() => {
    refreshTasks();
    const t = setInterval(refreshTasks, 5000);
    return () => clearInterval(t);
  }, [refreshTasks]);

  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      setConnected(false);
      return;
    }
    setEvents([]);
    const unsubscribe = subscribeTaskEvents(
      selectedId,
      (e) => setEvents((prev) => [...prev, e]),
      setConnected,
    );
    return unsubscribe;
  }, [selectedId]);

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
          const task = await createTask(cmd.input, undefined, DEFAULT_WORKSPACE);
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
          await verifyTask(cmd.taskId, { workspace: DEFAULT_WORKSPACE });
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
          await verifyTask(cmd.taskId, { workspace: DEFAULT_WORKSPACE });
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
      case "help":
        setPaletteOpen(false);
        alert(
          "Agent Control Plane 快捷鍵與指令：\n\n" +
          "🎯 輸入框：\n" +
          "  Ctrl+K      打開命令面板\n" +
          "  ↑/↓         瀏覽輸入歷史\n" +
          "  Esc         清空輸入 / 取消執行\n" +
          "  Enter       執行任務\n\n" +
          "🔍 命令面板：\n" +
          "  help        顯示此幫助\n" +
          "  sandbox check  檢查沙箱後端\n" +
          "  select <id>    選取任務\n" +
          "  verify <id>    立即驗證任務\n" +
          "  research <id>  研究模式驗證\n" +
          "  strategy <id>  查看執行策略\n" +
          "  logs <id>      查看任務日誌\n\n" +
          "🔍 視窗縮放：\n" +
          "  Ctrl+= / Ctrl++  放大視窗\n" +
          "  Ctrl+-        縮小視窗\n" +
          "  Ctrl+0        重置視窗\n\n" +
          "🔤 字體大小：\n" +
          "  Ctrl+Shift+=  放大字體\n" +
          "  Ctrl+Shift+-  縮小字體\n" +
          "  Ctrl+Shift+0  重置字體\n\n" +
          "💡 提示：輸入自然語言任務描述，按 Enter 送出。\n" +
          "   範例：修復 login 頁面的 TypeScript 錯誤"
        );
        break;
      default:
        setPaletteOpen(false);
        refreshTasks();
    }
  };

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? null;
  return (
    <div className="app" style={{ zoom: fontScale }}>
      <TopBar
        selectedTask={selectedTask}
        sandboxStatus={sandboxCheck?.statuses ?? undefined}
      />
      {apiError && (
        <div className="api-error-banner">
          {apiError}
          <button onClick={refreshTasks} className="btn btn-small">重試</button>
        </div>
      )}
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
        <span className="zoom-label">視窗</span>
        <button className="zoom-btn" onClick={zoomOut} title="縮小視窗 (Ctrl+-)" aria-label="Zoom Out">−</button>
        <span className="zoom-level">{Math.round(zoom * 100)}%</span>
        <button className="zoom-btn" onClick={zoomIn} title="放大視窗 (Ctrl+=)" aria-label="Zoom In">+</button>
        <button className="zoom-btn" onClick={zoomReset} title="重置視窗 (Ctrl+0)" aria-label="Reset Zoom">⟲</button>
        <span className="zoom-sep">|</span>
        <span className="zoom-label">字體</span>
        <button className="zoom-btn" onClick={fontOut} title="縮小字體 (Ctrl+Shift+-)" aria-label="Font Out">A−</button>
        <span className="zoom-level">{Math.round(fontScale * 100)}%</span>
        <button className="zoom-btn" onClick={fontIn} title="放大字體 (Ctrl+Shift+=)" aria-label="Font In">A+</button>
        <button className="zoom-btn" onClick={fontReset} title="重置字體 (Ctrl+Shift+0)" aria-label="Reset Font">A⟲</button>
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
