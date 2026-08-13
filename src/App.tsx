import { useState, useEffect } from "react";
import TopBar from "./components/TopBar";
import TaskList from "./components/TaskList";
import TaskStream from "./components/TaskStream";
import InputBar from "./components/InputBar";
import CommandPalette from "./components/CommandPalette";
import {
  createTask,
  listTasks,
  subscribeTaskEvents,
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

export default function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<StageEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [running, setRunning] = useState(false);

  const refreshTasks = () => {
    listTasks().then(setTasks).catch(() => setTasks([]));
  };

  useEffect(() => {
    refreshTasks();
    const t = setInterval(refreshTasks, 5000);
    return () => clearInterval(t);
  }, []);

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
  }, [selectedId]);

  const handleCommand = async (cmd: Command) => {
    setPaletteOpen(false);
    switch (cmd.kind) {
      case "run":
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
      case "select":
        setSelectedId(cmd.taskId);
        break;
      case "cancel":
        setRunning(false);
        refreshTasks();
        break;
      default:
        refreshTasks();
    }
  };

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <TaskList
          tasks={tasks}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
        />
        <TaskStream selectedId={selectedId} events={events} connected={connected} running={running} />
      </div>
      <InputBar
        onRun={(input) => handleCommand({ kind: "run", input })}
        onCancel={() => handleCommand({ kind: "cancel" })}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      {paletteOpen && (
        <CommandPalette
          tasks={tasks}
          onCommand={handleCommand}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}