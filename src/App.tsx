import { useCallback, useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  cancelTask,
  getTaskDiff,
  getTaskEvents,
  listTasks,
  runLogin,
  startTask,
} from "./api";
import type { AgentEvent, LiveTask, TaskRow } from "./types";
import { Sidebar, projectName, HARNESS_ACCENT } from "./components/Sidebar";
import { Rail } from "./components/Rail";
import { Composer } from "./components/Composer";
import { EventLine } from "./components/EventLine";
import { DiffModal } from "./components/DiffModal";

export default function App() {
  // composer 的全局默认值
  const [harness, setHarness] = useState("zcode");
  const [mode, setMode] = useState("yolo");
  const [cwd, setCwd] = useState("");

  // 运行态与历史
  const [live, setLive] = useState<Record<string, LiveTask>>({});
  const [history, setHistory] = useState<TaskRow[]>([]);
  const [historyEvents, setHistoryEvents] = useState<Record<string, AgentEvent[]>>({});
  const [selected, setSelected] = useState<string | null>(null);

  // diff 弹层
  const [diff, setDiff] = useState<{ taskId: string; text: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshHistory = useCallback(() => {
    listTasks().then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    refreshHistory();
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<{ taskId: string; event: AgentEvent }>("task-event", (e) => {
        const { taskId, event } = e.payload;
        setLive((prev) => {
          const task = prev[taskId];
          if (!task) return prev;
          return {
            ...prev,
            [taskId]: {
              ...task,
              sessionId: event.type === "session_id" ? event.id : task.sessionId,
              events: [...task.events, { event, key: nextKey() }],
            },
          };
        });
      }),
      listen<{ taskId: string; code: number | null }>("task-exit", (e) => {
        const { taskId, code } = e.payload;
        setLive((prev) => {
          const task = prev[taskId];
          if (!task) return prev;
          return { ...prev, [taskId]: { ...task, running: false, exitCode: code } };
        });
        setTimeout(refreshHistory, 300);
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, [refreshHistory]);

  // 发送：选中已完成任务且有会话 ID → 续接；否则开新任务
  const handleSend = async (text: string) => {
    setActionError(null);
    const row = selected ? history.find((t) => t.id === selected) : undefined;
    const canResume = !!row && !!row.session_id && row.status !== "running";
    try {
      const taskId = await startTask({
        harness: canResume ? row.harness : harness,
        cwd: canResume ? row.cwd : cwd || ".",
        prompt: text,
        mode: canResume ? row.mode : harness === "zcode" ? mode : null,
        resumeSessionId: canResume ? row.session_id : null,
      });
      setLive((prev) => ({
        ...prev,
        [taskId]: {
          harness: canResume ? row.harness : harness,
          cwd: canResume ? row.cwd : cwd || ".",
          prompt: text,
          mode: canResume ? row.mode : harness === "zcode" ? mode : null,
          events: [],
          running: true,
          exitCode: null,
          sessionId: canResume ? row.session_id ?? undefined : undefined,
        },
      }));
      setSelected(taskId);
      setTimeout(refreshHistory, 200);
    } catch (e) {
      setActionError(String(e));
    }
  };

  // 查看任务：优先实时缓冲，否则回放数据库事件
  const viewTask = useCallback(
    async (taskId: string) => {
      setSelected(taskId);
      if (live[taskId] || historyEvents[taskId]) return;
      try {
        const events = await getTaskEvents(taskId);
        setHistoryEvents((prev) => ({ ...prev, [taskId]: events }));
      } catch {
        setHistoryEvents((prev) => ({ ...prev, [taskId]: [] }));
      }
    },
    [live, historyEvents],
  );

  const selectedRow = selected ? history.find((t) => t.id === selected) : undefined;
  const selectedLive = selected ? live[selected] : undefined;
  const selectedEvents =
    selectedLive?.events.map((e) => e.event) ??
    (selected ? historyEvents[selected] : undefined) ??
    [];
  const selectedRunning = selectedLive?.running ?? selectedRow?.status === "running";
  const selectedSession = selectedLive?.sessionId ?? selectedRow?.session_id ?? null;
  const selectedCanResume = !!selectedRow && !!selectedSession && !selectedRunning;
  const selectedHarness = selectedRow?.harness ?? selectedLive?.harness ?? harness;
  const hasAuthError = selectedEvents.some(
    (e) => e.type === "error" && e.kind === "auth",
  );
  const canShowDiff = !!selectedRow && selectedRow.status === "done";

  const showDiff = async () => {
    if (!selected) return;
    setActionError(null);
    try {
      const text = await getTaskDiff(selected);
      setDiff({ taskId: selected, text });
    } catch (e) {
      setActionError(String(e));
    }
  };

  return (
    <div className="flex h-full">
      <Rail onNew={() => setSelected(null)} />
      <Sidebar tasks={history} selectedId={selected} onSelect={(id) => viewTask(id)} />

      <main className="flex min-w-0 flex-1 flex-col">
        {selected === null ? (
          // ── 空态：点阵底纹 + 错落入场 ──
          <div key="empty" className="anim-scene relative flex flex-1 flex-col items-center justify-center px-8">
            <div className="grid-bg pointer-events-none absolute inset-0" />
            <div className="anim-rise relative mb-8 text-5xl text-zinc-300">
              ❖
            </div>
            <div
              className="anim-rise relative text-2xl font-medium tracking-tight text-zinc-800"
              style={{ animationDelay: "70ms" }}
            >
              我们应该在
              <span className="mx-1 border-b-2 border-dotted border-zinc-400">
                {projectName(cwd)}
              </span>
              中做些什么？
            </div>
          </div>
        ) : (
          // ── 任务详情视图：场景切换动画 ──
          <div key={`task-${selected}`} className="anim-scene flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-zinc-100 px-6 py-3 text-sm">
              <button
                onClick={() => setSelected(null)}
                className="rounded-md px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                title="返回新任务"
              >
                ←
              </button>
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: HARNESS_ACCENT[selectedHarness] }}
              />
              <span className="font-mono text-xs" style={{ color: HARNESS_ACCENT[selectedHarness] }}>
                {selectedHarness}
              </span>
              <span className="truncate text-zinc-500">
                {selectedRow?.cwd ?? selectedLive?.cwd}
              </span>
              <span className="flex-1" />
              {selectedRunning && (
                <button
                  onClick={() => selected && cancelTask(selected).catch(() => {})}
                  className="rounded-full border border-red-200 px-3 py-1 text-xs text-red-600 transition-colors hover:bg-red-50"
                >
                  终止
                </button>
              )}
              <span className="text-xs text-zinc-400">
                {selectedRunning
                  ? "运行中…"
                  : selectedRow?.status === "done"
                    ? "已完成"
                    : selectedRow?.status === "cancelled"
                      ? "已取消"
                      : "已结束"}
              </span>
            </div>

            {!selectedRunning && (
              <div className="flex flex-wrap items-center gap-2 px-6 pt-2 text-xs">
                {hasAuthError && (
                  <button
                    onClick={() =>
                      runLogin(selectedRow?.harness ?? "zcode").catch(() => {})
                    }
                    className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 font-medium text-amber-700 transition-colors hover:bg-amber-100"
                  >
                    🔑 唤起登录
                  </button>
                )}
                {canShowDiff && (
                  <button
                    onClick={showDiff}
                    className="rounded-full border border-zinc-200 px-3 py-1 text-zinc-600 transition-colors hover:bg-zinc-100"
                  >
                    查看 Diff
                  </button>
                )}
                {selectedCanResume && (
                  <span className="text-zinc-400">在下方输入可续接此会话</span>
                )}
                {actionError && <span className="text-red-600">{actionError}</span>}
              </div>
            )}

            <LogPanel key={selected} events={selectedEvents} running={selectedRunning} />
          </div>
        )}

        {/* 底部输入卡：始终可见；任务运行中禁用并显示打字指示 */}
        <div className="px-6 pb-5 pt-2">
          <Composer
            cwd={cwd}
            onCwdChange={setCwd}
            harness={harness}
            onHarnessChange={setHarness}
            mode={mode}
            onModeChange={setMode}
            onSend={handleSend}
            disabled={selectedRunning}
            placeholder={selectedCanResume ? "续接此会话…" : "随心输入"}
          />
        </div>

        {diff && <DiffModal text={diff.text} onClose={() => setDiff(null)} />}
      </main>
    </div>
  );
}

/** 会话日志面板：历史回放时错落入场，实时流式时逐条滑入；自动平滑滚动到底部 */
function LogPanel({
  events,
  running,
}: {
  events: AgentEvent[];
  running: boolean;
}) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const prevCount = useRef(0);
  // 仅当本次渲染是「从零加载」（历史回放/新任务首条）时才排队入场
  const staggerInitial = prevCount.current === 0 && events.length > 0;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    prevCount.current = events.length;
  }, [events.length]);

  return (
    <div
      ref={logRef}
      className="log-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-4 font-mono text-xs leading-relaxed"
    >
      {events.length === 0 && (
        <div className="py-10 text-center text-zinc-400">
          {running ? (
            <span className="typing-dots inline-flex items-center">
              <span />
              <span />
              <span />
            </span>
          ) : (
            "（暂无日志）"
          )}
        </div>
      )}
      {events.map((event, i) => (
        <EventLine key={i} event={event} stagger={staggerInitial ? i : 0} />
      ))}
    </div>
  );
}

let eventKey = 0;
const nextKey = () => eventKey++;
