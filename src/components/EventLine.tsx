import { memo, useState } from "react";
import { Copy, Check, AlertCircle } from "lucide-react";
import type { AgentEvent } from "../types";
import { AssistantText } from "./AssistantText";
import { Disclosure } from "./Disclosure";
import {
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
export function ToolIcon({ tool }: { tool: string }) {
  const t = tool.toLowerCase();
  if (/(shell|bash|terminal|exec|command)/.test(t)) return <IconTerminal size={13} />;
  if (/(file|edit|write|read|patch)/.test(t)) return <IconFileEdit size={13} />;
  if (/(web|search|fetch|globe)/.test(t)) return <IconGlobe size={13} />;
  return <IconTool size={13} />;
}

/** Stable event objects keep prior messages out of streaming re-renders. */
export const EventLine = memo(function EventLine({
  event,
}: {
  event: AgentEvent;
}) {

  switch (event.type) {
    case "user_message":
      // 接力注入的简报/内置提示词：入库留档但不透出，只显示接力标记
      if (event.hidden) {
        return (
          <div className="activity-event flex items-center gap-1.5">
            <IconInfo size={13} className="shrink-0" />
            已接力自 AgentDeck（自动注入上一会话的交接简报）
          </div>
        );
      }
      return (
        <div className="message-user">
          <div>{event.text}</div>
        </div>
      );
    case "assistant_message":
      return (
        <div className="message-assistant">
          <AssistantText text={event.text} />
          <MessageActions text={event.text} />
        </div>
      );
    case "thinking":
      return (
        <Disclosure
          className="activity-event"
          title={<><IconSparkle size={13} /><span>思考{event.durationMs ? ` · ${(event.durationMs / 1000).toFixed(1)} 秒` : ""}</span></>}
        >
          <pre>{event.text}</pre>
        </Disclosure>
      );
    case "tool_use":
      return (
        <Disclosure className="activity-event" title={<><ToolIcon tool={event.tool} /><span>{event.tool}</span></>}>
          <pre>{event.detail}</pre>
        </Disclosure>
      );
    case "tool_result":
      return (
        <Disclosure className={`activity-event ${event.ok ? "" : "event-error"}`} defaultOpen={!event.ok}
          title={<>{event.ok ? <IconCheckCircle size={13} /> : <IconXCircle size={13} />}<span>{event.tool} · {event.ok ? "已完成" : "失败"}</span></>}>
          <pre>{event.detail}</pre>
        </Disclosure>
      );
    case "status":
      return (
        <div className="activity-event flex items-center gap-1.5">
          <IconInfo size={13} className="shrink-0" />
          {event.text}
        </div>
      );
    case "complete":
      return (
        <div className="activity-event flex items-center gap-1.5">
           {event.ok ? <IconCheckCircle size={14} className="shrink-0" /> : <IconXCircle size={14} className="shrink-0" />}
          任务{event.ok ? "完成" : "结束"}
          {event.durationMs ? ` · 工作 ${Math.round(event.durationMs / 1000)} 秒` : ""}
        </div>
      );
    case "error":
      return (
        <div role="alert" className="event-error flex items-start gap-1.5 whitespace-pre-wrap text-red-600">
          <IconXCircle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{event.message}</span>
        </div>
      );
    case "raw":
      return (
        <Disclosure className="activity-event" title={<><IconTerminal size={13} /><span>运行输出</span></>}>
          <pre>{event.line}</pre>
        </Disclosure>
      );
    default:
      return null;
  }
});

function MessageActions({ text }: { text: string }) {
  const [feedback, setFeedback] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback("copied");
    } catch { setFeedback("failed"); }
    setTimeout(() => setFeedback("idle"), 1600);
  };
  const label = feedback === "copied" ? "已复制回复" : feedback === "failed" ? "复制失败，请重试" : "复制回复";
  return (
    <div className="message-actions">
      <button className="icon-button" title={label} aria-label={label} onClick={copy}>
        {feedback === "copied" ? <Check size={14} /> : feedback === "failed" ? <AlertCircle size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}
