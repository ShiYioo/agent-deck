import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft, SquarePen, ArrowDown, Folder, RotateCcw, X, ListChecks, Ellipsis, FileDiff } from "lucide-react";
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
  cancelCollaboration,
  cancelTask,
  deleteSession,
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
  listCollaborations,
  runLogin,
  setSetting,
  startTask,
  startCollaboration,
} from "./api";
import type { Collaboration } from "./api";
import type { AgentEvent, ApprovalRequest, LiveTask, ProjectRow, TaskRow } from "./types";
import { normalizeAgentEvents } from "./types";
import { applyTaskUpdates, type LogItem, type TaskUpdate } from "./taskState";
import { groupSessions, sessionKey } from "./sessions";
import { Sidebar, projectName, directoryKey } from "./components/Sidebar";
import { HarnessIcon } from "./components/HarnessIcon";
import { Composer } from "./components/Composer";
import { TitleBar } from "./components/TitleBar";
import { RuntimeStatus } from "./components/RuntimeStatus";
import { NavigationRail } from "./components/NavigationRail";
import { Dropdown } from "./components/Dropdown";
import { MotionLayer, useMotionPolicy } from "./motion/MotionProvider";
import { useFrameQueue } from "./hooks/useFrameQueue";
import { useAutoScroll } from "./hooks/useAutoScroll";
import { Disclosure } from "./components/Disclosure";
import { ToolIcon } from "./components/EventLine";
import {
  IconBack,
  IconKey,
  IconDiff,
  IconStop,
} from "./components/icons";

const emptyEvents: LogItem[] = [];
const EventLine = lazy(() => import("./components/EventLine").then((module) => ({ default: module.EventLine })));
const DiffModal = lazy(() => import("./components/DiffModal").then((module) => ({ default: module.DiffModal })));
const SettingsPage = lazy(() => import("./components/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const CreateProjectModal = lazy(() => import("./components/CreateProjectModal").then((module) => ({ default: module.CreateProjectModal })));

export default function App() {
  const { enabled: motionEnabled } = useMotionPolicy();
  // composer 的全局默认值
  const [harness, setHarness] = useState("zcode");
  const [mode, setMode] = useState("yolo");
  const [model, setModel] = useState("");
  const [permission, setPermission] = useState("auto");
  const [cwd, setCwd] = useState("");

  // 运行态与历史
  const [live, setLiveState] = useState<Record<string, LiveTask>>({});
  const liveRef = useRef(live);
  const pendingUpdates = useRef(new Map<string, TaskUpdate[]>());
  const deletedTasks = useRef(new Set<string>());
  const deletingTasks = useRef(new Set<string>());
  const listenersReady = useRef<Promise<unknown>>(Promise.resolve());
  const setLive = useCallback((update: (prev: Record<string, LiveTask>) => Record<string, LiveTask>) => {
    const next = update(liveRef.current);
    for (const id of Object.keys(next)) {
      const pending = pendingUpdates.current.get(id);
      if (pending) {
        next[id] = applyTaskUpdates(next[id], pending);
        pendingUpdates.current.delete(id);
      }
    }
    liveRef.current = next;
    setLiveState(next);
  }, []);
  const [history, setHistory] = useState<TaskRow[]>([]);
  const sidebarCache = useRef<{ history: TaskRow[]; tasks: TaskRow[] }>({ history: [], tasks: [] });
  const sidebarTasks = useMemo(() => {
    const cached = sidebarCache.current;
    let changed = cached.history !== history;
    const tasks = history.map((task, index) => {
      const session = live[task.id]?.sessionId ?? task.session_id;
      const status = live[task.id]?.status ?? task.status;
      const previous = cached.tasks[index];
      if (cached.history === history && previous?.session_id === session && previous.status === status) return previous;
      changed = true;
      return session === task.session_id && status === task.status ? task : { ...task, session_id: session, status };
    });
    if (!changed) return cached.tasks;
    sidebarCache.current = { history, tasks };
    return tasks;
  }, [history, live]);
  const [historyEvents, setHistoryEvents] = useState<Record<string, AgentEvent[]>>({});
  const [loadingEvents, setLoadingEvents] = useState<Set<string>>(new Set());
  const eventRequests = useRef(new Set<string>());
  const [selected, setSelected] = useState<string | null>(null);

  // diff 弹层
  const [diff, setDiff] = useState<{ taskId: string; text: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);

  // 待审批的工具调用（deck 运行时 approved 模式）
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest>>({});
  const approval = selected ? approvals[selected] : undefined;
  const clearApproval = useCallback((taskId: string) => {
    setApprovals((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [busyHandoff, setBusyHandoff] = useState(false);
  const [collaborations, setCollaborations] = useState<Collaboration[]>([]);
  const [mentor, setMentor] = useState("codex");
  const [worker, setWorker] = useState("zcode");
  const [maxRounds, setMaxRounds] = useState(2);
  const [busyCollaboration, setBusyCollaboration] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const [sidebarView, setSidebarView] = useState<"projects" | "recent">("projects");
  const [searchRequest, setSearchRequest] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const settingsLauncher = useRef<HTMLElement | null>(null);
  const projectLauncher = useRef<HTMLElement | null>(null);
  const openSettings = useCallback(() => {
    settingsLauncher.current = document.activeElement as HTMLElement | null;
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    requestAnimationFrame(() => settingsLauncher.current?.focus());
  }, []);
  const openCreateProject = useCallback(() => {
    projectLauncher.current = document.activeElement as HTMLElement | null;
    setSettingsOpen(false);
    setCreateProjectOpen(true);
  }, []);
  const closeCreateProject = useCallback(() => {
    setCreateProjectOpen(false);
    requestAnimationFrame(() => projectLauncher.current?.focus());
  }, []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), []);
  const showProjects = useCallback(() => {
    setSettingsOpen(false);
    setSidebarView("projects");
    setSidebarOpen(true);
  }, []);
  const showRecent = useCallback(() => {
    setSettingsOpen(false);
    setSidebarView("recent");
    setSidebarOpen(true);
  }, []);
  const searchChats = useCallback(() => {
    setSettingsOpen(false);
    setSidebarOpen(true);
    setSearchRequest((value) => value + 1);
  }, []);
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
    listTasks(Number.MAX_SAFE_INTEGER).then((rows) => setHistory(rows.filter((row) => !deletedTasks.current.has(row.id))))
      .catch((e) => setActionError(`加载会话失败：${String(e)}`));
    listProjectsApi().then(setProjects).catch((e) => setActionError(`加载项目失败：${String(e)}`));
    listCollaborations().then(setCollaborations).catch((e) => setActionError(`加载协作记录失败：${String(e)}`));
  }, []);

  // 事件监听里读取最新 live 用的镜像
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
        if (deletedTasks.current.has(id)) continue;
        const task = prev[id];
        if (!task) {
          pendingUpdates.current.set(id, [...(pendingUpdates.current.get(id) ?? []), ...updates]);
          continue;
        }
        next[id] = applyTaskUpdates(task, updates);
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
  const dispatchTask = useCallback(async (
    params: Parameters<typeof startTask>[0],
    previous?: LiveTask,
    queued?: string[],
  ) => {
    await listenersReady.current;
    const taskId = await startTask(params);
    // The backend may create a worktree, so its resolved directory is authoritative.
    const rows = await listTasks(Number.MAX_SAFE_INTEGER).catch((e) => {
      setActionError(`任务已启动，但刷新历史失败：${String(e)}`);
      return [];
    });
    if (rows.length) setHistory(rows.filter((row) => !deletedTasks.current.has(row.id)));
    const taskCwd = rows.find((row) => row.id === taskId)?.cwd ?? params.cwd;
    setLive((prev) => ({
      ...prev,
      [taskId]: {
        harness: params.harness, cwd: taskCwd, prompt: params.prompt,
        mode: params.mode, model: params.model, permission: params.permission,
        projectId: params.projectId, sessionId: params.resumeSessionId ?? undefined,
        events: [
          ...(previous?.events ?? []),
          // 接力轮次注入的简报不透出，与入库事件一致（徽标行见 EventLine）
          // ts = 派发时刻：complete 的工作耗时以此为起点
          {
            event: {
              type: "user_message",
              text: params.prompt,
              hidden: params.relay === true,
              ts: Date.now(),
            },
            key: nextKey(),
          },
        ],
        running: true, status: "running", exitCode: null, queued,
      },
    }));
    setSelected(taskId);
    setHarness(params.harness);
    setModel(params.model ?? "");
    setMode(params.mode ?? "default");
    setPermission(params.permission ?? "auto");
    setCwd(taskCwd);
    refreshHistory();
    return taskId;
  }, [refreshHistory, setLive]);

  const flushQueued = useCallback(
    (task: LiveTask, text: string, sourceId: string) => {
      if (deletedTasks.current.has(sourceId) || deletingTasks.current.has(sourceId)) return;
      dispatchTask({
        harness: task.harness,
        cwd: task.cwd,
        prompt: text,
        mode: task.mode,
        model: task.model ?? null,
        permission: task.permission ?? "auto",
        projectId: task.projectId,
        resumeSessionId: task.sessionId ?? null,
      }, task, task.queued?.slice(1))
        .then(() => setLive((prev) => prev[sourceId] ? ({
          ...prev, [sourceId]: { ...prev[sourceId], queued: [] },
        }) : prev))
        .catch((e) => setActionError(String(e)));
    },
    [dispatchTask, setLive],
  );

  // 工作目录：启动时取默认（设置里的 default_cwd，否则家目录）
  useEffect(() => {
    getDefaultCwd()
      .then((d) => setCwd((cur) => cur || d))
      .catch((e) => setActionError(`加载工作目录失败：${String(e)}`));
  }, []);

  useEffect(() => {
    refreshHistory();
    if (!inTauri) return; // 纯浏览器预览：无 IPC 桥，跳过事件监听
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<{ taskId: string; event: AgentEvent }>("task-event", (e) => {
        const { taskId, event } = e.payload;
        if (deletedTasks.current.has(taskId)) return;
        if (event.type === "session_id") sessionIds.current.set(taskId, event.id);
        enqueueUpdate({ taskId, item: { event, key: nextKey() } });
      }),
      listen<{ taskId: string; code: number | null; status?: TaskRow["status"] }>("task-exit", (e) => {
        const { taskId, code } = e.payload;
        if (deletedTasks.current.has(taskId)) return;
        enqueueUpdate({
          taskId, running: false, exitCode: code,
          status: e.payload.status ?? (code === 0 ? "done" : code === null ? "cancelled" : "failed"),
        });
        flushUpdates();
        const current = liveRef.current[taskId];
        const task = current ? { ...current, sessionId: sessionIds.current.get(taskId) ?? current.sessionId } : undefined;
        sessionIds.current.delete(taskId);
        clearApproval(taskId);
        if (task) {
          notify(
            code === 0 ? "AgentDeck · 任务完成" : "AgentDeck · 任务结束",
            `${task.harness}：${task.prompt.slice(0, 40)}`,
          );
          // 队列续发：成功且有会话 → 取队首消息作为续接派发（抄 VK 队列消息）
          if (code === 0 && task.queued && task.queued.length > 0 && task.sessionId) {
            const [next] = task.queued;
            flushQueued(task, next, taskId);
          }
        }
        setTimeout(refreshHistory, 300);
      }),
      // deck（pi 运行时）事件：归一化到统一渲染管道；退出由 task-exit 之外的
      // deck_run_end 体现，这里同时以 task-exit 兜底
      listen<Record<string, unknown>>("pi-event", (e) => {
        const payload = e.payload as { taskId?: string } & Record<string, unknown>;
        const taskId = payload.taskId;
        if (!taskId || deletedTasks.current.has(taskId)) return;
        // 审批请求：单独呈现在操作区
        if (payload.type === "deck_approval_request") {
          setApprovals((prev) => ({ ...prev, [taskId]: {
            taskId,
            id: String(payload.id ?? ""),
            tool: String(payload.tool ?? "tool"),
            args: (payload.args as Record<string, unknown>) ?? {},
          } }));
          notify(
            "AgentDeck · 需要审批",
            `Agent 请求执行工具：${payload.tool ?? "tool"}`,
          );
          return;
        }
        if (payload.type === "deck_approval_decided") {
          clearApproval(taskId);
        }
        if (payload.type === "deck_todo_updated" && Array.isArray(payload.todos)) {
          const todos = payload.todos as { content: string; status: string }[];
          enqueueUpdate({ taskId, todos });
        }
        const mapped = normalizeAgentEvents(payload as never);
        for (const event of mapped) {
          if (event.type === "session_id") sessionIds.current.set(taskId, event.id);
          enqueueUpdate({ taskId, item: { event, key: nextKey() } });
        }
        const running = payload.type === "deck_run_end" ? false : payload.type === "deck_run_start" ? true : undefined;
        if (running !== undefined) enqueueUpdate({
          taskId, running,
          status: running ? "running" : payload.status === "cancelled" ? "cancelled" : payload.ok === false ? "failed" : "done",
        });
        if (payload.type === "deck_run_end") {
          flushUpdates();
          clearApproval(taskId);
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
      listen<Collaboration>("collaboration-update", (event) => {
        setCollaborations((previous) => [
          event.payload,
          ...previous.filter((item) => item.id !== event.payload.id),
        ]);
        refreshHistory();
      }),
    ];
    listenersReady.current = Promise.all(unlisteners);
    listenersReady.current.catch((e) => setActionError(`监听运行事件失败：${String(e)}`));
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()).catch(() => {}));
    };
  }, [refreshHistory, enqueueUpdate, flushUpdates, clearApproval, flushQueued, notify]);

  const selectedConversation = useMemo(() => selected
    ? groupSessions(sidebarTasks).find((session) => session.turns.some((turn) => turn.id === selected))
    : undefined, [sidebarTasks, selected]);
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
      const resumeSource: LiveTask | undefined = runningTask ?? (row ? {
        harness: row.harness, cwd: row.cwd, prompt: row.prompt,
        mode: row.mode, model: row.model,
        permission: row.harness === "deck" ? row.mode : permission,
        projectId: row.project_id,
        sessionId: row.session_id ?? undefined, running: row.status === "running",
        exitCode: row.exit_code,
        events: (historyEvents[selected!] ?? []).map((event) => ({ event, key: nextKey() })),
      } : undefined);
      const canResume = !routeFresh && !!resumeSource?.sessionId && !resumeSource.running
        && resumeSource.harness === useHarness
        && directoryKey(resumeSource.cwd) === directoryKey(cwd || ".");
      // 跨 harness 续聊：会话句柄互不相认，自动走接力（压缩上一会话 → 简报注入新家）
      const crossHarness = !routeFresh && !!resumeSource?.sessionId && !resumeSource.running
        && resumeSource.harness !== useHarness
        && directoryKey(resumeSource.cwd) === directoryKey(cwd || ".");
      // 记住这次的工作目录，下次启动作为默认
      const useCwd = canResume ? resumeSource!.cwd : cwd || ".";
      if (!routeFresh && cwd.trim()) {
        setSetting("default_cwd", cwd.trim()).catch(() => {});
      }
      try {
        const previous = canResume ? resumeSource : undefined;
        if (previous && !runningTask && selected) {
          previous.events = (await getTaskEvents(selected)).map((event) => ({ event, key: nextKey() }));
        }
        // 跨 harness：先压缩上一会话成接力简报，失败则中止发送（错误可见）
        let promptToSend = text;
        if (crossHarness) {
          setActionInfo(`正在压缩上一会话，接力到 ${useHarness}…`);
          try {
            promptToSend = await buildSmartHandoffPrompt(selected!);
          } finally {
            setActionInfo(null);
          }
        }
        await dispatchTask({
          harness: canResume ? resumeSource!.harness : useHarness,
          cwd: useCwd,
          prompt: promptToSend,
          // 接力/续接轮次归入当前会话（跨 harness 同组）；简报不作为用户消息透出
          conversationId: canResume || crossHarness ? selectedConversation?.turns[0].id ?? null : null,
          relay: crossHarness,
          mode: canResume
            ? resumeSource!.mode
            : useHarness === "deck"
              ? null
              : useHarness === "zcode"
                ? mode
                : mode === "default"
                  ? null
                  : mode,
          model: routeModel,
          permission,
          resumeSessionId: canResume ? resumeSource!.sessionId! : null,
          projectId:
            selectedProjectId ??
            projects.find(
              (p) => p.dir.split("\\").join("/") === (useCwd || "").split("\\").join("/"),
            )?.id ??
            null,
        }, previous);
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
      dispatchTask,
      historyEvents,
      selectedConversation,
    ],
  );

  // 查看任务：优先实时缓冲，否则回放数据库事件
  const historyEventsRef = useRef(historyEvents);
  historyEventsRef.current = historyEvents;
  const viewTask = useCallback(async (taskId: string) => {
    setSelected(taskId);
    if (liveRef.current[taskId] || historyEventsRef.current[taskId] || eventRequests.current.has(taskId)) return;
    eventRequests.current.add(taskId);
    setLoadingEvents((previous) => new Set(previous).add(taskId));
    try {
      const events = await getTaskEvents(taskId);
      if (deletedTasks.current.has(taskId)) return;
      setHistoryEvents((prev) => ({ ...prev, [taskId]: events }));
    } catch (e) {
      setActionError(`加载对话失败：${String(e)}`);
    } finally {
      eventRequests.current.delete(taskId);
      setLoadingEvents((previous) => {
        const next = new Set(previous);
        next.delete(taskId);
        return next;
      });
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
        if (row.harness === "deck") setPermission(row.mode === "approved" ? "approved" : "auto");
      }
      setActionError(null);
      if (window.innerWidth <= 760) setSidebarOpen(false);
      void viewTask(id);
    },
    [viewTask, history, projects],
  );

  const selectedRow = selected ? history.find((t) => t.id === selected) : undefined;
  const selectedLive = selected ? live[selected] : undefined;
  const conversationKey = selectedConversation?.turns[0].id ?? selected ?? "new";
  const conversationTitle = selectedConversation?.turns[0].prompt ?? selectedRow?.prompt ?? selectedLive?.prompt ?? "聊天";
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
   const selectedCanResume = !!selectedSession && !selectedRunning;
  const selectedHarness = selectedRow?.harness ?? selectedLive?.harness ?? harness;
  const selectedStatus = selectedLive?.status ?? selectedRow?.status;
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

  const handleDeleteSession = useCallback(
    async (id: string) => {
      const row = sidebarTasks.find((task) => task.id === id);
      if (!row || deletedTasks.current.has(id) || deletingTasks.current.has(id)) return;
      const ids = sidebarTasks.filter((task) => sessionKey(task) === sessionKey(row)).map((task) => task.id);
      for (const taskId of ids) deletingTasks.current.add(taskId);
      setActionError(null);
      try {
        const removed = await deleteSession(id);
        for (const taskId of removed) {
          deletedTasks.current.add(taskId);
          if (!ids.includes(taskId)) ids.push(taskId);
        }
      } catch (e) {
        for (const taskId of ids) deletingTasks.current.delete(taskId);
        setActionError(String(e));
        return;
      }
      const removed = new Set(ids);
      for (const taskId of ids) {
        deletedTasks.current.add(taskId);
        deletingTasks.current.delete(taskId);
        clearApproval(taskId);
        sessionIds.current.delete(taskId);
        pendingUpdates.current.delete(taskId);
      }
      setLive((prev) => {
        const next = { ...prev };
        for (const taskId of ids) delete next[taskId];
        return next;
      });
      setHistory((prev) => prev.filter((t) => !removed.has(t.id)));
      setHistoryEvents((prev) => {
        const next = { ...prev };
        for (const taskId of ids) delete next[taskId];
        return next;
      });
      setDiff((cur) => cur && removed.has(cur.taskId) ? null : cur);
      setSelected((cur) => (cur && removed.has(cur) ? null : cur));
    },
    [clearApproval, setLive, sidebarTasks],
  );


  // Esc 终止运行中的任务（Codex 桌面端习惯；输入框/弹层聚焦时除外）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (diff || settingsOpen || approval) return; // 弹层/审批有自己的 Esc 语义
      if (!selectedRunning || !selected) return;
      e.preventDefault();
      cancelTask(selected).catch((e) => setActionError(String(e)));
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
      await dispatchTask({
        harness: target,
        cwd: selectedRow.cwd,
        prompt: briefing,
        mode: target === "zcode" ? "yolo" : target === "codex" ? "full" : null,
        model: null,
        permission: "auto",
        resumeSessionId: null,
        projectId: selectedRow.project_id,
      });
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusyHandoff(false);
    }
  };

  const startGuidedCollaboration = async () => {
    if (!selectedRow || busyCollaboration) return;
    setBusyCollaboration(true);
    setActionError(null);
    try {
      await startCollaboration({
        sourceTaskId: selectedRow.id,
        mentor,
        worker,
        maxRounds,
      });
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusyCollaboration(false);
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
      <TitleBar onToggleSidebar={toggleSidebar} />
      <div className="desktop-body">
      <NavigationRail view={sidebarView} settingsOpen={settingsOpen}
        onProjects={showProjects} onRecent={showRecent} onSearch={searchChats}
        onCreateProject={openCreateProject} onSettings={openSettings} />
      <div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      <AnimatePresence initial={false}>
        {sidebarOpen && <MotionLayer key="sidebar-scrim" className="sidebar-scrim-holder">
          <button className="sidebar-scrim" aria-label="关闭侧栏" onClick={closeSidebar} />
        </MotionLayer>}
        {sidebarOpen && <MotionLayer key="sidebar" preset="sidebar" className="sidebar-host"
          initial={motionEnabled ? { width: 0, opacity: 0, x: -12 } : false}
          animate={{ width: "auto", opacity: 1, x: 0 }}
          exit={{ width: 0, opacity: motionEnabled ? 0 : 1, x: motionEnabled ? -12 : 0 }}>
          <Sidebar tasks={sidebarTasks} projects={projects} selectedId={selected} onSelect={handleSelect}
            onDelete={handleDeleteSession}
            onNew={newChat} onSettings={openSettings} onCreateProject={openCreateProject}
            onCollapse={closeSidebar} view={sidebarView} searchRequest={searchRequest} />
        </MotionLayer>}
      </AnimatePresence>
      <Suspense fallback={<div className="overlay-loading" role="status">正在加载…</div>}>
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
      </Suspense>

      <main className={`workspace-main ${selected === null ? "is-new" : ""}`}>
        <header className="workspace-header">
          {!sidebarOpen && <button className="icon-button" title="展开侧栏" aria-label="展开侧栏" onClick={() => setSidebarOpen(true)}><PanelLeft size={18} /></button>}
          <Folder size={17} className="workspace-folder" />
          <span className="workspace-title">{selected ? conversationTitle : "新聊天"}</span>
          <div className="workspace-header-actions">
            {selected && <Dropdown value="" title="聊天操作" icon={<Ellipsis size={18} />} iconOnly
              options={[
                { value: "copy", label: "复制会话" },
                { value: "new", label: "新聊天" },
                { value: "delete", label: "删除会话" },
              ]}
              onChange={(action) => {
                if (action === "new") newChat();
                else if (action === "delete" && selected) void handleDeleteSession(selected);
                else void navigator.clipboard.writeText(eventsToText(selectedEvents)).catch((error) => setActionError(`复制失败：${String(error)}`));
              }} />}
            {selected && <button className={`icon-button ${detailsOpen ? "is-active" : ""}`}
              title="执行详情" aria-label="执行详情" aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((value) => !value)}><ListChecks size={18} /></button>}
            {selected && canShowDiff && <button className="icon-button" title="查看 Diff" aria-label="查看 Diff" onClick={showDiff}><FileDiff size={17} /></button>}
            <button className="icon-button" title="新聊天" aria-label="新聊天" onClick={() => newChat()}><SquarePen size={17} /></button>
          </div>
        </header>
        {selected === null ? (
          // New chats share the same composer as active conversations.
          <MotionLayer preset="scene"
            initial={false}
            key="empty"
            className="new-chat-heading"
          >
            <h1>开始新的任务</h1>
            {cwd && <span className="new-chat-project">{projects.find((p) => directoryKey(p.dir) === directoryKey(cwd))?.name ?? projectName(cwd)}</span>}
          </MotionLayer>
        ) : (
          // ── 任务详情视图 ──
          <MotionLayer preset="scene"
            key={`session-${conversationKey}`}
            className="task-view flex min-h-0 flex-1 flex-col"
          >
            <div className="task-controls" hidden={!detailsOpen && selectedStatus !== "failed" && !collaborations.some((item) => item.source_task_id === selected && item.status === "running")}>
            <div className="task-metadata">
              <button
                onClick={() => setSelected(null)}
                className="rounded-md p-1.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
                title="返回新任务"
              >
                <IconBack size={15} />
              </button>
              <HarnessIcon harness={selectedHarness} size={16} rounded />
              <span
                className="text-xs text-stone-600"
              >
                {selectedHarness}
              </span>
              <span className="truncate text-stone-500">
                {selectedRow?.cwd ?? selectedLive?.cwd}
              </span>
              {selectedLive?.todos && selectedLive.todos.length > 0 && (
                <span className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] text-stone-600">
                  <ListChecks size={13} className="inline-block mr-1" />{selectedLive.todos.filter((t) => t.status === "completed").length}
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
                   onClick={stopSelected}
                  className="flex items-center gap-1.5 rounded-full border border-red-200 px-3 py-1 text-xs text-red-600 transition-colors hover:bg-red-50"
                >
                  <IconStop size={13} />
                  终止
                </button>
              )}
              <span className="text-xs text-stone-400">
                {selectedRunning
                  ? "运行中…"
                   : selectedStatus === "done"
                     ? "已完成"
                     : selectedStatus === "cancelled"
                       ? "已取消"
                       : selectedStatus === "failed"
                         ? "运行失败"
                         : "已结束"}
              </span>
            </div>

            <div className="task-actions">
                 {!selectedRunning && selectedStatus === "failed" && selectedRow && (
                  <button
                    onClick={() => {
                      const r = selectedRow;
                      setActionError(null);
                      dispatchTask({
                        harness: r.harness,
                        cwd: r.cwd,
                        prompt: r.prompt,
                        mode: r.mode,
                        model: r.model,
                        permission: selectedLive?.permission ?? (r.harness === "deck" ? r.mode : permission),
                        resumeSessionId: r.session_id,
                        projectId: r.project_id,
                      })
                        .catch((e) => setActionError(String(e)));
                    }}
                     className="task-action"
                   >
                     <RotateCcw size={13} />重试
                  </button>
                )}
                {hasAuthError && !selectedRunning && (
                  <button
                    onClick={() =>
                       (selectedHarness === "deck" ? Promise.resolve(setSettingsOpen(true)) : runLogin(selectedHarness))
                         .catch((e) => setActionError(String(e)))
                    }
                    className="flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 font-medium text-amber-700 transition-colors hover:bg-amber-100"
                  >
                    <IconKey size={13} />
                     {selectedHarness === "deck" ? "检查模型配置" : "唤起登录"}
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
                       className="task-action task-action-primary"
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
                         style={{ borderColor: "var(--border)", color: "var(--text-2)" }}
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

            {!selectedRunning && selectedRow && (
              <Disclosure className="handoff-section mx-6 mt-2" title="互相指导">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <label>指导方
                    <select aria-label="指导方" value={mentor} onChange={(e) => setMentor(e.target.value)}>
                      {["zcode", "codex", "opencode"].filter((item) => item !== worker)
                        .map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                  <label>执行方
                    <select aria-label="执行方" value={worker} onChange={(e) => setWorker(e.target.value)}>
                      {["zcode", "codex", "opencode"].filter((item) => item !== mentor)
                        .map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                  <label>最多执行轮数
                    <select aria-label="最多执行轮数" value={maxRounds} onChange={(e) => setMaxRounds(Number(e.target.value))}>
                      {[1, 2, 3].map((round) => <option key={round} value={round}>{round}</option>)}
                    </select>
                  </label>
                  <button onClick={startGuidedCollaboration} disabled={busyCollaboration}
                    className="rounded-full border px-3 py-1 disabled:opacity-50">
                    {busyCollaboration ? "启动中…" : "开始指导协作"}
                  </button>
                </div>
              </Disclosure>
            )}
            {collaborations.filter((item) => item.source_task_id === selected).map((item) => (
              <div key={item.id} className="mx-6 mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span>{item.mentor} 指导 {item.worker} · {item.phase} · 第 {item.round}/{item.max_rounds} 轮 · {item.status}</span>
                {item.current_task_id && <button onClick={() => viewTask(item.current_task_id!)}>查看当前阶段</button>}
                {item.error && <span className="text-red-700">{item.error}</span>}
                {item.status === "running" && <button onClick={() => cancelCollaboration(item.id).catch((e) => setActionError(String(e)))}>停止协作</button>}
              </div>
            ))}
            </div>

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
                      invokePiCommand(approval.taskId, "approve", approval.id)
                        .then(() => clearApproval(approval.taskId))
                        .catch((e) => setActionError(String(e)))
                    }
                     className="task-action task-action-primary"
                  >
                    允许
                  </button>
                  <button
                    onClick={() =>
                      invokePiCommand(approval.taskId, "reject", approval.id)
                        .then(() => clearApproval(approval.taskId))
                        .catch((e) => setActionError(String(e)))
                    }
                    className="rounded-full border border-red-300 px-3.5 py-1 font-medium text-red-600 transition-colors hover:bg-red-50"
                  >
                    拒绝
                  </button>
                  <span className="text-stone-400">执行将阻塞等待你的决定</span>
                </div>
              </div>
            )}

            <LogPanel key={conversationKey} events={selectedEvents} running={selectedRunning} loading={!!selected && loadingEvents.has(selected)} />
          </MotionLayer>
        )}

        {/* 底部输入卡：始终可见。运行中发送 = 入队（结束后自动续发） */}
        <m.div className="composer-dock" layout={motionEnabled ? "position" : false} layoutDependency={selected === null}>
          {actionError && <div className="action-error" role="alert">{actionError}</div>}
          {actionInfo && <div className="action-info">{actionInfo}</div>}
          <RuntimeStatus harness={harness} refreshKey={settingsOpen} onSettings={openSettings} />
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
                     className="queue-remove"
                     title="移除"
                     aria-label={`移除排队消息 ${i + 1}`}
                   >
                     <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Composer
            draftKey={conversationKey}
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
            catalogVersion={settingsOpen}
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

        <Suspense fallback={<div className="overlay-loading" role="status">正在加载…</div>}>
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
        </Suspense>
      </main>
      </div>
      </div>
    </div>
  );
}

/** 日志 DOM 渲染上限：更早的条目留在库里（回放/导出不受限），界面只挂尾部 */
const MAX_RENDER = 500;

/** 耗时派生：思考块运行结束回填思考秒数；complete 回填本轮工作秒数 */
function decorateTiming(events: LogItem[]): LogItem[] {
  const out = events.map(({ event, key }) => ({
    key,
    event: { ...event } as AgentEvent & { ts?: number; durationMs?: number },
  }));
  // 思考运行：连续 thinking（流式快照同属一段），结束于首个非 thinking 事件
  let thinkStart: number | null = null;
  let thinkLast = -1;
  let turnStart: number | null = null;
  const flushThinking = () => {
    if (thinkStart !== null && thinkLast >= 0) {
      const last = out[thinkLast].event as AgentEvent & { ts?: number; durationMs?: number };
      if (last.ts && last.ts > thinkStart) last.durationMs = last.ts - thinkStart;
    }
    thinkStart = null;
    thinkLast = -1;
  };
  for (const item of out) {
    const ev = item.event;
    if (ev.type === "thinking") {
      if (thinkStart === null && ev.ts) thinkStart = ev.ts;
      if (ev.ts) thinkLast = out.indexOf(item);
      continue;
    }
    flushThinking();
    if (ev.type === "user_message" && !ev.hidden) {
      turnStart = ev.ts ?? null;
    } else if (ev.type === "complete") {
      // 一轮的工作耗时：本轮 user_message → complete 的真实间隔
      if (turnStart !== null && ev.ts && ev.ts > turnStart) {
        ev.durationMs = ev.ts - turnStart;
      }
      turnStart = null;
    }
  }
  // 思考延伸到末尾（仍在流式）不回填：结束后才提供
  return out.map(({ event, key }) => ({ event: event as AgentEvent, key }));
}

/** 工具段折叠：tool_use/tool_result/thinking 的工作序列归为一段（≥2 次调用收成一行摘要，可展开逐条看）。
 * 紧邻文本输出的最后一段思考保留在外——思考耗时徽标保持可见。 */
type LogEntry = LogItem;
type DisplayGroup =
  | { kind: "single"; item: LogEntry }
  | { kind: "segment"; items: LogEntry[]; uses: { tool: string; n: number }[]; failed: boolean };

const TOOL_RUN_MIN = 2;

function isWorkEvent(e: AgentEvent): boolean {
  return e.type === "tool_use" || e.type === "tool_result" || e.type === "thinking";
}

function groupToolRuns(events: LogEntry[]): DisplayGroup[] {
  const out: DisplayGroup[] = [];
  let seg: LogEntry[] = [];
  const flush = (keepTrailingThinking: boolean) => {
    if (seg.length === 0) return;
    let tail: LogEntry[] = [];
    if (keepTrailingThinking) {
      while (seg.length > 0 && seg[seg.length - 1].event.type === "thinking") {
        tail.unshift(seg.pop() as LogEntry);
      }
    }
    const uses = new Map<string, number>();
    let failed = false;
    let calls = 0;
    for (const { event } of seg) {
      if (event.type === "tool_use") {
        calls += 1;
        const tool = event.tool.toLowerCase();
        uses.set(tool, (uses.get(tool) ?? 0) + 1);
      } else if (event.type === "tool_result" && !event.ok) {
        failed = true;
      }
    }
    if (calls >= TOOL_RUN_MIN) {
      out.push({ kind: "segment", items: seg, uses: [...uses.entries()].map(([tool, n]) => ({ tool, n })), failed });
    } else {
      for (const item of seg) out.push({ kind: "single", item });
    }
    for (const item of tail) out.push({ kind: "single", item });
    seg = [];
  };
  for (const item of events) {
    const { event } = item;
    if (isWorkEvent(event)) {
      seg.push(item);
    } else {
      flush(event.type === "assistant_message");
      out.push({ kind: "single", item });
    }
  }
  flush(false);
  return out;
}

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
const LogPanel = memo(function LogPanel({
  events,
  running,
  loading,
}: {
  events: { event: AgentEvent; key: number }[];
  running: boolean;
  loading: boolean;
}) {
  const { viewportRef, contentRef, follow, onScroll, scrollToBottom } = useAutoScroll(events.length);

  const overflow = events.length - MAX_RENDER;
  const decorated = useMemo(() => decorateTiming(events), [events]);
  const visible = overflow > 0 ? decorated.slice(overflow) : decorated;
  void overflow;

  return (
    <div className="relative min-h-0 flex-1 flex flex-col">
      {overflow > 0 && <div className="log-overflow-note">前 {overflow} 条已折叠（完整记录在数据库中）</div>}
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
          {loading ? <span role="status">正在加载对话…</span> : running ? (
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
      <Suspense fallback={<div className="content-loading" role="status">正在加载对话…</div>}>
      {groupToolRuns(visible).map((group) => {
        if (group.kind === "single") {
          const { event, key } = group.item;
          return <EventLine key={key} event={event} />;
        }
        const [first] = group.items;
        const summary = group.uses.map(({ tool, n }) => `${tool}×${n}`).join(" · ");
        return (
          <Disclosure
            key={first.key}
            className="activity-event"
            title={
              <>
                <ToolIcon tool="tool" />
                <span>
                  工具操作 ×{group.uses.reduce((n, { n: k }) => n + k, 0)}（{summary}）
                </span>
                {group.failed && <span className="text-red-600">含失败</span>}
              </>
            }
          >
            {group.items.map(({ event, key }) => (
              <EventLine key={key} event={event} />
            ))}
          </Disclosure>
        );
      })}
      </Suspense>
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
});

let eventKey = 0;
const nextKey = () => eventKey++;
