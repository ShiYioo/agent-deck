import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  buildSmartHandoffPrompt,
  cancelTask,
  getDefaultCwd,
  getTaskDiff,
  getTaskEvents,
  invokePiCommand,
  inTauri,
  listTasks,
  runLogin,
  setSetting,
  startTask,
} from "./api";
import type { AgentEvent, ApprovalRequest, LiveTask, TaskRow } from "./types";
import { piEventToAgentEvent } from "./types";
import { Sidebar, projectName, HARNESS_ACCENT } from "./components/Sidebar";
import { Rail } from "./components/Rail";
import { Composer } from "./components/Composer";
import { EventLine } from "./components/EventLine";
import { DiffModal } from "./components/DiffModal";
import { SettingsModal } from "./components/SettingsModal";
import {
  IconBrandMark,
  IconBack,
  IconKey,
  IconDiff,
  IconStop,
} from "./components/icons";

const emptyEvents: AgentEvent[] = [];

export default function App() {
  // composer 的全局默认值
  const [harness, setHarness] = useState("zcode");
  const [mode, setMode] = useState("yolo");
  const [model, setModel] = useState("");
  const [permission, setPermission] = useState("auto");
  const [cwd, setCwd] = useState("");

  // 运行态与历史
  const [live, setLive] = useState<Record<string, LiveTask>>({});
  const [history, setHistory] = useState<TaskRow[]>([]);
  const [historyEvents, setHistoryEvents] = useState<Record<string, AgentEvent[]>>({});
  const [selected, setSelected] = useState<string | null>(null);

  // diff 弹层
  const [diff, setDiff] = useState<{ taskId: string; text: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // 待审批的工具调用（deck 运行时 approved 模式）
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyHandoff, setBusyHandoff] = useState(false);

  const refreshHistory = useCallback(() => {
    listTasks().then(setHistory).catch(() => {});
  }, []);

  // 事件监听里读取最新 live 用的镜像
  const liveRef = useRef(live);
  liveRef.current = live;

  /** 窗口失焦时的系统通知（抄 VK 的 NotificationService） */
  const notify = useCallback(async (title: string, body: string) => {
    if (document.hasFocus()) return;
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title, body });
    } catch {
      // 通知失败不影响主流程
    }
  }, []);

  // 把排队消息作为续接任务派发（复用原 harness/cwd/mode 与会话）
  const flushQueued = useCallback(
    (task: LiveTask, text: string) => {
      startTask({
        harness: task.harness,
        cwd: task.cwd,
        prompt: text,
        mode: task.mode,
        model: null,
        permission: "auto",
        resumeSessionId: task.sessionId ?? null,
      })
        .then((taskId) => {
          setLive((prev) => ({
            ...prev,
            [taskId]: {
              harness: task.harness,
              cwd: task.cwd,
              prompt: text,
              mode: task.mode,
              events: [],
              running: true,
              exitCode: null,
              sessionId: task.sessionId,
            },
          }));
          setSelected(taskId);
          setTimeout(refreshHistory, 200);
        })
        .catch((e) => setActionError(String(e)));
    },
    [refreshHistory],
  );

  // 工作目录：启动时取默认（设置里的 default_cwd，否则家目录）
  useEffect(() => {
    getDefaultCwd()
      .then((d) => setCwd((cur) => cur || d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshHistory();
    if (!inTauri) return; // 纯浏览器预览：无 IPC 桥，跳过事件监听
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
        const task = liveRef.current[taskId];
        if (task) {
          notify(
            code === 0 ? "AgentDeck · 任务完成" : "AgentDeck · 任务结束",
            `${task.harness}：${task.prompt.slice(0, 40)}`,
          );
          // 队列续发：成功且有会话 → 取队首消息作为续接派发（抄 VK 队列消息）
          if (code === 0 && task.queued && task.queued.length > 0 && task.sessionId) {
            const [next] = task.queued;
            flushQueued(task, next);
            setLive((prev) => ({
              ...prev,
              [taskId]: { ...prev[taskId], queued: prev[taskId].queued?.slice(1) },
            }));
          }
        }
        setLive((prev) => {
          const t = prev[taskId];
          if (!t) return prev;
          return { ...prev, [taskId]: { ...t, running: false, exitCode: code } };
        });
        setTimeout(refreshHistory, 300);
      }),
      // deck（pi 运行时）事件：归一化到统一渲染管道；退出由 task-exit 之外的
      // deck_run_end 体现，这里同时以 task-exit 兜底
      listen<Record<string, unknown>>("pi-event", (e) => {
        const payload = e.payload as { taskId?: string } & Record<string, unknown>;
        const taskId = payload.taskId;
        if (!taskId) return;
        // 审批请求：单独呈现在操作区
        if (payload.type === "deck_approval_request") {
          setApproval({
            id: String(payload.id ?? ""),
            tool: String(payload.tool ?? "tool"),
            args: (payload.args as Record<string, unknown>) ?? {},
          });
          notify(
            "AgentDeck · 需要审批",
            `Agent 请求执行工具：${payload.tool ?? "tool"}`,
          );
          return;
        }
        if (payload.type === "deck_approval_decided") {
          setApproval(null);
        }
        const mapped = piEventToAgentEvent(payload as never);
        setLive((prev) => {
          const task = prev[taskId];
          if (!task) return prev;
          const events = mapped ? [...task.events, { event: mapped, key: nextKey() }] : task.events;
          const running =
            payload.type === "deck_run_end"
              ? false
              : payload.type === "deck_run_start"
                ? true
                : task.running;
          return { ...prev, [taskId]: { ...task, events, running } };
        });
        if (payload.type === "deck_run_end") {
          setApproval(null);
          setTimeout(refreshHistory, 300);
        }
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, [refreshHistory]);

  // 发送：选中已完成任务且有会话 ID → 续接；否则开新任务
  const handleSend = useCallback(
    async (text: string) => {
      setActionError(null);
      const row = selected ? history.find((t) => t.id === selected) : undefined;
      // 运行中：消息入队（抄 VK queued message），任务成功结束后自动续发
      if (selected && liveRef.current[selected]?.running) {
        setLive((prev) => ({
          ...prev,
          [selected]: {
            ...prev[selected],
            queued: [...(prev[selected].queued ?? []), text],
          },
        }));
        return;
      }
    // deck 执行器的 key 已在设置面板持久化（SQLite），Rust 侧自行读取
    const canResume = !!row && !!row.session_id && row.status !== "running";
    // 记住这次的工作目录，下次启动作为默认
    const useCwd = canResume ? row.cwd : cwd || ".";
    if (!canResume && cwd.trim()) {
      setSetting("default_cwd", cwd.trim()).catch(() => {});
    }
    try {
      const taskId = await startTask({
        harness: canResume ? row.harness : harness,
        cwd: useCwd,
        prompt: text,
        mode: canResume ? row.mode : mode === "default" ? null : mode,
        model: canResume ? row.model : model.trim() || null,
        permission: canResume ? null : permission,
        resumeSessionId: canResume ? row.session_id : null,
      });
      setLive((prev) => ({
        ...prev,
        [taskId]: {
          harness: canResume ? row.harness : harness,
          cwd: useCwd,
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
    },
    [selected, harness, mode, model, cwd, history, permission, flushQueued, refreshHistory],
  );

  // 查看任务：优先实时缓冲，否则回放数据库事件
  const historyEventsRef = useRef(historyEvents);
  historyEventsRef.current = historyEvents;
  const viewTask = useCallback(async (taskId: string) => {
    setSelected(taskId);
    if (liveRef.current[taskId] || historyEventsRef.current[taskId]) return;
    try {
      const events = await getTaskEvents(taskId);
      setHistoryEvents((prev) => ({ ...prev, [taskId]: events }));
    } catch {
      setHistoryEvents((prev) => ({ ...prev, [taskId]: [] }));
    }
  }, []);

  const recentModels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of history) {
      if (t.model && t.harness === harness) {
        counts.set(t.model, (counts.get(t.model) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  }, [history, harness]);

  const handleSelect = useCallback(
    (id: string) => {
      void viewTask(id);
    },
    [viewTask],
  );

  const selectedRow = selected ? history.find((t) => t.id === selected) : undefined;
  const selectedLive = selected ? live[selected] : undefined;
  const selectedEvents =
    useMemo(
      () =>
        selectedLive?.events.map((e) => e.event) ??
        (selected ? historyEvents[selected] : undefined) ??
        emptyEvents,
      [selectedLive, selected, historyEvents],
    );
  const selectedRunning = selectedLive?.running ?? selectedRow?.status === "running";
  const selectedSession = selectedLive?.sessionId ?? selectedRow?.session_id ?? null;
  const selectedCanResume = !!selectedRow && !!selectedSession && !selectedRunning;
  const selectedHarness = selectedRow?.harness ?? selectedLive?.harness ?? harness;
  const hasAuthError = selectedEvents.some(
    (e) => e.type === "error" && e.kind === "auth",
  );
  const hasQuotaError = selectedEvents.some(
    (e) => e.type === "error" && e.kind === "quota",
  );
  const canShowDiff = !!selectedRow && selectedRow.status === "done";

  // 会话接力：会话记录压缩为交接简报 → 派给目标 harness（同一工作目录）
  const handoff = async (target: string) => {
    if (!selectedRow || busyHandoff) return;
    setBusyHandoff(true);
    setActionError(null);
    try {
      const briefing = await buildSmartHandoffPrompt(selectedRow.id);
      const taskId = await startTask({
        harness: target,
        cwd: selectedRow.cwd,
        prompt: briefing,
        mode: target === "zcode" ? "yolo" : target === "codex" ? "full" : null,
        model: null,
        permission: "auto",
        resumeSessionId: null,
      });
      setLive((prev) => ({
        ...prev,
        [taskId]: {
          harness: target,
          cwd: selectedRow.cwd,
          prompt: `（接力自 ${selectedRow.harness}）${selectedRow.prompt}`,
          mode: null,
          events: [],
          running: true,
          exitCode: null,
        },
      }));
      setSelected(taskId);
      setTimeout(refreshHistory, 200);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusyHandoff(false);
    }
  };

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
      <Rail onNew={() => setSelected(null)} onSettings={() => setSettingsOpen(true)} />
      <Sidebar tasks={history} selectedId={selected} onSelect={handleSelect} />

      <main className="flex min-w-0 flex-1 flex-col">
        {selected === null ? (
          // ── 空态：菱形晶格底纹 + 品牌符浮动 + 错落入场 ──
          <div
            key="empty"
            className="anim-scene relative flex flex-1 flex-col items-center justify-center px-8"
          >
            <div className="grid-bg pointer-events-none absolute inset-0" />
            <div className="float-slow anim-rise relative mb-8 text-stone-300">
              <IconBrandMark size={56} />
            </div>
            <div
              className="anim-rise relative text-2xl font-medium tracking-tight text-stone-800"
              style={{ animationDelay: "70ms" }}
            >
              我们应该在
              <span className="mx-1 border-b-2 border-dotted border-stone-400">
                {projectName(cwd)}
              </span>
              中做些什么？
            </div>
          </div>
        ) : (
          // ── 任务详情视图 ──
          <div
            key={`task-${selected}`}
            className="anim-scene flex min-h-0 flex-1 flex-col"
          >
            <div className="flex items-center gap-2 border-b border-stone-200/70 px-6 py-3 text-sm">
              <button
                onClick={() => setSelected(null)}
                className="rounded-md p-1.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
                title="返回新任务"
              >
                <IconBack size={15} />
              </button>
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: HARNESS_ACCENT[selectedHarness] }}
              />
              <span
                className="font-mono text-xs"
                style={{ color: HARNESS_ACCENT[selectedHarness] }}
              >
                {selectedHarness}
              </span>
              <span className="truncate text-stone-500">
                {selectedRow?.cwd ?? selectedLive?.cwd}
              </span>
              <span className="flex-1" />
              {selectedRunning && (
                <button
                  onClick={() => selected && cancelTask(selected).catch(() => {})}
                  className="flex items-center gap-1.5 rounded-full border border-red-200 px-3 py-1 text-xs text-red-600 transition-colors hover:bg-red-50"
                >
                  <IconStop size={13} />
                  终止
                </button>
              )}
              <span className="text-xs text-stone-400">
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
                    className="flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 font-medium text-amber-700 transition-colors hover:bg-amber-100"
                  >
                    <IconKey size={13} />
                    唤起登录
                  </button>
                )}
                {canShowDiff && (
                  <button
                    onClick={showDiff}
                    className="flex items-center gap-1.5 rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition-colors hover:bg-stone-100"
                  >
                    <IconDiff size={13} />
                    查看 Diff
                  </button>
                )}
                {selectedCanResume && (
                  <span className="text-stone-400">在下方输入可续接此会话</span>
                )}
                {actionError && <span className="text-red-600">{actionError}</span>}
              </div>
            )}

            {/* 会话接力：把会话记录交给另一个 harness 继续（额度/登录失败时的正解） */}
            {!selectedRunning && selectedRow && (
              <div className="mx-6 mt-2 rounded-xl border border-stone-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-stone-600">
                    {hasQuotaError
                      ? "额度可能已耗尽——把会话记录交给其他 harness 接力："
                      : "会话接力："}
                  </span>
                  {(["deck", "zcode", "codex", "opencode"] as const)
                    .filter((h) => h !== selectedRow.harness)
                    .map((h) => (
                      <button
                        key={h}
                        onClick={() => handoff(h)}
                        disabled={busyHandoff}
                        className="flex items-center gap-1.5 rounded-full border px-3 py-1 transition-colors hover:bg-stone-100 disabled:opacity-50"
                        style={{ borderColor: HARNESS_ACCENT[h], color: HARNESS_ACCENT[h] }}
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: HARNESS_ACCENT[h] }}
                        />
                        用 {h === "deck" ? "AgentDeck Agent" : h} 接力
                      </button>
                    ))}
                  <span className="flex-1" />
                  <span className="text-stone-400">
                    会话记录将随首条消息一并注入，工作目录不变
                  </span>
                </div>
                {busyHandoff && (
                  <div className="typing-dots mt-2 flex items-center text-xs text-stone-400">
                    正在由 AgentDeck 运行时压缩会话记录…
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>
            )}

            {/* 审批卡片：deck 运行时 approved 模式的工具授权 */}
            {approval && selectedRunning && (
              <div className="anim-pop mx-6 mt-2 rounded-xl border border-amber-300 bg-amber-50/70 p-3">
                <div className="text-xs font-medium text-amber-800">
                  Agent 请求执行工具：<span className="font-mono">{approval.tool}</span>
                </div>
                <pre className="mt-1.5 max-h-32 overflow-auto rounded-md bg-white/80 p-2 font-mono text-[10px] leading-relaxed text-stone-600">
                  {JSON.stringify(approval.args, null, 2)}
                </pre>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() =>
                      selected &&
                      invokePiCommand(selected, "approve", approval.id).finally(() =>
                        setApproval(null),
                      )
                    }
                    className="rounded-full bg-emerald-600 px-3.5 py-1 font-medium text-white transition-colors hover:bg-emerald-500"
                  >
                    允许
                  </button>
                  <button
                    onClick={() =>
                      selected &&
                      invokePiCommand(selected, "reject", approval.id).finally(() =>
                        setApproval(null),
                      )
                    }
                    className="rounded-full border border-red-300 px-3.5 py-1 font-medium text-red-600 transition-colors hover:bg-red-50"
                  >
                    拒绝
                  </button>
                  <span className="text-stone-400">执行将阻塞等待你的决定</span>
                </div>
              </div>
            )}

            <LogPanel key={selected} events={selectedEvents} running={selectedRunning} />
          </div>
        )}

        {/* 底部输入卡：始终可见。运行中发送 = 入队（结束后自动续发） */}
        <div className="px-6 pb-5 pt-2">
          {selected && selectedLive?.queued && selectedLive.queued.length > 0 && (
            <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-1.5 pb-1.5 text-xs">
              <span className="text-stone-400">已排队（结束后自动续发）：</span>
              {selectedLive.queued.map((q, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1 rounded-full border border-stone-200 px-2 py-0.5 text-stone-500"
                >
                  <span className="max-w-48 truncate">{q}</span>
                  <button
                    onClick={() =>
                      setLive((prev) => {
                        const t = prev[selected];
                        if (!t) return prev;
                        return {
                          ...prev,
                          [selected]: {
                            ...t,
                            queued: t.queued?.filter((_, j) => j !== i),
                          },
                        };
                      })
                    }
                    className="text-stone-400 hover:text-red-500"
                    title="移除"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <Composer
            cwd={cwd}
            onCwdChange={setCwd}
            harness={harness}
            onHarnessChange={(h) => {
              setHarness(h);
              setModel(""); // 切 harness 时模型目录不同，重置
              // 权限目录随 harness 变化，重置为各家默认
              setMode(h === "zcode" ? "yolo" : h === "codex" ? "full" : "default");
            }}
            mode={mode}
            onModeChange={setMode}
            model={model}
            onModelChange={setModel}
            permission={permission}
            onPermissionChange={setPermission}
            onSend={handleSend}
            running={selectedRunning}
            recentModels={recentModels}
            placeholder={
              selectedRunning
                ? "运行中——发送将排队，任务结束后自动续发"
                : selectedCanResume
                  ? "续接此会话…"
                  : "随心输入"
            }
          />
        </div>

        {diff && <DiffModal text={diff.text} onClose={() => setDiff(null)} />}
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </main>
    </div>
  );
}

/** 日志 DOM 渲染上限：更早的条目留在库里（回放/导出不受限），界面只挂尾部 */
const MAX_RENDER = 500;

/** 会话日志面板：历史回放时错落入场，实时流式时逐条滑入；rAF 节流自动滚底 */
function LogPanel({
  events,
  running,
}: {
  events: AgentEvent[];
  running: boolean;
}) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const prevCount = useRef(0);
  const scrollPending = useRef(false);
  const staggerInitial = prevCount.current === 0 && events.length > 0;

  useEffect(() => {
    if (scrollPending.current) return;
    scrollPending.current = true;
    requestAnimationFrame(() => {
      scrollPending.current = false;
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    });
    prevCount.current = events.length;
  }, [events.length]);

  const overflow = events.length - MAX_RENDER;
  const visible = overflow > 0 ? events.slice(overflow) : events;

  return (
    <div
      ref={logRef}
      className="log-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-4 font-mono text-xs leading-relaxed"
    >
      {overflow > 0 && (
        <div className="py-1 text-center text-[10px] text-stone-400">
          前 {overflow} 条已折叠（完整记录在数据库中）
        </div>
      )}
      {events.length === 0 && (
        <div className="py-10 text-center text-stone-400">
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
      {visible.map((event, i) => (
        <EventLine
          key={Math.max(overflow, 0) + i}
          event={event}
          stagger={staggerInitial ? i : 0}
        />
      ))}
    </div>
  );
}

let eventKey = 0;
const nextKey = () => eventKey++;
