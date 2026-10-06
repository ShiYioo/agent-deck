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
import { Sidebar } from "./components/Sidebar";
import { EventLine } from "./components/EventLine";
import { DiffModal } from "./components/DiffModal";

const HARNESS_LABELS: Record<string, string> = {
  zcode: "ZCode (GLM)",
  codex: "Codex (GPT)",
};

export default function App() {
  // 表单
  const [harness, setHarness] = useState("zcode");
  const [mode, setMode] = useState("yolo");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // 运行态与历史
  const [live, setLive] = useState<Record<string, LiveTask>>({});
  const [history, setHistory] = useState<TaskRow[]>([]);
  const [historyEvents, setHistoryEvents] = useState<Record<string, AgentEvent[]>>({});
  const [selected, setSelected] = useState<string | null>(null);

  // diff 弹层
  const [diff, setDiff] = useState<{ taskId: string; text: string } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

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
        // 状态已落库，刷新侧边栏
        setTimeout(refreshHistory, 300);
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, [refreshHistory]);

  const startTaskInternal = async (overrides?: {
    harness?: string;
    cwd?: string;
    prompt?: string;
    mode?: string | null;
    resumeSessionId?: string | null;
  }) => {
    setFormError(null);
    const useHarness = overrides?.harness ?? harness;
    const useCwd = overrides?.cwd ?? cwd;
    const usePrompt = overrides?.prompt ?? prompt;
    const useMode = overrides?.mode !== undefined ? overrides.mode : harness === "zcode" ? mode : null;
    if (!usePrompt.trim()) {
      setFormError("请输入任务描述");
      return;
    }
    try {
      const taskId = await startTask({
        harness: useHarness,
        cwd: useCwd || ".",
        prompt: usePrompt,
        mode: useMode,
        resumeSessionId: overrides?.resumeSessionId ?? null,
      });
      setLive((prev) => ({
        ...prev,
        [taskId]: {
          harness: useHarness,
          cwd: useCwd || ".",
          prompt: usePrompt,
          mode: useMode,
          events: [],
          running: true,
          exitCode: null,
          sessionId: overrides?.resumeSessionId ?? undefined,
        },
      }));
      setSelected(taskId);
      setPrompt("");
      setTimeout(refreshHistory, 200);
    } catch (e) {
      setFormError(String(e));
    }
  };

  // 查看某个任务：优先实时缓冲，否则回放数据库事件
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
  const hasAuthError = selectedEvents.some(
    (e) => e.type === "error" && e.kind === "auth",
  );
  const canShowDiff = !!selectedRow && selectedRow.status === "done";

  const showDiff = async () => {
    if (!selected) return;
    setDiffError(null);
    try {
      const text = await getTaskDiff(selected);
      setDiff({ taskId: selected, text });
    } catch (e) {
      setDiffError(String(e));
    }
  };

  return (
    <div className="flex h-full">
      <Sidebar
        tasks={history}
        selectedId={selected}
        onSelect={(id) => viewTask(id)}
        onNew={() => setSelected(null)}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        {/* 新任务表单：仅未选中任务时显示 */}
        {selected === null && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              {Object.entries(HARNESS_LABELS).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setHarness(id)}
                  className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                    harness === id
                      ? "bg-emerald-600 text-white"
                      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  }`}
                >
                  {label}
                </button>
              ))}
              {harness === "zcode" && (
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
                >
                  <option value="yolo">yolo（全自动）</option>
                  <option value="build">build（编辑前确认）</option>
                  <option value="edit">edit</option>
                  <option value="plan">plan（只读规划）</option>
                </select>
              )}
            </div>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="工作目录（可选，如 E:\projects\demo）"
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-600"
            />
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="任务描述，例如：把 utils/date.ts 里的日期格式化函数补上单测"
              rows={3}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-600"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => startTaskInternal()}
                className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
              >
                派任务
              </button>
              {formError && <span className="text-sm text-red-400">{formError}</span>}
            </div>
          </div>
        )}

        {/* 选中任务的详情视图 */}
        {selected !== null && (
          <TaskDetailView
            taskId={selected}
            row={selectedRow}
            live={selectedLive}
            events={selectedEvents}
            hasAuthError={hasAuthError}
            canShowDiff={canShowDiff}
            diffError={diffError}
            onShowDiff={showDiff}
            onLogin={() => runLogin(selectedRow?.harness ?? "zcode").catch(() => {})}
            onRetry={() => {
              if (!selectedRow) return;
              startTaskInternal({
                harness: selectedRow.harness,
                cwd: selectedRow.cwd,
                prompt: selectedRow.prompt,
                mode: selectedRow.mode,
                resumeSessionId: selectedRow.session_id,
              });
            }}
            onCancel={() => selected && cancelTask(selected).catch(() => {})}
            onBack={() => setSelected(null)}
          />
        )}

        {diff && <DiffModal text={diff.text} onClose={() => setDiff(null)} />}
      </div>
    </div>
  );
}

let eventKey = 0;
const nextKey = () => eventKey++;

function TaskDetailView(props: {
  taskId: string;
  row?: TaskRow;
  live?: LiveTask;
  events: AgentEvent[];
  hasAuthError: boolean;
  canShowDiff: boolean;
  diffError: string | null;
  onShowDiff: () => void;
  onLogin: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onBack: () => void;
}) {
  const { taskId, row, live, events, hasAuthError, canShowDiff, diffError } = props;
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  const running = live?.running ?? row?.status === "running";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <button onClick={props.onBack} className="rounded px-2 py-1 hover:bg-zinc-800">
          ← 新任务
        </button>
        <span className="font-mono text-emerald-400">{row?.harness ?? live?.harness}</span>
        {row?.cwd && <span className="truncate font-mono text-zinc-500">{row.cwd}</span>}
        <span className="ml-auto font-mono">{taskId}</span>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300">
        {row?.prompt ?? live?.prompt}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <button
            onClick={props.onCancel}
            className="rounded-md border border-red-600 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
          >
            终止
          </button>
        ) : (
          <>
            {hasAuthError && (
              <button
                onClick={props.onLogin}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
              >
                🔑 唤起登录
              </button>
            )}
            <button
              onClick={props.onRetry}
              className="rounded-md border border-emerald-600 px-3 py-1.5 text-sm text-emerald-400 hover:bg-emerald-950"
            >
              重试任务
            </button>
            {canShowDiff && (
              <button
                onClick={props.onShowDiff}
                className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                查看 Diff
              </button>
            )}
            {diffError && <span className="text-xs text-red-400">{diffError}</span>}
          </>
        )}
        <span className="ml-auto text-xs text-zinc-500">
          {running
            ? "运行中…"
            : row?.status === "done"
              ? "已完成"
              : row?.status === "cancelled"
                ? "已取消"
                : `已退出（${row?.exit_code ?? live?.exitCode ?? "?"}）`}
        </span>
      </div>

      <div
        ref={logRef}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {events.length === 0 && (
          <div className="py-6 text-center text-zinc-600">（暂无日志）</div>
        )}
        {events.map((event, i) => (
          <EventLine key={i} event={event} />
        ))}
      </div>
    </div>
  );
}
