import type { AgentEvent } from "../types";

/** 单条事件渲染：不同事件类型不同颜色与图标 */
export function EventLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "user_message":
      return <div className="whitespace-pre-wrap text-sky-300">▶ {event.text}</div>;
    case "assistant_message":
      return <div className="whitespace-pre-wrap text-zinc-100">{event.text}</div>;
    case "thinking":
      return (
        <div className="whitespace-pre-wrap text-zinc-500 italic">💭 {event.text}</div>
      );
    case "tool_use":
      return (
        <div className="text-amber-300">
          🔧 [{event.tool}] {event.detail}
        </div>
      );
    case "tool_result":
      return (
        <div
          className={`whitespace-pre-wrap ${event.ok ? "text-zinc-400" : "text-red-400"}`}
        >
          {event.ok ? "✓" : "✗"} {event.detail}
        </div>
      );
    case "status":
      return <div className="text-zinc-500">{event.text}</div>;
    case "complete":
      return <div className="text-emerald-400">✅ 任务{event.ok ? "完成" : "结束"}</div>;
    case "error":
      return (
        <div className="whitespace-pre-wrap text-red-400">✗ {event.message}</div>
      );
    case "raw":
      return <div className="whitespace-pre-wrap text-zinc-600">{event.line}</div>;
    default:
      return null;
  }
}
