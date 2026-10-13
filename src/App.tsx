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
  getTurnArtifacts,
  undoTaskFile,
  openArtifact,
  invokePiCommand,
  inTauri,
  listTasks,
  listCollaborations,
  listGraphRuns,
  runLogin,
  setSetting,
  startTask,
  startCollaboration,
  getExecutionDefaults,
  setExecutionDefaults,
  inheritedExecution,
} from "./api";
import type { Collaboration, ExecutionConfig, PhaseExecution } from "./api";
import { ExecutionPicker, effortLabel } from "./components/ExecutionPicker";
import { DelegationExecution } from "./components/DelegationExecution";
import type { AgentEvent, ApprovalRequest, LiveTask, ProjectRow, TaskRow } from "./types";
import { normalizeAgentEvents } from "./types";
import { applyTaskUpdates, type LogItem, type TaskUpdate } from "./taskState";
import { groupSessions, normalizeMode, sessionKey, transferMode } from "./sessions";
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
import { ToolIcon } from "./components/ToolIcon";
import { TurnArtifactsPanel } from "./components/TurnArtifacts";
import {
  IconBack,
  IconKey,
  IconDiff,
  IconStop,
  IconInfo,
} from "./components/icons";

const emptyEvents: LogItem[] = [];
const ConversationContext = lazy(() => import("./components/ConversationContext"));
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
  const [effort, setEffort] = useState("");
  const [permission, setPermission] = useState("auto");
  const [cwd, setCwd] = useState("");

  // 运行态与历史
  const [live, setLiveState] = useState<Record<string, LiveTask>>({});
  const liveRef = useRef(live);
  const pendingUpdates = useRef(new Map<string, TaskUpdate[]>());
  const deletedTasks = useRef(new Set<string>());
  const deletingTasks = useRef(new Set<string>());
  const reconfiguringTasks = useRef(new Set<string>());
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
  const executionScope = history.find((row) => row.id === selected)?.conversation_id ?? selected;
  const [executionPreferences, setExecutionPreferences] = useState<Record<string, ExecutionConfig>>({});
  const preferencesRef = useRef(executionPreferences);
  preferencesRef.current = executionPreferences;
  const preferenceKey = (h: string) => `${executionScope ?? "default"}:${h}`;
  const executionFor = (h: string): ExecutionConfig => executionPreferences[preferenceKey(h)] ?? inheritedExecution();
  const rememberExecution = (h: string, config: ExecutionConfig) => {
    const key = preferenceKey(h);
    preferencesRef.current = { ...preferencesRef.current, [key]: config };
    setExecutionPreferences(preferencesRef.current);
    if (h === harness) { setModel(config.model ?? ""); setEffort(config.effort ?? ""); }
    void setExecutionDefaults(executionScope, h, config).catch((error) => setActionError(String(error)));
  };
  const executionSelectionRef = useRef({ scope: executionScope, harness });
  executionSelectionRef.current = { scope: executionScope, harness };
  useEffect(() => {
    let alive = true;
    for (const h of ["codex", "opencode", "zcode", "deck"]) {
      const key = `${executionScope ?? "default"}:${h}`;
      if (preferencesRef.current[key]) continue;
      void getExecutionDefaults(executionScope, h).then((config) => {
        if (!alive || preferencesRef.current[key]) return;
        preferencesRef.current = { ...preferencesRef.current, [key]: config };
        setExecutionPreferences(preferencesRef.current);
        if (executionSelectionRef.current.scope === executionScope && executionSelectionRef.current.harness === h) {
          // 该 harness 没存过模型时必须清空，否则会留下上一个 harness 的模型
          setModel(config.model ?? "");
          setEffort(config.effort ?? "");
        }
      }).catch((error) => { if (alive) setActionError(String(error)); });
    }
    return () => { alive = false; };
  }, [executionScope]);
  // harness 变化（含启动时恢复上次选择）后，模型必须重新取该 harness 自己的偏好。
  // 恢复路径只调 setHarness，不经过 chooseHarness，模型会残留上一个 harness 的值，
  // 在模型下拉里表现为「不可配置」。
  const appliedHarness = useRef<string | null>(null);
  useEffect(() => {
    if (appliedHarness.current === harness) return;
    appliedHarness.current = harness;
    const config = preferencesRef.current[`${executionScope ?? "default"}:${harness}`];
    setModel(config?.model ?? "");
    setEffort(config?.effort ?? "");
  }, [harness, executionScope]);

  // diff 弹层
  const [diff, setDiff] = useState<{ taskId: string; text: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 换档提示：接力/切模型时的一次性说明（发送即清）
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  // composer 附件（绝对路径）；发送后清空
  const [attachments, setAttachments] = useState<string[]>([]);

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
  const [busyReconfigure, setBusyReconfigure] = useState(false);
  const [collaborations, setCollaborations] = useState<Collaboration[]>([]);
  const [mentor, setMentor] = useState("codex");
  const [worker, setWorker] = useState("zcode");
  const [maxRounds, setMaxRounds] = useState(2);
  const [phaseTimeoutMinutes, setPhaseTimeoutMinutes] = useState(15);
  const [busyCollaboration, setBusyCollaboration] = useState(false);
  const [phaseExecution, setPhaseExecution] = useState<PhaseExecution>({
    planning: inheritedExecution(), executing: inheritedExecution(), reviewing: inheritedExecution(),
  });
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
    void setSetting("composer_harness", next).catch(() => {});
    const config = preferencesRef.current[`${executionScope ?? "default"}:${next}`];
    setModel(config?.model ?? "");
    setEffort(config?.effort ?? "");
    // 回写映射后的档位：只在用户手动改档时才写 composer_mode 的话，
    // 存下来的 (harness, mode) 会是跨 harness 的非法组合，重启后下拉显示裸值。
    const mapped = normalizeMode(next, transferMode(harness, mode, next, permission));
    setMode(mapped);
    void setSetting("composer_mode", mapped).catch(() => {});
  }, [harness, mode, permission, executionScope]);
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
    queuedConfigs?: ExecutionConfig[],
  ) => {
    await listenersReady.current;
    const taskId = await startTask(params);
    // The backend may create a worktree, so its resolved directory is authoritative.
    const rows = await listTasks(Number.MAX_SAFE_INTEGER).catch((e) => {
      setActionError(`任务已启动，但刷新历史失败：${String(e)}`);
      return [];
    });
    if (rows.length) setHistory(rows.filter((row) => !deletedTasks.current.has(row.id)));
    const startedRow = rows.find((row) => row.id === taskId);
    const taskCwd = startedRow?.cwd ?? params.cwd;
    setLive((prev) => ({
      ...prev,
      [taskId]: {
        harness: params.harness, cwd: taskCwd, prompt: params.prompt,
        mode: params.mode, model: params.model, permission: params.permission,
        effort: startedRow?.execution_config?.resolved.effort ?? params.effort,
        executionConfig: startedRow?.execution_config,
        projectId: params.projectId, sessionId: startedRow?.session_id ?? params.resumeSessionId ?? undefined,
        conversationId: startedRow?.conversation_id ?? params.conversationId ?? null,
        events: [
          ...(previous?.events ?? []),
          // 自动接力请求不伪装成用户消息；用户本轮输入始终保留。
          // ts = 派发时刻：complete 的工作耗时以此为起点
          {
            event: {
              type: "user_message",
              text: params.prompt + (params.attachments?.length
                ? `

📎 附件：${params.attachments.map((a) => a.split(/[\/]/).pop()).join("、")}`
                : ""),
              hidden: params.relay === true,
              ts: Date.now(),
            },
            key: nextKey(),
          },
        ],
        running: true, status: "running", exitCode: null, queued, queuedConfigs,
      },
    }));
    setSelected(taskId);
    setHarness(params.harness);
    setModel(params.model ?? "");
    setEffort(params.effort ?? "");
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
        model: task.queuedConfigs?.[0] ? task.queuedConfigs[0].model : task.model ?? null,
        effort: task.queuedConfigs?.[0] ? task.queuedConfigs[0].effort : task.effort ?? null,
        permission: task.permission ?? "auto",
        projectId: task.projectId,
        conversationId: task.conversationId,
        resumeSessionId: task.sessionId ?? null,
      }, task, task.queued?.slice(1), task.queuedConfigs?.slice(1))
        .then(() => setLive((prev) => prev[sourceId] ? ({
          ...prev, [sourceId]: { ...prev[sourceId], queued: [], queuedConfigs: [] },
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
  // composer 会话偏好持久化：harness/mode/permission 重启后保持用户上次的选择
  const COMPOSER_PREF_KEYS = ["harness", "mode", "permission"] as const;
  useEffect(() => {
    (async () => {
      const saved: Record<string, string | null> = {};
      for (const k of COMPOSER_PREF_KEYS) saved[k] = await getSetting(`composer_${k}`).catch(() => null);
      if (saved.harness) {
        setHarness(saved.harness);
        // mode 是跨 harness 共用的状态，而各 harness 取值不通用。这里必须按恢复出来的
        // harness 收敛：没有存过（冷启动）时会停在初始值 "yolo"，那是 zcode 专属值，
        // 在 opencode/codex 下会让下拉显示裸字符串。
        setMode(normalizeMode(saved.harness, saved.mode));
        if (saved.permission) setPermission(saved.permission);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          if (code === 0 && !reconfiguringTasks.current.has(taskId) && task.queued && task.queued.length > 0 && task.sessionId) {
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
      listen<string>("context-cleanup-error", (event) => setActionError(event.payload)),
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
  // @ routes within the selected conversation; native bindings remain harness-specific.
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
        // @zcode:provider/model 切换 ZCode 默认模型
        atModel = at[2];
        text = text.slice(at[0].length);
      }
      if (!text.trim()) {
        setActionError("请输入任务描述");
        return false;
      }

      const row = selected ? history.find((t) => t.id === selected) : undefined;
      const runningTask = selected ? liveRef.current[selected] : undefined;
      const useHarness = atTarget ?? harness;
      const targetConfig = preferencesRef.current[`${executionScope ?? "default"}:${useHarness}`] ?? inheritedExecution();
      const routeModel = atTarget ? atModel ?? targetConfig.model : model.trim() || targetConfig.model;
      const routeEffort = atModel && atModel !== targetConfig.model ? "" : atTarget ? targetConfig.effort : effort || targetConfig.effort;

      // 同执行者运行中排队；其他执行者必须等待当前会话结束。
      if (
        selected &&
        runningTask?.running &&
        useHarness === runningTask.harness
      ) {
        setLive((prev) => ({
          ...prev,
          [selected]: {
            ...prev[selected],
            queued: [...(prev[selected].queued ?? []), text],
            queuedConfigs: [...(prev[selected].queuedConfigs ?? []), {
              // 排队轮保持会话当前的执行配置：routeModel 可能被异步偏好加载清空，
              // 回退到运行中任务的 model（用户点 @deck:fixture:model 后的派发值）
              model: routeModel || runningTask.model || "",
              effort: routeEffort || runningTask.effort || "",
            }],
          },
        }));
        return true;
      }
      if (runningTask?.running ?? row?.status === "running") {
        setActionError("当前会话已有执行者运行中，请等待结束或停止后再接力");
        return false;
      }

      const resumeSource: LiveTask | undefined = runningTask ?? (row ? {
        harness: row.harness, cwd: row.cwd, prompt: row.prompt,
        mode: row.mode, model: row.model,
        permission: row.harness === "deck" ? row.mode : permission,
        projectId: row.project_id,
        sessionId: row.session_id ?? undefined, running: false,
        exitCode: row.exit_code,
        events: (historyEvents[selected!] ?? []).map((event) => ({ event, key: nextKey() })),
      } : undefined);
      const continuing = !!resumeSource
        && directoryKey(resumeSource.cwd) === directoryKey(cwd || ".");
      const binding = continuing ? [...(selectedConversation?.turns ?? [])].reverse().find((turn) =>
        turn.harness === useHarness && turn.session_id && turn.status !== "running") : undefined;
      const resumeId = binding?.session_id
        ?? (continuing && resumeSource?.harness === useHarness ? resumeSource.sessionId : null);
      // 记住这次的工作目录，下次启动作为默认
      const useCwd = continuing ? resumeSource!.cwd : cwd || ".";
      if (cwd.trim()) {
        setSetting("default_cwd", cwd.trim()).catch(() => {});
      }
      // 换档提示（对齐会话最后一轮的 harness/model）：
      // 换家 → 接力到 X；换家且指定模型 → 接力到 X · 模型；同家换模型 → 切换模型 · 模型；都不变 → 不提示
      const lastTurn = selectedConversation?.turns.at(-1);
      if (continuing && lastTurn) {
        const harnessChanged = lastTurn.harness !== useHarness;
        const modelChanged = (routeModel ?? null) !== (lastTurn.model ?? null);
        const harnessLabel = useHarness === "deck" ? "AgentDeck Agent" : useHarness;
        if (harnessChanged) {
          setActionNotice(
            routeModel
              ? `接力到 ${harnessLabel} · ${routeModel.split("/").pop()}（上一会话已注入上下文）`
              : `接力到 ${harnessLabel}（上一会话已注入上下文）`,
          );
        } else if (modelChanged && routeModel) {
          setActionNotice(`切换模型 · ${routeModel.split("/").pop()}`);
        }
      }
      try {
        const previous = continuing && resumeSource ? { ...resumeSource } : undefined;
        const latest = selectedConversation?.turns.at(-1)?.id ?? selected;
        if (previous && latest && (!runningTask || latest !== selected)) {
          previous.events = (await getTaskEvents(latest)).map((event) => ({ event, key: nextKey() }));
        }
        await dispatchTask({
          harness: useHarness,
          cwd: useCwd,
          prompt: text,
          conversationId: continuing ? row?.conversation_id ?? selectedConversation?.turns[0].id ?? selected : null,
          attachments,
          mode: transferMode(harness, mode, useHarness, permission),
          model: routeModel,
          effort: routeEffort,
          permission,
          resumeSessionId: resumeId ?? null,
          projectId:
            selectedProjectId ??
            projects.find(
              (p) => p.dir.split("\\").join("/") === (useCwd || "").split("\\").join("/"),
            )?.id ??
            null,
        }, previous);
        setAttachments([]);
        setTimeout(() => setActionNotice(null), 3500);
        return true;
      } catch (e) {
        setActionError(String(e));
        return false;
      }
    },
    [
      selected,
      attachments,
      harness,
      mode,
      model,
      effort,
      executionScope,
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
        const config = preferencesRef.current[`${row.conversation_id ?? row.id}:${row.harness}`];
        setModel(config?.model ?? row.model ?? "");
        setEffort(config?.effort ?? row.execution_config?.resolved.effort ?? "");
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
  // 轮次产出：任务结束后拉取改动文件与生成工件
  const [turnArtifacts, setTurnArtifacts] = useState<{
    taskId: string;
    data: Awaited<ReturnType<typeof getTurnArtifacts>>;
  } | null>(null);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const artifactsTaskRef = useRef<string | null>(null);
  const fetchTurnArtifacts = useCallback(async (taskId: string) => {
    if (artifactsTaskRef.current === taskId) return;
    artifactsTaskRef.current = taskId;
    setArtifactsLoading(true);
    try {
      const data = await getTurnArtifacts(taskId);
      setTurnArtifacts({ taskId, data });
    } catch {
      setTurnArtifacts(null);
    } finally {
      setArtifactsLoading(false);
    }
  }, []);
  const refreshTurnArtifacts = useCallback(() => {
    if (selected) {
      artifactsTaskRef.current = null;
      fetchTurnArtifacts(selected);
    }
  }, [selected, fetchTurnArtifacts]);

  useEffect(() => {
    // 完成或失败的任务展示产出；运行中清掉旧面板
    if (!selected || selectedRunning || !["done", "failed"].includes(selectedStatus ?? "")) {
      setTurnArtifacts(null);
      artifactsTaskRef.current = null;
      return;
    }
    if (turnArtifacts?.taskId !== selected) fetchTurnArtifacts(selected);
  }, [selected, selectedRunning, selectedStatus, turnArtifacts, fetchTurnArtifacts]);

  const hasAuthError = selectedEvents.some(
    ({ event: e }) => e.type === "error" && e.kind === "auth",
  );
  const hasQuotaError = selectedEvents.some(
    ({ event: e }) => e.type === "error" && e.kind === "quota",
  );
  const hasModelError = selectedEvents.some(
    ({ event: e }) => e.type === "error" && e.kind === "model",
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

  const handleViewFileDiff = useCallback(
    (file: { diff: string }) => {
      if (!selected) return;
      setDiff({ taskId: selected, text: file.diff });
    },
    [selected],
  );

  const handleUndoFile = useCallback(
    (file: { path: string }) => {
      if (!selected) return;
      undoTaskFile(selected, file.path)
        .then(refreshTurnArtifacts)
        .catch((e) => setActionError(String(e)));
    },
    [selected, refreshTurnArtifacts],
  );

  const handleOpenArtifact = useCallback((path: string, reveal: boolean) => {
    openArtifact(path, reveal).catch((e) => setActionError(String(e)));
  }, []);

  const artifactsFooter = selected ? (
    <TurnArtifactsPanel
      data={turnArtifacts?.taskId === selected ? turnArtifacts.data : null}
      loading={artifactsLoading}
      onViewDiff={handleViewFileDiff}
      onUndo={handleUndoFile}
      onOpen={handleOpenArtifact}
    />
  ) : null;

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
  const reconfigureRunning = async () => {
    if (!selectedRow || !selectedLive?.running || busyReconfigure) return;
    const source = selectedRow;
    const previous = { ...selectedLive };
    const config = { model, effort };
    setBusyReconfigure(true);
    reconfiguringTasks.current.add(source.id);
    setActionError(null);
    try {
      const [guided, graphs] = await Promise.all([listCollaborations(), listGraphRuns(source.id)]);
      if (guided.some((run) => run.status === "running" && run.task_ids.includes(source.id))) {
        throw new Error("当前轮次由指导协作管理，请调整后续阶段配置或先停止协作");
      }
      if (graphs.some((run) => run.status === "running" && run.nodes.some((node) => node.task_id === source.id))) {
        throw new Error("当前轮次由并行协作管理，请调整待启动节点配置或先停止协作");
      }
      await cancelTask(source.id);
      const deadline = Date.now() + 10000;
      let stopped = false;
      while (Date.now() < deadline) {
        if (deletedTasks.current.has(source.id) || deletingTasks.current.has(source.id)) throw new Error("会话正在删除，已停止切换");
        const rows = await listTasks(Number.MAX_SAFE_INTEGER);
        const row = rows.find((r) => r.id === source.id);
        if (!row) throw new Error("会话已删除，已停止切换");
        if (row.status !== "running") { stopped = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!stopped) throw new Error("旧执行者尚未结束，未启动新轮次");
      previous.events = (await getTaskEvents(source.id)).map((event) => ({ event, key: nextKey() }));
      await dispatchTask({
        harness: source.harness, cwd: source.cwd, prompt: "用户已停止上一轮并调整执行配置。先核对文件与已有执行证据，再继续尚未完成的任务，不重复已完成的操作。",
        mode: source.mode, model: config.model, effort: config.effort, permission: previous.permission ?? "auto",
        conversationId: source.conversation_id ?? source.id, resumeSessionId: null, projectId: source.project_id,
        relay: true,
      }, previous, previous.queued, previous.queuedConfigs);
    } catch (error) { setActionError(String(error)); }
    finally { reconfiguringTasks.current.delete(source.id); setBusyReconfigure(false); }
  };

  // Context is compiled by the backend; no separate summarization request.
  const handoff = async (target: string) => {
    if (!selectedRow || busyHandoff) return;
    setBusyHandoff(true);
    setActionError(null);
    try {
      const latest = selectedConversation?.turns.at(-1)?.id ?? selectedRow.id;
      const events = await getTaskEvents(latest);
      const previous: LiveTask = selectedLive ? { ...selectedLive } : {
        harness: selectedRow.harness, cwd: selectedRow.cwd, prompt: selectedRow.prompt,
        mode: selectedRow.mode, permission, projectId: selectedRow.project_id,
        events: events.map((event) => ({ event, key: nextKey() })), running: false, exitCode: selectedRow.exit_code,
      };
      if (!selectedLive || latest !== selectedRow.id) {
        previous.events = events.map((event) => ({ event, key: nextKey() }));
      }
      await dispatchTask({
        harness: target,
        cwd: selectedRow.cwd,
        prompt: "继续当前会话的未完成任务，先核对当前文件和最新用户要求。",
        conversationId: selectedRow.conversation_id ?? selectedConversation?.turns[0].id ?? selectedRow.id,
        relay: true,
        mode: transferMode(harness, mode, target, permission),
        model: executionFor(target).model,
        effort: executionFor(target).effort,
        permission,
        resumeSessionId: null,
        projectId: selectedRow.project_id,
      }, previous);
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
        readOnly: !["full", "yolo", "default", "auto", ""].includes(mode)
          || (harness === "deck" && permission === "approved"),
        phaseTimeoutSecs: phaseTimeoutMinutes * 60,
        execution: phaseExecution,
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
              {selectedRow && (detailsOpen || selectedStatus === "failed") && <Suspense fallback={<div role="status">加载上下文…</div>}>
                <ConversationContext taskId={selectedRow.id} onRecovered={refreshHistory} />
              </Suspense>}
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
                        conversationId: r.conversation_id ?? selectedConversation?.turns[0].id ?? r.id,
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
                {hasModelError && !selectedRunning && (
                  <span className="flex items-center gap-1.5 rounded-full border border-stone-300 bg-stone-100 px-3 py-1 text-xs text-stone-600">
                    <IconInfo size={13} />
                    当前模型已不可用（上游已废弃/下线）。更换模型：输入框上方「模型」下拉里重新选择即可
                  </span>
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
                       <div key={h} className="handoff-target">
                       <button
                        aria-label={`用 ${h === "deck" ? "AgentDeck Agent" : h} 接力`}
                        onClick={() => handoff(h)}
                        disabled={busyHandoff}
                        className="flex items-center gap-1.5 rounded-full border px-3 py-1 transition-colors hover:bg-stone-100 disabled:opacity-50"
                         style={{ borderColor: "var(--border)", color: "var(--text-2)" }}
                      >
                        <HarnessIcon harness={h} size={12} />
                        用 {h === "deck" ? "AgentDeck Agent" : h} 接力
                      </button>
                       <ExecutionPicker harness={h} value={executionFor(h)} taskId={executionScope}
                         onChange={(config) => rememberExecution(h, config)} label={`${h} 接力 `} disabled={busyHandoff} />
                       </div>
                    ))}
                </div>
                {busyHandoff && (
                  <div className="typing-dots mt-2 flex items-center text-xs text-stone-400">
                    正在同步会话记录…
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
                    <select aria-label="指导方" value={mentor} onChange={(e) => {
                      setMentor(e.target.value); setPhaseExecution((p) => ({ ...p, planning: inheritedExecution(), reviewing: inheritedExecution() }));
                    }}>
                      {["zcode", "codex", "opencode", "deck"].filter((item) => item !== worker)
                        .map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                  <label>执行方
                    <select aria-label="执行方" value={worker} onChange={(e) => {
                      setWorker(e.target.value); setPhaseExecution((p) => ({ ...p, executing: inheritedExecution() }));
                    }}>
                      {["zcode", "codex", "opencode", "deck"].filter((item) => item !== mentor)
                        .map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                  <label>最多执行轮数
                    <select aria-label="最多执行轮数" value={maxRounds} onChange={(e) => setMaxRounds(Number(e.target.value))}>
                      {[1, 2, 3].map((round) => <option key={round} value={round}>{round}</option>)}
                    </select>
                  </label>
                  <label>阶段时限
                    <input aria-label="阶段时限（分钟）" type="number" min={1} max={60} value={phaseTimeoutMinutes}
                      onChange={(event) => setPhaseTimeoutMinutes(Math.min(60, Math.max(1, Number(event.target.value) || 1)))} />
                    分钟
                  </label>
                  <button onClick={startGuidedCollaboration} disabled={busyCollaboration}
                    className="rounded-full border px-3 py-1 disabled:opacity-50">
                    {busyCollaboration ? "启动中…" : "开始指导协作"}
                  </button>
                </div>
                <div className="phase-execution">
                  {(["planning", "executing", "reviewing"] as const).map((phase) => <div key={phase}>
                    <span>{({ planning: "规划", executing: "执行", reviewing: "验收" })[phase]}</span>
                    <ExecutionPicker harness={phase === "executing" ? worker : mentor} value={phaseExecution[phase]}
                      taskId={executionScope} label={`${phase} `} disabled={busyCollaboration}
                      onChange={(config) => setPhaseExecution((p) => ({ ...p, [phase]: config }))} />
                  </div>)}
                </div>
              </Disclosure>
            )}
            {collaborations.filter((item) => item.source_task_id === selected
              || (item.conversation_id && item.conversation_id === (selectedRow?.conversation_id ?? selectedConversation?.turns[0]?.id))).map((item) => (
              <div key={item.id} className="mx-6 mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span>{item.mentor} 指导 {item.worker}{item.read_only ? " · 只读" : ""} · {({
                  planning: "规划", executing: "实施", reviewing: "验收",
                } as Record<string, string>)[item.phase] ?? item.phase} · 第 {item.round}/{item.max_rounds} 轮 · {({
                  running: "运行中", done: "已通过", failed: "失败", cancelled: "已停止", needs_attention: "待处理",
                } as Record<string, string>)[item.status] ?? item.status}</span>
                {item.current_task_id && <button onClick={() => viewTask(item.current_task_id!)}>查看当前阶段</button>}
                {item.error && <span className="text-red-700">{item.error}</span>}
                {item.status === "running" && <button onClick={() => cancelCollaboration(item.id).catch((e) => setActionError(String(e)))}>停止协作</button>}
                {item.status === "running" && <details className="execution-future">
                  <summary>后续阶段配置</summary>
                  {(["planning", "executing", "reviewing"] as const).map((phase) => <DelegationExecution key={phase}
                    runId={item.id} target={phase} harness={phase === "executing" ? item.worker : item.mentor}
                    taskId={item.source_task_id} initial={item.execution?.[phase] ?? inheritedExecution()}
                    disabled={phase === "planning"} />)}
                </details>}
              </div>
            ))}
            </div>

            {/* 审批卡片：工具授权；ask_user_question 渲染为选项式提问（抄 ZCode AskUserQuestion） */}
            {approval && selectedRunning && (
              <div className="anim-pop mx-6 mt-2 rounded-xl border border-amber-300 bg-amber-50/70 p-3">
                {"__question" in approval.args ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-amber-800">
                      <span className="rounded bg-amber-200/70 px-1.5 py-0.5 font-mono text-[10px]">
                        {(approval.args.__question as { header?: string }).header ?? "问题"}
                      </span>
                      {(approval.args.__question as { question?: string }).question}
                    </div>
                    {((approval.args.__question as { options?: { label: string; description?: string; preview?: string }[] }).options ?? []).map((opt) => (
                      <button
                        key={opt.label}
                        onClick={() =>
                          invokePiCommand(approval.taskId, "approve", approval.id, opt.label)
                            .then(() => clearApproval(approval.taskId))
                            .catch((e) => setActionError(String(e)))
                        }
                        className="block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-left transition-colors hover:border-amber-400 hover:bg-amber-50/50"
                      >
                        <div className="text-xs font-medium text-stone-700">{opt.label}</div>
                        {opt.description && <div className="mt-0.5 text-[11px] text-stone-500">{opt.description}</div>}
                        {opt.preview && (
                          <pre className="mt-1 max-h-40 overflow-auto rounded bg-stone-50 p-2 font-mono text-[10px] text-stone-600">{opt.preview}</pre>
                        )}
                      </button>
                    ))}
                    <div className="text-[11px] text-stone-400">Agent 正在等待你的选择（也可在输入框直接回复，或跳过此问题）</div>
                  </div>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            )}

            <LogPanel key={conversationKey} events={selectedEvents} running={selectedRunning} loading={!!selected && loadingEvents.has(selected)} footer={artifactsFooter} />
          </MotionLayer>
        )}

        {/* 底部输入卡：始终可见。运行中发送 = 入队（结束后自动续发） */}
        <m.div className="composer-dock" layout={motionEnabled ? "position" : false} layoutDependency={selected === null}>
          {actionError && <div className="action-error" role="alert">{actionError}</div>}
          {actionNotice && !actionError && <div className="action-notice">{actionNotice}</div>}
          <RuntimeStatus harness={harness} refreshKey={settingsOpen} onSettings={openSettings} />
          {selectedRow?.execution_config && <div className="execution-current">
            <span>{selectedRunning ? "本轮运行" : "本轮配置"}</span>
            <span title={selectedRow.execution_config.resolved.model ?? ""}>{selectedRow.harness} · {selectedRow.execution_config.resolved.model || "默认模型"}</span>
            <span>{effortLabel(selectedRow.execution_config.resolved.effort || "默认")}</span>
            {selectedRunning && harness === selectedRow.harness
              && ((selectedRow.execution_config.resolved.model ?? "") !== model
                || (selectedRow.execution_config.resolved.effort ?? "") !== effort)
              && <button type="button" className="context-command" disabled={busyReconfigure}
                onClick={() => void reconfigureRunning()}><RotateCcw size={14} />{busyReconfigure ? "等待停止" : "停止并按新配置继续"}</button>}
          </div>}
          {selected && selectedLive?.queued && selectedLive.queued.length > 0 && (
            <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-1.5 pb-1.5 text-xs">
              <span className="text-stone-400">已排队（结束后自动续发）：</span>
              {selectedLive.queued.map((q, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1 rounded-full border border-stone-200 px-2 py-0.5 text-stone-500"
                >
                  <span className="max-w-48 truncate">{q}</span>
                  <ExecutionPicker harness={selectedLive.harness} taskId={executionScope}
                    value={selectedLive.queuedConfigs?.[i] ?? { model: selectedLive.model ?? "", effort: selectedLive.effort ?? "" }}
                    label={`排队 ${i + 1} `} allowInherit={false} onChange={(config) => setLive((prev) => {
                      const task = prev[selected];
                      if (!task?.queued?.[i]) return prev;
                      const configs = task.queued.map((_, index) => task.queuedConfigs?.[index] ?? { model: task.model ?? "", effort: task.effort ?? "" });
                      configs[i] = config;
                      return { ...prev, [selected]: { ...task, queuedConfigs: configs } };
                    })} />
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
                            queuedConfigs: t.queuedConfigs?.filter((_, j) => j !== i),
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
                </div>
              ))}
            </div>
          )}
          <Composer
            attachments={attachments} onAttach={(paths) => setAttachments((prev) => [...prev, ...paths])} onRemoveAttachment={(p) => setAttachments((prev) => prev.filter((x) => x !== p))} draftKey={conversationKey}
            onStop={stopSelected}
            cwd={cwd}
            onCwdChange={setCwd}
            projects={projects}
            selectedProjectId={selectedProjectId}
            onProjectSelect={chooseProject}
            harness={harness}
            onHarnessChange={chooseHarness}
            mode={mode}
            onModeChange={(v) => {
              setMode(v);
              void setSetting("composer_mode", v).catch(() => {});
            }}
            model={model}
            onModelChange={(value) => rememberExecution(harness, { model: value, effort: "" })}
            effort={effort}
            onEffortChange={(value) => rememberExecution(harness, { model, effort: value })}
            executionScope={executionScope}
            permission={permission}
            catalogVersion={settingsOpen}
            onPermissionChange={(v) => {
              setPermission(v);
              void setSetting("composer_permission", v).catch(() => {});
            }}
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

/** 耗时派生：每块思考独立计时（上一事件 → 本块到达）；complete 回填本轮工作秒数 */
function decorateTiming(events: LogItem[]): LogItem[] {
  const out = events.map(({ event, key }) => ({
    key,
    event: { ...event } as AgentEvent & { ts?: number; durationMs?: number },
  }));
  let prevTs: number | null = null; // 上一事件的到达时刻
  let turnStart: number | null = null;
  for (const item of out) {
    const ev = item.event;
    // 思考块：ts = 该块思考结束（message_end 到达）≈ 思考耗时起点是上一事件
    if (ev.type === "thinking" && ev.ts && prevTs !== null && ev.ts > prevTs) {
      ev.durationMs = ev.ts - prevTs;
    }
    if (ev.ts) prevTs = ev.ts;
    if (ev.type === "user_message" && !ev.hidden && ev.ts) {
      turnStart = ev.ts;
    } else if (ev.type === "complete") {
      // 一轮的工作耗时：本轮 user_message → complete 的真实间隔
      if (turnStart !== null && ev.ts && ev.ts > turnStart) {
        ev.durationMs = ev.ts - turnStart;
      }
      turnStart = null;
    }
  }
  return out.map(({ event, key }) => ({ event: event as AgentEvent, key }));
}

/** 工具段折叠：tool_use/tool_result/thinking 的工作序列归为一段（≥2 次调用收成一行摘要，可展开逐条看）。
 * 紧邻文本输出的最后一段思考保留在外——思考耗时徽标保持可见。 */
type LogEntry = LogItem;
type DisplayGroup =
  | { kind: "single"; item: LogEntry }
  | { kind: "segment"; items: LogEntry[]; uses: { tool: string; n: number; targets: number | null }[]; failed: boolean };

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
    const files = new Map<string, Set<string>>();
    let failed = false;
    let calls = 0;
    for (const { event } of seg) {
      if (event.type === "tool_use") {
        calls += 1;
        const tool = event.tool.toLowerCase();
        uses.set(tool, (uses.get(tool) ?? 0) + 1);
        // read/grep/ls 类：统计涉及的文件/搜索目标（去重）
        const a = (event as { args?: Record<string, unknown> }).args;
        const target =
          typeof a?.path === "string" ? a.path
          : typeof a?.file_path === "string" ? a.file_path
          : typeof a?.pattern === "string" ? `搜索 ${a.path ? a.path + "/" : ""}${a.pattern}`
          : null;
        if (target) {
          const set = files.get(tool) ?? new Set<string>();
          set.add(target);
          files.set(tool, set);
        }
      } else if (event.type === "tool_result" && !event.ok) {
        failed = true;
      }
    }
    if (calls >= TOOL_RUN_MIN) {
      out.push({
        kind: "segment",
        items: seg,
        uses: [...uses.entries()].map(([tool, n]) => {
          const targets = files.get(tool);
          return { tool, n, targets: targets ? targets.size : null };
        }),
        failed,
      });
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
  footer,
}: {
  events: { event: AgentEvent; key: number }[];
  running: boolean;
  loading: boolean;
  footer?: React.ReactNode;
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
        const summary = group.uses
          .map(({ tool, n, targets }) => {
            const isSearch = tool === "grep" || tool === "find";
            if (targets !== null) {
              return isSearch ? `${tool} ×${n}（搜索 ${targets} 处）` : `${tool} ×${n}（${targets} 个文件）`;
            }
            return `${tool} ×${n}`;
          })
          .join(" · ");
        return (
          <Disclosure
            key={first.key}
            className="activity-event"
            title={
              <>
                <ToolIcon tool="tool" />
                <span>
                  工具操作 ×{group.uses.reduce((n, { n: k }) => n + k, 0)}：{summary}
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
      {footer}
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
