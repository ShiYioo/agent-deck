import { memo } from "react";
import type { AgentEvent } from "../types";
import { AssistantText } from "./AssistantText";
import {
  IconPrompt,
  IconSparkle,
  IconTerminal,
  IconFileEdit,
  IconGlobe,
  IconTool,
  IconCheckCircle,
  IconXCircle,
  IconInfo,
} from "./icons";

/** 依据工具名挑图标：终端/文件/网络/通用扳手 */
function ToolIcon({ tool }: { tool: string }) {
  const t = tool.toLowerCase();
  if (/(shell|bash|terminal|exec|command)/.test(t)) return <IconTerminal size={13} />;
  if (/(file|edit|write|read|patch)/.test(t)) return <IconFileEdit size={13} />;
  if (/(web|search|fetch|globe)/.test(t)) return <IconGlobe size={13} />;
  return <IconTool size={13} />;
}

/** 单条事件渲染：入场滑入动画 + 语义图标 + 语义配色（暖纸主题） */
/** 单条事件渲染：memo 化——流式高频更新时只渲染新增的一条 */
export const EventLine = memo(function EventLine({
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
        <div className="ev-in flex items-start gap-1.5 font-medium text-blue-700" style={style}>
          <IconPrompt size={13} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap">{event.text}</span>
        </div>
      );
    case "assistant_message":
      return (
        <div className="ev-in text-stone-900" style={style}>
          <AssistantText text={event.text} />
        </div>
      );
    case "thinking":
      return (
        <div className="ev-in flex items-start gap-1.5" style={style}>
          <IconSparkle size={13} className="mt-0.5 shrink-0 text-stone-400" />
          <span className="shimmer-text whitespace-pre-wrap italic">{event.text}</span>
        </div>
      );
    case "tool_use":
      return (
        <div className="ev-in flex items-start gap-1.5 text-amber-700" style={style}>
          <span className="mt-0.5 shrink-0 [&>svg]:block">
            <ToolIcon tool={event.tool} />
          </span>
          <span className="min-w-0">
            <span className="font-medium">[{event.tool}]</span>{" "}
            <span className="text-amber-600/80">{event.detail}</span>
          </span>
        </div>
      );
    case "tool_result":
      return (
        <div
          className={`ev-in flex items-start gap-1.5 whitespace-pre-wrap ${
            event.ok ? "text-stone-500" : "text-red-600"
          }`}
          style={style}
        >
          {event.ok ? (
            <IconCheckCircle size={13} className="mt-0.5 shrink-0 text-emerald-600" />
          ) : (
            <IconXCircle size={13} className="mt-0.5 shrink-0" />
          )}
          <span className="min-w-0">{event.detail}</span>
        </div>
      );
    case "status":
      return (
        <div className="ev-in flex items-center gap-1.5 text-stone-400" style={style}>
          <IconInfo size={13} className="shrink-0" />
          {event.text}
        </div>
      );
    case "complete":
      return (
        <div className="ev-in flex items-center gap-1.5 text-emerald-700" style={style}>
          <IconCheckCircle size={14} className="shrink-0" />
          任务{event.ok ? "完成" : "结束"}
        </div>
      );
    case "error":
      return (
        <div className="ev-in flex items-start gap-1.5 whitespace-pre-wrap text-red-600" style={style}>
          <IconXCircle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{event.message}</span>
        </div>
      );
    case "raw":
      return (
        <div className="ev-in whitespace-pre-wrap text-stone-400" style={style}>
          {event.line}
        </div>
      );
    default:
      return null;
  }
});
