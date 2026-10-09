import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft, SquarePen, Copy, Check, ArrowDown, GitBranch } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  buildSmartHandoffPrompt,
  cancelTask,
  discardTaskWorktree,
  listProjects as listProjectsApi,
  mergeTaskWorktree,
  getDefaultCwd,
  getSetting,
  getTaskDiff,
  getTaskEvents,
  invokePiCommand,
  inTauri,
  listTasks,
  runLogin,
  setSetting,
  startTask,
} from "./api";
import type { AgentEvent, ApprovalRequest, LiveTask, ProjectRow, TaskRow } from "./types";
import { piEventToAgentEvent } from "./types";
import { Sidebar, projectName, HARNESS_ACCENT, directoryKey } from "./components/Sidebar";
import { HarnessIcon } from "./components/HarnessIcon";
import { Composer } from "./components/Composer";
import { EventLine } from "./components/EventLine";
import { DiffModal } from "./components/DiffModal";
import { SettingsPage } from "./components/SettingsPage";
import { CreateProjectModal } from "./components/CreateProjectModal";
import { TitleBar } from "./components/TitleBar";
import { MotionLayer, useMotionPolicy } from "./motion/MotionProvider";
import { useFrameQueue } from "./hooks/useFrameQueue";
import { useAutoScroll } from "./hooks/useAutoScroll";
import { Disclosure } from "./components/Disclosure";
import {
  IconBack,
  IconKey,
  IconDiff,
  IconStop,
} from "./components/icons";

type LogItem = { event: AgentEvent; key: number };
const emptyEvents: LogItem[] = [];
type TaskUpdate = {
  taskId: string;
  item?: LogItem;
  running?: boolean;
  todos?: LiveTask["todos"];
};

export default function App() {
  const { enabled: motionEnabled } = useMotionPolicy();
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
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [busyHandoff, setBusyHandoff] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openCreateProject = useCallback(() => setCreateProjectOpen(true), []);
  const closeCreateProject = useCallback(() => setCreateProjectOpen(false), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const closeDiff = useCallback(() => setDiff(null), []);
  const chooseProject = useCallback((id: string | null) => {
    setSelectedProjectId(id);
    const project = projects.find((item) => item.id === id);
    if (project) setCwd(project.dir);
  }, [projects]);
  const chooseHarness = useCallback((next: string) => {
    setHarness(next);
    setModel("");
    setMode(next === "zcode" ? "yolo" : next === "codex" ? "full" : "default");
  }, []);
  const stopSelected = useCallback(() => {
    if (selected) cancelTask(selected).catch((e) => setActionError(String(e)));
  }, [selected]);

  const newChat = useCallback((project?: ProjectRow) => {
    setSelected(null);
    setActionError(null);
    if (project) {
      setSelectedProjectId(project.id || null);
      setCwd(project.dir);
    }
    if (window.innerWidth <= 760) setSidebarOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n" && !settingsOpen && !createProjectOpen && !diff) {
        e.preventDefault();
        newChat();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [newChat, settingsOpen, createProjectOpen, diff]);

  const refreshHistory = useCallback(() => {
    listTasks().then(setHistory).catch(() => {});
    listProjectsApi().then(setProjects).catch(() => {});
  }, []);

  // 事件监听里读取最新 live 用的镜像
  const liveRef = useRef(live);
  liveRef.current = live;
  const sessionIds = useRef(new Map<string, string>());
  const { enqueue: enqueueUpdate, flush: flushUpdates } = useFrameQueue<TaskUpdate>((batch) => {
    const groups = new Map<string, TaskUpdate[]>();
    for (const update of batch) {
      const group = groups.get(update.taskId);
      if (group) group.push(update);
      else groups.set(update.taskId, [update]);
    }
    setLive((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [id, updates] of groups) {
        const task = prev[id];
        if (!task) continue;
        const appended: LogItem[] = [];
        let running = task.running;
        let todos = task.todos;
        let sessionId = task.sessionId;
        for (const update of updates) {
          if (update.item) {
            appended.push(update.item);
            if (update.item.event.type === "session_id") sessionId = update.item.event.id;
          }
          if (update.running !== undefined) running = update.running;
          if (update.todos !== undefined) todos = update.todos;
        }
        next[id] = { ...task, running, todos, sessionId, events: appended.length ? [...task.events, ...appended] : task.events };
        changed = true;
      }
      return changed ? next : prev;
    });
  });

  /** 窗口失焦时的系统通知（抄 VK 的 NotificationService） */
  const notify = useCallback(async (title: string, body: string) => {
    if (document.hasFocus()) return;
    try {
      const enabled = await getSetting("notifications_enabled");
      if (enabled === "off") return;
    } catch {}
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
        if (event.type === "session_id") sessionIds.current.set(taskId, event.id);
        enqueueUpdate({ taskId, item: { event, key: nextKey() } });
      }),
      listen<{ taskId: string; code: number | null }>("task-exit", (e) => {
        const { taskId, code } = e.payload;
        flushUpdates();
        const current = liveRef.current[taskId];
        const task = current ? { ...current, sessionId: sessionIds.current.get(taskId) ?? current.sessionId } : undefined;
        sessionIds.current.delete(taskId);
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
        if (payload.type === "deck_todo_updated" && Array.isArray(payload.todos)) {
          const todos = payload.todos as { content: string; status: string }[];
          enqueueUpdate({ taskId, todos });
        }
        const mapped = piEventToAgentEvent(payload as never);
        const running = payload.type === "deck_run_end" ? false : payload.type === "deck_run_start" ? true : undefined;
        if (mapped || running !== undefined) enqueueUpdate({ taskId, item: mapped ? { event: mapped, key: nextKey() } : undefined, running });
        if (payload.type === "deck_run_end") {
          flushUpdates();
          setApproval(null);
          setTimeout(refreshHistory, 300);
        }
      }),
      // watcher 推流：弹层打开且归属匹配时更新 diff 文本
      listen<{ taskId: string; text: string }>("diff-update", (e) => {
        const { taskId, text } = e.payload;
        if (diffRef.current?.taskId === taskId) {
          setDiff({ taskId, text });
        }
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, [refreshHistory, enqueueUpdate, flushUpdates]);

  // 发送：@ 智能体唤醒（可并行）；选中已完成任务且有会话 ID → 续接；否则开新任务
  const handleSend = useCallback(
    async (rawText: string) => {
      setActionError(null);

      // @ 路由：@harness 或 @harness:model 唤醒对应智能体（模型粒度指定大脑）
      const at = /^@(deck|zcode|codex|opencode)(?::([^\s]+))?\s+/i.exec(
        rawText.trim(),
      );
      let text = rawText.trim();
      let atTarget: string | null = null;
      let atModel: string | null = null;
      if (at) {
        atTarget = at[1].toLowerCase();
        // zcode CLI 无模型旗标，@zcode:xxx 的模型部分被忽略（走账号默认）
        atModel = at[2] && atTarget !== "zcode" ? at[2] : null;
        text = text.slice(at[0].length);
      }
      if (!text.trim()) {
        setActionError("请输入任务描述");
        return false;
      }

      const row = selected ? history.find((t) => t.id === selected) : undefined;
      const runningTask = selected ? liveRef.current[selected] : undefined;

      // 运行中排队：仅当未 @ 其他智能体（@ 别家 = 并行唤醒新任务）
      if (
        selected &&
        runningTask?.running &&
        (!atTarget || atTarget === runningTask.harness)
      ) {
        setLive((prev) => ({
          ...prev,
          [selected]: {
            ...prev[selected],
            queued: [...(prev[selected].queued ?? []), text],
          },
        }));
        return true;
      }

      // @ 路由的任务是全新派发（不续接旧会话）
      const routeFresh = atTarget !== null;
      const useHarness = routeFresh ? (atTarget as string) : harness;
      const routeModel = routeFresh ? atModel : model.trim() || null;
      // deck 执行器的 key 已在设置面板持久化（SQLite），Rust 侧自行读取
      const canResume =
        !routeFresh &&
        !!row &&
        !!row.session_id &&
        row.status !== "running" &&
        // @ 同一家且在运行的情况已在上面排队处理
        true;
      // 记住这次的工作目录，下次启动作为默认
      const useCwd = routeFresh ? cwd || "." : canResume ? row.cwd : cwd || ".";
      if (!routeFresh && cwd.trim()) {
        setSetting("default_cwd", cwd.trim()).catch(() => {});
      }
      try {
        const taskId = await startTask({
          harness: canResume ? row.harness : useHarness,
          cwd: useCwd,
          prompt: text,
          mode: canResume
            ? row.mode
            : useHarness === "deck"
              ? null
              : useHarness === "zcode"
                ? mode
                : mode === "default"
                  ? null
                  : mode,
          model: canResume ? row.model : routeModel,
          permission: canResume ? null : permission,
          resumeSessionId: canResume ? row.session_id : null,
          projectId:
            selectedProjectId ??
            projects.find(
              (p) => p.dir.split("\\").join("/") === (useCwd || "").split("\\").join("/"),
            )?.id ??
            null,
        });
        setLive((prev) => ({
          ...prev,
          [taskId]: {
            harness: canResume ? row.harness : useHarness,
            cwd: useCwd,
            prompt: text,
            mode: canResume
              ? row.mode
              : useHarness === "deck"
                ? null
                : useHarness === "zcode"
                  ? mode
                  : mode === "default"
                    ? null
                    : mode,
            events: [],
            running: true,
            exitCode: null,
            sessionId: canResume ? row.session_id ?? undefined : undefined,
          },
        }));
        setSelected(taskId);
        setTimeout(refreshHistory, 200);
        return true;
      } catch (e) {
        setActionError(String(e));
        return false;
      }
    },
    [
      selected,
      harness,
      mode,
      model,
      cwd,
      history,
      permission,
      flushQueued,
      refreshHistory,
      selectedProjectId,
      projects,
    ],
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
      const row = history.find((t) => t.id === id);
      if (row) {
        setCwd(row.cwd);
        setSelectedProjectId(row.project_id ?? projects.find((p) => directoryKey(p.dir) === directoryKey(row.cwd))?.id ?? null);
        setHarness(row.harness);
        setMode(row.mode ?? "default");
        setModel(row.model ?? "");
      }
      setActionError(null);
      if (window.innerWidth <= 760) setSidebarOpen(false);
      void viewTask(id);
    },
    [viewTask, history, projects],
  );

  const selectedRow = selected ? history.find((t) => t.id === selected) : undefined;
  const selectedLive = selected ? live[selected] : undefined;
  // 条目携带稳定 key：live 用追加时分配的递增 key，回放用序号。
  // LogPanel 超 500 条折叠后 key 不漂移，避免每条新事件全列表重渲染。
  const selectedEvents = useMemo<LogItem[]>(
    () =>
      selectedLive?.events ??
      (selected
        ? (historyEvents[selected] ?? emptyEvents).map((event, i) => ({
            event,
            key: i,
          }))
        : emptyEvents),
    [selectedLive, selected, historyEvents],
  );
  const selectedRunning = selectedLive?.running ?? selectedRow?.status === "running";
  const selectedSession = selectedLive?.sessionId ?? selectedRow?.session_id ?? null;
  const selectedCanResume = !!selectedRow && !!selectedSession && !selectedRunning;
  const selectedHarness = selectedRow?.harness ?? selectedLive?.harness ?? harness;
  const hasAuthError = selectedEvents.some(
    ({ event: e }) => e.type === "error" && e.kind === "auth",
  );
  const hasQuotaError = selectedEvents.some(
    ({ event: e }) => e.type === "error" && e.kind === "quota",
  );
  // 运行中也可查看（实时轮询）；完成后为静态快照
  // 实时 Diff watcher：弹层打开且任务运行中时监听工作目录，关闭/结束即停
  const diffTaskId = diff?.taskId ?? null;
  useEffect(() => {
    if (!inTauri || !diffTaskId || !selectedRunning) return;
    const cwd = selectedRowRef.current?.cwd;
    if (!cwd) return;
    invoke("diff_watch_start", { taskId: diffTaskId, cwd }).catch(() => {});
    return () => {
      invoke("diff_watch_stop", { taskId: diffTaskId }).catch(() => {});
    };
  }, [diffTaskId, selectedRunning]);


  // Esc 终止运行中的任务（Codex 桌面端习惯；输入框/弹层聚焦时除外）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (diff || settingsOpen || approval) return; // 弹层/审批有自己的 Esc 语义
      if (!selectedRunning || !selected) return;
      e.preventDefault();
      cancelTask(selected).catch(() => {});
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedRunning, selected, diff, settingsOpen, approval]);


  const canShowDiff = !!selectedRow;

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

  const showDiff = useCallback(async () => {
    if (!selected) return;
    setActionError(null);
    try {
      const text = await getTaskDiff(selected);
      setDiff({ taskId: selected, text });
    } catch (e) {
      setActionError(String(e));
    }
  }, [selected]);

  // watcher 推流的弹层归属镜像
  const diffRef = useRef(diff);
  diffRef.current = diff;
  const selectedRowRef = useRef(selectedRow);
  selectedRowRef.current = selectedRow;

  return (
    <div className="app-viewport">
      <TitleBar />
      <div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      <AnimatePresence initial={false}>
        {sidebarOpen && <MotionLayer key="sidebar-scrim" className="sidebar-scrim-holder">
          <button className="sidebar-scrim" aria-label="关闭侧栏" onClick={closeSidebar} />
        </MotionLayer>}
        {sidebarOpen && <MotionLayer key="sidebar" preset="sidebar" className="sidebar-host"
          initial={motionEnabled ? { width: 0, opacity: 0, x: -12 } : false}
          animate={{ width: "auto", opacity: 1, x: 0 }}
          exit={{ width: 0, opacity: motionEnabled ? 0 : 1, x: motionEnabled ? -12 : 0 }}>
          <Sidebar tasks={history} projects={projects} selectedId={selected} onSelect={handleSelect}
            onNew={newChat} onSettings={openSettings} onCreateProject={openCreateProject}
            onCollapse={closeSidebar} />
        </MotionLayer>}
      </AnimatePresence>
      <AnimatePresence>
      {createProjectOpen && (
        <CreateProjectModal
          key="create-project"
          onClose={closeCreateProject}
          onCreated={(dir) => {
            setCreateProjectOpen(false);
            setCwd(dir); // 新项目即当前上下文
            refreshHistory();
          }}
        />
      )}
      </AnimatePresence>

      <main className={`workspace-main ${selected === null ? "is-new" : ""}`}>
        <header className="workspace-header">
          {!sidebarOpen && <button className="icon-button" title="展开侧栏" aria-label="展开侧栏" onClick={() => setSidebarOpen(true)}><PanelLeft size={18} /></button>}
          <span className="workspace-title">{selected ? selectedRow?.prompt ?? selectedLive?.prompt ?? "聊天" : "新聊天"}</span>
          <div className="workspace-header-actions">
            <span className="workspace-project"><GitBranch size={14} />{projectName(selectedRow?.cwd ?? cwd)}</span>
            <button className="icon-button" title="新聊天" aria-label="新聊天" onClick={() => newChat()}><SquarePen size={17} /></button>
          </div>
        </header>
        {selected === null ? (
          // New chats share the same composer as active conversations.
          <MotionLayer preset="scene"
            key="empty"
            className="new-chat-heading"
          >
            <h1>开始新的任务</h1>
            {cwd && <span className="new-chat-project">{projects.find((p) => directoryKey(p.dir) === directoryKey(cwd))?.name ?? projectName(cwd)}</span>}
          </MotionLayer>
        ) : (
          // ── 任务详情视图 ──
          <MotionLayer preset="scene"
            key={`task-${selected}`}
            className="task-view flex min-h-0 flex-1 flex-col"
          >
            <div className="flex items-center gap-2 border-b border-stone-200/70 px-6 py-3 text-sm">
              <button
                onClick={() => setSelected(null)}
                className="rounded-md p-1.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
                title="返回新任务"
              >
                <IconBack size={15} />
              </button>
              <HarnessIcon harness={selectedHarness} size={16} rounded />
              <span
                className="font-mono text-xs"
                style={{ color: HARNESS_ACCENT[selectedHarness] }}
              >
                {selectedHarness}
              </span>
              <span className="truncate text-stone-500">
                {selectedRow?.cwd ?? selectedLive?.cwd}
              </span>
              {selectedLive?.todos && selectedLive.todos.length > 0 && (
                <span className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] text-stone-600">
                  ☐ {selectedLive.todos.filter((t) => t.status === "completed").length}
                  /{selectedLive.todos.length}
                  {selectedLive.todos.find((t) => t.status === "in_progress") && (
                    <span className="ml-1.5 text-stone-400">
                      {selectedLive.todos.find((t) => t.status === "in_progress")?.content.slice(0, 24)}
                    </span>
                  )}
                </span>
              )}
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

            <div className="flex flex-wrap items-center gap-2 px-6 pt-2 text-xs">
                {!selectedRunning && selectedRow?.status === "failed" && (
                  <button
                    onClick={() => {
                      const r = selectedRow;
                      setActionError(null);
                      startTask({
                        harness: r.harness,
                        cwd: r.cwd,
                        prompt: r.prompt,
                        mode: r.mode,
                        model: r.model,
                        permission: null,
                        resumeSessionId: r.session_id,
                      })
                        .then((taskId) => {
                          setLive((prev) => ({
                            ...prev,
                            [taskId]: {
                              harness: r.harness,
                              cwd: r.cwd,
                              prompt: r.prompt,
                              mode: r.mode,
                              events: [],
                              running: true,
                              exitCode: null,
                              sessionId: r.session_id ?? undefined,
                            },
                          }));
                          setSelected(taskId);
                          setTimeout(refreshHistory, 200);
                        })
                        .catch((e) => setActionError(String(e)));
                    }}
                    className="rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition-colors hover:bg-stone-100"
                  >
                    ↻ 重试
                  </button>
                )}
                {hasAuthError && !selectedRunning && (
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
                    {selectedRunning ? "实时 Diff" : "查看 Diff"}
                  </button>
                )}
                {canShowDiff && selectedRow?.base_branch && (
                  <>
                    <button
                      onClick={async () => {
                        if (!selected) return;
                        setActionError(null);
                        try {
                          await mergeTaskWorktree(selected);
                          refreshHistory();
                        } catch (e) {
                          setActionError(String(e));
                        }
                      }}
                      className="rounded-full bg-emerald-600 px-3 py-1 font-medium text-white transition-colors hover:bg-emerald-500"
                    >
                      合并到主分支
                    </button>
                    <button
                      onClick={async () => {
                        if (!selected) return;
                        setActionError(null);
                        try {
                          await discardTaskWorktree(selected);
                          refreshHistory();
                        } catch (e) {
                          setActionError(String(e));
                        }
                      }}
                      className="rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition-colors hover:bg-stone-100"
                    >
                      放弃 worktree
                    </button>
                  </>
                )}
            </div>

            {/* 会话接力：把会话记录交给另一个 harness 继续（额度/登录失败时的正解） */}
            {!selectedRunning && selectedRow && (
              <Disclosure className="handoff-section mx-6 mt-2" title="会话接力">
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
                        <HarnessIcon harness={h} size={12} />
                        用 {h === "deck" ? "AgentDeck Agent" : h} 接力
                      </button>
                    ))}
                </div>
                {busyHandoff && (
                  <div className="typing-dots mt-2 flex items-center text-xs text-stone-400">
                    正在由 AgentDeck 运行时压缩会话记录…
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </Disclosure>
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
          </MotionLayer>
        )}

        {/* 底部输入卡：始终可见。运行中发送 = 入队（结束后自动续发） */}
        <m.div className="composer-dock" layout={motionEnabled ? "position" : false} layoutDependency={selected === null}>
          {actionError && <div className="action-error" role="alert">{actionError}</div>}
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
            draftKey={selected ?? "new"}
            onStop={stopSelected}
            cwd={cwd}
            onCwdChange={setCwd}
            projects={projects}
            selectedProjectId={selectedProjectId}
            onProjectSelect={chooseProject}
            harness={harness}
            onHarnessChange={chooseHarness}
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
                ? "补充任务…"
                : selectedCanResume
                  ? "续接此会话…"
                  : "描述任务，或提出问题…"
            }
          />
        </m.div>

        <AnimatePresence>
        {diff && selectedRow && (
          <DiffModal
            key={`diff-${diff.taskId}`}
            text={diff.text}
            running={selectedRunning}
            harness={selectedRow.harness}
            model={selectedRow.model}
            mode={selectedRow.mode}
            onClose={closeDiff}
          />
        )}
        {settingsOpen && <SettingsPage key="settings" onClose={closeSettings} />}
        </AnimatePresence>
      </main>
      </div>
    </div>
  );
}

/** 日志 DOM 渲染上限：更早的条目留在库里（回放/导出不受限），界面只挂尾部 */
const MAX_RENDER = 500;

/** 事件 → 可复制纯文本（消息/工具/错误摘要） */
function eventsToText(events: { event: AgentEvent }[]): string {
  return events
    .map(({ event: e }) => {
      switch (e.type) {
        case "user_message":
          return `[用户] ${e.text}`;
        case "assistant_message":
          return `[助手] ${e.text}`;
        case "tool_use":
          return `[工具] ${e.tool}: ${e.detail}`;
        case "tool_result":
          return `[结果] ${e.detail}`;
        case "error":
          return `[错误] ${e.message}`;
        default:
          return null;
      }
    })
    .filter(Boolean)
    .join("\n");
}

/** Bounded message DOM with user-controlled, frame-coalesced scroll following. */
function LogPanel({
  events,
  running,
}: {
  events: { event: AgentEvent; key: number }[];
  running: boolean;
}) {
  const { viewportRef, contentRef, follow, onScroll, scrollToBottom } = useAutoScroll(events.length);
  const [copied, setCopied] = useState(false);

  const overflow = events.length - MAX_RENDER;
  const visible = overflow > 0 ? events.slice(overflow) : events;
  void overflow;

  const copyAll = async () => {
    const text = eventsToText(events);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  return (
    <div className="relative min-h-0 flex-1 flex flex-col">
      <div className="flex items-center justify-between px-6 pt-2 text-[10px] text-stone-400">
        <span>
          {overflow > 0
            ? `前 ${overflow} 条已折叠（完整记录在数据库中）`
             : ""}
        </span>
        <button
          onClick={copyAll}
          className="icon-button"
          title={copied ? "已复制" : "复制会话"}
          aria-label={copied ? "已复制" : "复制会话"}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div
        ref={viewportRef}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="会话内容"
         className="log-scroll min-h-0 flex-1 overflow-y-auto"
      >
      <div ref={contentRef} className="log-content">
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
      {visible.map(({ event, key }) => (
        <EventLine
          key={key}
          event={event}
        />
      ))}
      </div>
      </div>
      <AnimatePresence>
      {!follow && (
        <MotionLayer className="scroll-latest" preset="menu">
        <button
           onClick={scrollToBottom}
           title="回到最新"
           aria-label="回到最新"
          className="icon-button"
        >
           <ArrowDown size={16} />
        </button>
        </MotionLayer>
      )}
      </AnimatePresence>
    </div>
  );
}

let eventKey = 0;
const nextKey = () => eventKey++;
