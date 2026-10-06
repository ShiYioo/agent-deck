import type { AgentEvent } from "../types";

/** 单条事件渲染：入场滑入动画 + 语义配色；thinking 用流光 */
export function EventLine({
  event,
  stagger = 0,
}: {
  event: AgentEvent;
  stagger?: number;
}) {
  const style = { ["--stagger" as string]: `${Math.min(stagger, 12) * 24}ms` };

  switch (event.type) {
    case "user_message":
      return (
        <div className="ev-in whitespace-pre-wrap font-medium text-blue-600" style={style}>
          ▶ {event.text}
        </div>
      );
    case "assistant_message":
      return (
        <div className="ev-in whitespace-pre-wrap text-zinc-900" style={style}>
          {event.text}
        </div>
      );
    case "thinking":
      return (
        <div className="ev-in whitespace-pre-wrap" style={style}>
          <span className="shimmer-text italic">💭 {event.text}</span>
        </div>
      );
    case "tool_use":
      return (
        <div className="ev-in text-amber-700" style={style}>
          🔧 [{event.tool}] {event.detail}
        </div>
      );
    case "tool_result":
      return (
        <div
          className={`ev-in whitespace-pre-wrap ${event.ok ? "text-zinc-500" : "text-red-600"}`}
          style={style}
        >
          {event.ok ? "✓" : "✗"} {event.detail}
        </div>
      );
    case "status":
      return (
        <div className="ev-in text-zinc-400" style={style}>
          {event.text}
        </div>
      );
    case "complete":
      return (
        <div className="ev-in text-emerald-600" style={style}>
          ✅ 任务{event.ok ? "完成" : "结束"}
        </div>
      );
    case "error":
      return (
        <div className="ev-in whitespace-pre-wrap text-red-600" style={style}>
          ✗ {event.message}
        </div>
      );
    case "raw":
      return (
        <div className="ev-in whitespace-pre-wrap text-zinc-400" style={style}>
          {event.line}
        </div>
      );
    default:
      return null;
  }
}
