import { useState } from "react";
import type { TaskSummary } from "../api/client";

interface Props {
  task: TaskSummary;
  onApprove: (opts: { kind: string; reason?: string }) => void;
  onReject: () => void;
}

/**
 * approve dialog（spec §45.5 POST /:id/approve）。
 * §45.3 安全規則：UI 無判斷權——所有 sandbox/approve 資訊來自 Control Plane API。
 * 這裡只是把使用者的「批准」意圖（kind: artifact/degraded/escalation/block）
 * 轉送給 Control Plane；Control Plane 決定下一步狀態。
 */
export default function ApproveDialog({ task, onApprove, onReject }: Props) {
  const [kind, setKind] = useState<string>("artifact");
  const [reason, setReason] = useState("");

  const kinds: Array<{ value: string; label: string }> = [
    { value: "artifact", label: "artifact（允許套用 patch）" },
    { value: "degraded", label: "degraded override（允許降級）" },
    { value: "escalation", label: "escalation（升級處理）" },
    { value: "block", label: "block（阻擋，維持 ASK_USER）" },
  ];

  return (
    <div className="palette-overlay">
      <div className="palette approve-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input sb-title">需要人工審批（{task.id}）</div>
        <div className="approve-task">{task.userRequest}</div>
        <div className="approve-status">status: {task.status}</div>
        <ul className="approve-kinds">
          {kinds.map((k) => (
            <li key={k.value}>
              <label>
                <input
                  type="radio"
                  name="approve-kind"
                  value={k.value}
                  checked={kind === k.value}
                  onChange={() => setKind(k.value)}
                />
                {k.label}
              </label>
            </li>
          ))}
        </ul>
        <textarea
          className="approve-reason"
          placeholder="理由（選填）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
        />
        <div className="approve-actions">
          <button className="btn" onClick={onReject}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onApprove({ kind, reason: reason.trim() || undefined })}
          >
            批准
          </button>
        </div>
      </div>
    </div>
  );
}
