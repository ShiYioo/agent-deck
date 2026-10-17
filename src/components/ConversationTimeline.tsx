import { lazy, memo, Suspense, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, History, LoaderCircle } from "lucide-react";
import { buildConversation, foldToolRows } from "../conversation";
import type { AgentEvent } from "../types";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { Disclosure } from "./Disclosure";
import { ToolIcon } from "./ToolIcon";

const EventLine = lazy(() => import("./EventLine").then((module) => ({ default: module.EventLine })));
const PAGE_SIZE = 500;

/** One scroll surface for conversation, collaboration results and changed files. */
export const ConversationTimeline = memo(function ConversationTimeline({
  events, running, blocked, loading, activity, footer, positionKey,
}: {
  events: { event: AgentEvent; key: number }[];
  running: boolean;
  blocked: boolean;
  loading: boolean;
  activity: string;
  footer?: ReactNode;
  positionKey?: string;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { viewportRef, contentRef, follow, hasOverflow, onScroll, scrollToBottom } = useAutoScroll(events.length, positionKey);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const detachedAt = useRef<number | null>(null);
  if (follow) detachedAt.current = null;
  else if (detachedAt.current === null) detachedAt.current = events.at(-1)?.key ?? null;
  const hasNew = !follow && detachedAt.current !== (events.at(-1)?.key ?? null);
  const hidden = Math.max(0, events.length - limit);
  // Reduce before slicing so tool pairs and turn boundaries survive paging.
  const rows = useMemo(() => buildConversation(events), [events]);
  const activeFromKey = running ? [...rows].reverse().find((row) => row.kind === "user")?.key ?? rows[0]?.key : undefined;
  const display = useMemo(() => foldToolRows(rows.filter((row) =>
    !hidden || row.key >= events[hidden].key), activeFromKey), [rows, hidden, events, activeFromKey]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !anchor.current) return;
    viewport.scrollTop = anchor.current.top + viewport.scrollHeight - anchor.current.height;
    anchor.current = null;
  }, [limit, viewportRef]);
  const loadEarlier = () => {
    const viewport = viewportRef.current;
    if (viewport) anchor.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    setLimit((value) => value + PAGE_SIZE);
  };

  return (
    <div className="conversation-timeline">
      <div ref={viewportRef} onScroll={onScroll} tabIndex={0}
        aria-label="会话内容" className="log-scroll min-h-0 flex-1 overflow-y-auto">
        <div ref={contentRef} className="log-content">
          {hidden > 0 && <button className="timeline-history" onClick={loadEarlier}>
            <History size={14} />查看更早的记录<span>还有 {hidden} 条</span>
          </button>}
          {events.length === 0 && <div className="timeline-empty">
            {loading ? <span role="status">正在恢复对话…</span> :
              running ? (blocked ? null : <Activity label={activity} />) : "发送消息，继续这个任务"}
          </div>}
          <Suspense fallback={<div className="content-loading" role="status">正在加载对话…</div>}>
            {display.map((group) => {
              if (group.kind === "single") return <EventLine key={group.row.key} row={group.row} />;
              const summary = group.uses.map(({ tool, n, targets, sample }) => {
                if (targets !== null) {
                  if (tool === "grep" || tool === "find") return `${tool} ×${n}（搜索 ${targets} 处）`;
                  return `${tool} ×${n}（${sample.join("、")}${targets > sample.length ? ` 等 ${targets} 个文件` : ""}）`;
                }
                return `${tool} ×${n}`;
              }).join(" · ");
              return <Disclosure key={group.rows[0].key} className="activity-event"
                defaultOpen={group.failed}
                title={<><ToolIcon tool="tool" /><span>工具操作 ×{group.rows.length}：{summary}</span>
                  {group.deletes > 0 && <span className="text-red-600">删除 {group.deletes}</span>}
                  {group.failed && <span className="text-red-600">含失败</span>}</>}>
                {[...group.thoughts, ...group.rows].sort((a, b) => a.key - b.key)
                  .map((row) => <EventLine key={row.key} row={row} />)}
              </Disclosure>;
            })}
          </Suspense>
          {events.length > 0 && running && !blocked && <Activity label={activity} />}
          {footer}
        </div>
      </div>
      {!follow && hasOverflow && <div className="timeline-jump">
        <button onClick={scrollToBottom} title="回到最新" aria-label="回到最新">
          <ArrowDown size={14} />{hasNew ? "有新进展 · 回到最新" : "回到最新"}
        </button>
      </div>}
    </div>
  );
});

function Activity({ label }: { label: string }) {
  return <div className="transcript-loading timeline-activity" role="status" aria-label="加载中">
    <LoaderCircle size={14} className="activity-spinner" aria-hidden="true" /><span>{label}</span>
  </div>;
}
