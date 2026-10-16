import { Check, Circle, LoaderCircle, Pause, AlertCircle, ChevronDown } from "lucide-react";
import { HarnessIcon } from "./HarnessIcon";

export type ConversationPhase = "restoring" | "waiting" | "compacting" | "running" | "collaborating" | "done" | "failed" | "cancelled";
const labels: Record<ConversationPhase, string> = {
  restoring: "恢复对话", waiting: "需要你的回应", compacting: "整理上下文",
  running: "正在执行", done: "本轮已完成", failed: "执行遇到问题", cancelled: "已停止",
  collaborating: "协作进行中",
};
export function ConversationStatus({ phase, harness, detail, queued, detailsOpen, onDetails }: {
  phase: ConversationPhase; harness: string; detail?: string; queued: number;
  detailsOpen: boolean; onDetails: () => void;
}) {
  const active = ["restoring", "running", "compacting", "collaborating"].includes(phase);
  const Icon = active ? LoaderCircle : phase === "done" ? Check :
    phase === "failed" ? AlertCircle : phase === "cancelled" ? Pause : Circle;
  return <div className="conversation-status" data-phase={phase}>
    <div className="conversation-status-main" role="status">
      <Icon size={14} className={active ? "activity-spinner" : undefined} />
      <span>{labels[phase]}</span>
      <span className="status-runner"><HarnessIcon harness={harness} size={13} />{harness}</span>
      {queued > 0 && <span className="status-queue">{queued} 条待发送</span>}
    </div>
    {detail && <span className="conversation-status-detail" title={detail}>{detail}</span>}
    <button onClick={onDetails} aria-expanded={detailsOpen} className="status-details-button">
      {detailsOpen ? "收起详情" : "任务详情"}<ChevronDown size={13} style={{ transform: detailsOpen ? "rotate(180deg)" : undefined }} />
    </button>
  </div>;
}
