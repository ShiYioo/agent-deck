import { memo, useState } from "react";
import { Copy, Check, AlertCircle } from "lucide-react";
import { AssistantText } from "./AssistantText";
import { Disclosure } from "./Disclosure";
import { ToolIcon } from "./ToolIcon";
import {
  IconSparkle,
  IconTerminal,
  IconCheckCircle,
  IconXCircle,
  IconInfo,
} from "./icons";
import { isDeleteTool, type ConversationRow } from "../conversation";

/** 语义行渲染：行由 conversation.ts 归约产生，本组件只做投影。 */
export const EventLine = memo(function EventLine({
  row,
}: {
  row: ConversationRow;
}) {
  switch (row.kind) {
    case "user":
      // 接力注入的简报/内置提示词：入库留档但不透出，只显示接力标记
      if (row.hidden) {
        return (
          <div className="activity-event flex items-center gap-1.5">
            <IconInfo size={13} className="shrink-0" />
            AgentDeck 接力请求
          </div>
        );
      }
      return (
        <div className="message-user">
          <div>{row.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="assistant-entry">
          {row.sourceHarness && <div className="message-source">{row.sourceHarness}</div>}
          <div className="message-assistant">
          <AssistantText text={row.text} />
          <MessageActions text={row.text} />
          </div>
        </div>
      );
    case "thought":
      return (
        <Disclosure
          className="activity-event"
          title={<><IconSparkle size={13} /><span>思考{row.durationMs && row.durationMs >= 100 ? ` · ${(row.durationMs / 1000).toFixed(1)} 秒` : ""}</span></>}
        >
          <pre>{row.text}</pre>
        </Disclosure>
      );
    case "tool": {
      if (row.status === "running") {
        // 进行中：工具名 + 入参投影（命令默认展开保持可见）
        return (
          <Disclosure className="activity-event" defaultOpen={row.isCommand}
            title={<><ToolIcon tool={row.tool} /><span>{row.tool}</span>{opBadge(row)}{targetLabel(row)}</>}>
            <pre>{row.detail ?? ""}</pre>
          </Disclosure>
        );
      }
      if (row.status === "failed") {
        const parts = [row.detail, row.output].filter((s): s is string => !!s);
        const content = parts.filter((s, i) => i === 0 || s !== parts[0]).join("\n");
        return (
          <div role="alert" className="event-error">
            <Disclosure className="activity-event" defaultOpen
              title={<><IconXCircle size={13} /><span className="text-red-600 font-medium">{row.tool} 失败</span>{targetLabel(row)}</>}>
              <pre className="text-red-600">{content || "（无错误详情）"}</pre>
            </Disclosure>
          </div>
        );
      }
      // completed：命令类默认展开（输入输出成对可见）；提问同样展开——问题与回答要在流里可见
      const parts = [row.detail, row.output].filter((s): s is string => !!s);
      const content = parts.filter((s, i) => i === 0 || s !== parts[0]).join("\n");
      const defaultOpen = row.isCommand || row.isQuestion;
      return (
        <Disclosure className="activity-event" defaultOpen={defaultOpen}
          title={<><IconCheckCircle size={13} /><span>{row.tool} · 已完成</span>{opBadge(row)}{targetLabel(row)}{diffBadge(row)}</>}>
          <pre>{content}</pre>
        </Disclosure>
      );
    }
    case "status":
      return (
        <div className="activity-event flex items-center gap-1.5">
          <IconInfo size={13} className="shrink-0" />
          {row.text}
        </div>
      );
    case "complete": {
      const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
      return (
        <div className="activity-event flex items-center gap-1.5">
           {row.ok ? <IconCheckCircle size={14} className="shrink-0" /> : <IconXCircle size={14} className="shrink-0" />}
          任务{row.ok ? "完成" : "结束"}
          {row.durationMs ? ` · 工作 ${Math.round(row.durationMs / 1000)} 秒` : ""}
          {row.tokens && (
            <span className="text-stone-400" title={`输入 ${row.tokens.input} · 输出 ${row.tokens.output}${row.tokens.reasoning ? ` · 推理 ${row.tokens.reasoning}` : ""}${row.tokens.cached ? ` · 缓存命中 ${row.tokens.cached}` : ""} tokens`}>
              · tokens ↑{fmtK(row.tokens.input)} ↓{fmtK(row.tokens.output)}
              {row.tokens.reasoning ? `（思考 ${fmtK(row.tokens.reasoning)}）` : ""}
            </span>
          )}
        </div>
      );
    }
    case "error":
      return (
        <div role="alert" className="event-error flex items-start gap-1.5 whitespace-pre-wrap text-red-600">
          <IconXCircle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{row.message}</span>
        </div>
      );
    case "raw":
      return (
        <Disclosure className="activity-event" title={<><IconTerminal size={13} /><span>运行输出</span></>}>
          <pre>{row.line}</pre>
        </Disclosure>
      );
    default:
      return null;
  }
});

/** 文件类工具的目标路径：提到行标题上，"改了/删了哪个文件"不用展开就能看到 */
function targetLabel(row: { target?: string }) {
  if (!row.target) return null;
  return (
    <span className="min-w-0 truncate font-mono text-[11px] text-stone-400" title={row.target}>
      {row.target}
    </span>
  );
}

/** 操作语义徽标：删除/新增要一眼可见。
 *  四种运行器同源：deck 的 delete_file、codex 的 changes[].kind、CLI 工具名的 delete/remove。 */
function opBadge(row: { tool: string; args?: Record<string, unknown> }) {
  const changes = row.args?.changes;
  const kind = Array.isArray(changes) ? (changes[0] as { kind?: string } | undefined)?.kind : undefined;
  const label = isDeleteTool(row.tool, row.args)
    ? "删除"
    : kind === "add" || kind === "create" || row.tool.toLowerCase() === "write"
      ? "新增"
      : undefined;
  if (!label) return null;
  return (
    <span className={`shrink-0 ${label === "删除" ? "text-red-600" : "text-emerald-600"}`}>{label}</span>
  );
}

/** 改动行数徽标：工具自带 diff 时显示 +N −M（pi 的 edit 返回里就带 diff） */
function diffBadge(row: { added?: number; removed?: number }) {
  if (!row.added && !row.removed) return null;
  return (
    <span className="shrink-0 font-mono text-[11px]">
      {row.added ? <span className="text-emerald-600">+{row.added}</span> : null}
      {row.removed ? <span className="ml-1 text-red-600">−{row.removed}</span> : null}
    </span>
  );
}

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
