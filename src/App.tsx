import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

/** 与 Rust 侧 AgentEvent 严格对应的统一事件模型 */
type AgentEvent =
  | { type: "session_id"; id: string }
  | { type: "user_message"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; tool: string; detail: string }
  | { type: "tool_result"; tool: string; ok: boolean; detail: string }
  | { type: "status"; text: string }
  | { type: "complete"; ok: boolean }
  | { type: "error"; kind: string; message: string }
  | { type: "raw"; line: string };

type TaskState = {
  harness: string;
  cwd: string;
  events: { event: AgentEvent; key: number }[];
  running: boolean;
  exitCode: number | null;
  sessionId?: string;
};

const HARNESS_LABELS: Record<string, string> = {
  zcode: "ZCode (GLM)",
  codex: "Codex (GPT)",
};

let eventKey = 0;

export default function App() {
  const [harness, setHarness] = useState("zcode");
  const [mode, setMode] = useState("yolo");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tasks, setTasks] = useState<Record<string, TaskState>>({});
  const [error, setError] = useState<string | null>(null);
  const logBottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<{ taskId: string; event: AgentEvent }>("task-event", (e) => {
        const { taskId, event } = e.payload;
        setTasks((prev) => {
          const task = prev[taskId];
          if (!task) return prev;
          const sessionId =
            event.type === "session_id" ? event.id : task.sessionId;
          return {
            ...prev,
            [taskId]: {
              ...task,
              sessionId,
              events: [...task.events, { event, key: eventKey++ }],
            },
          };
        });
      }),
      listen<{ taskId: string; code: number | null }>("task-exit", (e) => {
        const { taskId, code } = e.payload;
        setTasks((prev) => {
          const task = prev[taskId];
          if (!task) return prev;
          return {
            ...prev,
            [taskId]: { ...task, running: false, exitCode: code },
          };
        });
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, []);

  // 日志面板自动滚到底部
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [tasks]);
  void logBottomRef;

  const startTask = async (resumeSessionId?: string) => {
    setError(null);
    if (!prompt.trim()) {
      setError("请输入任务描述");
      return;
    }
    try {
      const { task_id: taskId } = await invoke<{
        task_id: string;
      }>("start_task", {
        harness,
        cwd: cwd || ".",
        prompt,
        mode: harness === "zcode" ? mode : null,
        resumeSessionId: resumeSessionId ?? null,
      });
      setTasks((prev) => ({
        ...prev,
        [taskId]: {
          harness,
          cwd: cwd || ".",
          events: [],
          running: true,
          exitCode: null,
          sessionId: resumeSessionId,
        },
      }));
    } catch (e) {
      setError(String(e));
    }
  };

  const cancelTask = async (taskId: string) => {
    try {
      await invoke("cancel_task", { taskId });
    } catch (e) {
      setError(String(e));
    }
  };

  const currentTaskId = Object.keys(tasks).at(-1);
  const currentTask = currentTaskId ? tasks[currentTaskId] : undefined;

  return (
    <div className="flex h-full flex-col p-4 gap-3">
      {/* 顶部：harness 选择 */}
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

      {/* 任务表单 */}
      <div className="flex flex-col gap-2">
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="工作目录（可选，默认当前目录，如 E:\projects\demo）"
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
            onClick={() => startTask()}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
          >
            派任务
          </button>
          {currentTask?.sessionId && !currentTask.running && (
            <button
              onClick={() => startTask(currentTask.sessionId)}
              className="rounded-md border border-emerald-600 px-4 py-1.5 text-sm text-emerald-400 hover:bg-emerald-950"
            >
              续接会话
            </button>
          )}
          {currentTask?.running && (
            <button
              onClick={() => currentTaskId && cancelTask(currentTaskId)}
              className="rounded-md border border-red-600 px-4 py-1.5 text-sm text-red-400 hover:bg-red-950"
            >
              终止
            </button>
          )}
          {error && <span className="text-sm text-red-400">{error}</span>}
        </div>
      </div>

      {/* 任务卡片 */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {Object.entries(tasks).length === 0 && (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            还没有任务。选择 harness，输入任务描述，点「派任务」。
          </div>
        )}
        {Object.entries(tasks).map(([taskId, task]) => (
          <TaskCard key={taskId} taskId={taskId} task={task} />
        ))}
      </div>
    </div>
  );
}

function TaskCard({ taskId, task }: { taskId: string; task: TaskState }) {
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [task.events.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-zinc-800 bg-zinc-900/60">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        <span>
          <span className="font-mono text-emerald-400">{task.harness}</span>
          <span className="ml-2 font-mono">{taskId}</span>
          {task.sessionId && (
            <span className="ml-2 font-mono text-zinc-500">
              session: {task.sessionId}
            </span>
          )}
        </span>
        <span>
          {task.running
            ? "运行中…"
            : task.exitCode === 0
              ? "已完成"
              : `已退出（${task.exitCode ?? "未知"}）`}
        </span>
      </div>
      <div
        ref={logRef}
        className="min-h-40 flex-1 space-y-1.5 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {task.events.map(({ event, key }) => (
          <EventLine key={key} event={event} />
        ))}
      </div>
    </div>
  );
}

function EventLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "user_message":
      return (
        <div className="whitespace-pre-wrap text-sky-300">▶ {event.text}</div>
      );
    case "assistant_message":
      return (
        <div className="whitespace-pre-wrap text-zinc-100">{event.text}</div>
      );
    case "thinking":
      return (
        <div className="whitespace-pre-wrap text-zinc-500 italic">
          💭 {event.text}
        </div>
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
      return (
        <div className="text-emerald-400">✅ 任务{event.ok ? "完成" : "结束"}</div>
      );
    case "error":
      return (
        <div className="whitespace-pre-wrap text-red-400">✗ {event.message}</div>
      );
    case "raw":
      return (
        <div className="whitespace-pre-wrap text-zinc-600">{event.line}</div>
      );
    default:
      return null;
  }
}
