import { useEffect, useRef, useState } from "react";

interface Props {
  onRun: (input: string) => void;
  onCancel: () => void;
  onOpenPalette: () => void;
}

const HISTORY_KEY = "acp-input-history";

/** §45.4：方向鍵歷史（↑/↓ 瀏覽先前輸入），sessionStorage 持久 */
function loadHistory(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export default function InputBar({ onRun, onCancel, onOpenPalette }: Props) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [histIdx, setHistIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenPalette();
      } else if (e.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onOpenPalette]);

  const submit = () => {
    const v = input.trim();
    if (!v) return;
    if (v.startsWith("/")) {
      // `/` 指令前綴：路由到指令面板（§45.4）
      onOpenPalette();
      return;
    }
    onRun(v);
    setInput("");
    const next = [v, ...history.filter((h) => h !== v)].slice(0, 20);
    setHistory(next);
    setHistIdx(-1);
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable; history stays in-memory
    }
  };

  return (
    <footer className="inputbar">
      <span className="inputbar-prompt">❯</span>
      <input
        ref={inputRef}
        className="inputbar-input"
        value={input}
        placeholder="輸入任務或指令（ctrl+K 命令面板、↑/↓ 歷史、esc 中斷）"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            submit();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (history.length === 0) return;
            const idx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
            setHistIdx(idx);
            setInput(history[idx] ?? "");
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (histIdx === -1) return;
            const idx = histIdx + 1;
            if (idx >= history.length) {
              setHistIdx(-1);
              setInput("");
            } else {
              setHistIdx(idx);
              setInput(history[idx] ?? "");
            }
          }
        }}
        autoFocus
        spellCheck={false}
      />
      <span className="inputbar-hint">ctrl+K · ↑/↓ · esc</span>
    </footer>
  );
}
