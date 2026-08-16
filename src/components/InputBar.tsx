import { useEffect, useRef, useState, useCallback } from "react";

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
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  // 修復 ESC 鍵在輸入框中斷功能
  const handleCancel = useCallback(() => {
    if (input.trim()) {
      setInput("");
    } else {
      onCancel();
    }
  }, [input, onCancel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenPalette]);

  const submit = useCallback(() => {
    const v = input.trim();
    if (!v) return;
    if (v.startsWith("/")) {
      onOpenPalette();
      return;
    }
    onRun(v);
    setInput("");
    setShowHistory(false);
    const next = [v, ...history.filter((h) => h !== v)].slice(0, 20);
    setHistory(next);
    setHistIdx(-1);
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable; history stays in-memory
    }
  }, [input, history, onRun]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (showHistory && histIdx >= 0) {
        e.preventDefault();
        setInput(history[histIdx] ?? "");
        setShowHistory(false);
        return;
      }
      submit();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      if (!showHistory) {
        setShowHistory(true);
        setHistIdx(history.length - 1);
        setInput(history[history.length - 1] ?? "");
      } else {
        const idx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(idx);
        setInput(history[idx] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!showHistory) return;
      if (histIdx === -1) return;
      const idx = histIdx + 1;
      if (idx >= history.length) {
        setHistIdx(-1);
        setInput("");
        setShowHistory(false);
      } else {
        setHistIdx(idx);
        setInput(history[idx] ?? "");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
      setShowHistory(false);
    } else {
      setShowHistory(false);
    }
  }, [input, history, histIdx, showHistory, onCancel, onOpenPalette]);

  const saveHistory = useCallback((next: string[]) => {
    setHistory(next);
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable
    }
  }, []);

  return (
    <footer className="inputbar">
      <span className="inputbar-prompt">❯</span>
      <div className="inputbar-wrapper">
        <input
          ref={inputRef}
          className="inputbar-input"
          value={input}
          placeholder="輸入任務或指令（ctrl+K 命令面板、↑/↓ 歷史、esc 中斷）"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => history.length > 0 && setShowHistory(true)}
          onBlur={() => setTimeout(() => setShowHistory(false), 100)}
          autoFocus
          spellCheck={false}
        />
        {showHistory && history.length > 0 && (
          <div className="inputbar-history" ref={historyRef}>
            {history.map((h, i) => (
              <div
                key={i}
                className={`inputbar-history-item ${i === histIdx ? "active" : ""}`}
                onClick={() => {
                  setInput(h);
                  setHistIdx(i);
                  setShowHistory(false);
                }}
                onMouseEnter={() => setHistIdx(i)}
              >
                <span className="inputbar-history-idx">{i + 1}</span>
                <span className="inputbar-history-text">{h}</span>
              </div>
            ))}
          </div>
        )}
        <span className="inputbar-hint">ctrl+K · ↑/↓ · esc</span>
      </div>
    </footer>
  );
}
