import { useEffect, useState } from "react";
import { getSandboxStatus } from "../api/client";

const STATUS_COLOR: Record<string, string> = {
  bwrap: "badge badge-ok",
  seatbelt: "badge badge-ok",
  shuru: "badge badge-warn",
  docker: "badge badge-dim",
};

export default function TopBar() {
  const [sandbox, setSandbox] = useState<Record<string, boolean>>({});

  useEffect(() => {
    getSandboxStatus().then(setSandbox).catch(() => setSandbox({}));
  }, []);

  const active = Object.entries(sandbox)
    .filter(([, ok]) => ok)
    .map(([name]) => name);

  return (
    <header className="topbar">
      <span className="topbar-title">Agent Control Plane</span>
      <span className="topbar-sep">·</span>
      <span className="topbar-meta">worker: pi-local</span>
      <span className="topbar-meta">model: qwen-9b</span>
      {active.map((name) => (
        <span key={name} className={STATUS_COLOR[name] ?? "badge badge-dim"}>
          sandbox: {name}
        </span>
      ))}
    </header>
  );
}
