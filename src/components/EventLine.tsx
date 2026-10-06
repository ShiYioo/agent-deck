import type { AgentEvent } from "../types";

/** 单条事件渲染：不同事件类型不同颜色与图标（亮色主题） */
export function EventLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "user_message":
      return <div className="whitespace-pre-wrap font-medium text-blue-600">▶ {event.text}</div>;
    case "assistant_message":
      return <div className="whitespace-pre-wrap text-zinc-900">{event.text}</div>;
    case "thinking":
      return (
        <div className="whitespace-pre-wrap italic text-zinc-400">💭 {event.text}</div>
      );
    case "tool_use":
      return (
        <div className="text-amber-700">
          🔧 [{event.tool}] {event.detail}
        </div>
      );
    case "tool_result":
      return (
        <div
          className={`whitespace-pre-wrap ${event.ok ? "text-zinc-500" : "text-red-600"}`}
        >
          {event.ok ? "✓" : "✗"} {event.detail}
        </div>
      );
    case "status":
      return <div className="text-zinc-400">{event.text}</div>;
    case "complete":
      return <div className="text-emerald-600">✅ 任务{event.ok ? "完成" : "结束"}</div>;
    case "error":
      return (
        <div className="whitespace-pre-wrap text-red-600">✗ {event.message}</div>
      );
    case "raw":
      return <div className="whitespace-pre-wrap text-zinc-400">{event.line}</div>;
    default:
      return null;
  }
}
