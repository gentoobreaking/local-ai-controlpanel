import { useEffect, useRef, useState } from "react";

interface Props {
  onRun: (input: string) => void;
  onCancel: () => void;
  onOpenPalette: () => void;
}

export default function InputBar({ onRun, onCancel, onOpenPalette }: Props) {
  const [input, setInput] = useState("");
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
    onRun(v);
    setInput("");
  };

  return (
    <footer className="inputbar">
      <span className="inputbar-prompt">❯</span>
      <input
        ref={inputRef}
        className="inputbar-input"
        value={input}
        placeholder="輸入任務或指令（ctrl+K 命令面板、esc 中斷）"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        autoFocus
        spellCheck={false}
      />
      <span className="inputbar-hint">ctrl+K · esc</span>
    </footer>
  );
}
