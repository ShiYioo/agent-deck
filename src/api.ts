import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent, PiEvent, TaskRow } from "./types";
import { normalizeAgentEvents } from "./types";
import { applyTaskUpdates } from "./taskState";

/** 是否运行在 Tauri 窗口内。纯浏览器（vite 预览）下 IPC 桥不存在。 */
export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type HarnessHealth = { ready: boolean; issues: string[] };
export type ExecutionConfig = { model: string | null; effort: string | null };
export type ExecutionSnapshot = { requested: ExecutionConfig; resolved: ExecutionConfig; transport: string };
export type ModelCapability = { model: string; efforts: string[]; context_window: number | null };
export type PhaseExecution = { planning: ExecutionConfig; executing: ExecutionConfig; reviewing: ExecutionConfig };
export type ExecutionOverride = { target: string; version: number; config: ExecutionConfig };
export const inheritedExecution = (): ExecutionConfig => ({ model: null, effort: null });

const capabilityRequests = new Map<string, { expires: number; request: Promise<ModelCapability[]> }>();
export async function discoverExecutionModels(harness: string): Promise<ModelCapability[]> {
  if (!inTauri) return [];
  const cached = capabilityRequests.get(harness);
  if (cached && cached.expires > Date.now()) return cached.request;
  const entry = { expires: Infinity, request: invoke<ModelCapability[]>("discover_execution_models", { harness }) };
  capabilityRequests.set(harness, entry);
  try { const rows = await entry.request; entry.expires = Date.now() + 60_000; return rows; }
  catch (error) { if (capabilityRequests.get(harness) === entry) capabilityRequests.delete(harness); throw error; }
}
export async function getExecutionDefaults(taskId: string | null, harness: string): Promise<ExecutionConfig> {
  if (!inTauri) return inheritedExecution();
  return invoke("get_execution_defaults", { taskId, harness });
}
export async function setExecutionDefaults(taskId: string | null, harness: string, config: ExecutionConfig): Promise<void> {
  if (!inTauri) return;
  return invoke("set_execution_defaults", { taskId, harness, config });
}
export async function listExecutionOverrides(runId: string): Promise<ExecutionOverride[]> {
  return invoke("list_execution_overrides", { runId });
}
export async function updateDelegationExecution(runId: string, target: string, expectedVersion: number, config: ExecutionConfig): Promise<ExecutionOverride> {
  return invoke("update_delegation_execution", { runId, target, expectedVersion, config });
}
export type Collaboration = {
  id: string;
  source_task_id: string;
  mentor: string;
  worker: string;
  status: string;
  phase: string;
  round: number;
  max_rounds: number;
  current_task_id: string | null;
  task_ids: string[];
  error: string | null;
  conversation_id?: string | null;
  read_only?: boolean;
  phase_timeout_secs?: number;
  execution?: PhaseExecution;
};

export async function startCollaboration(params: {
  sourceTaskId: string;
  mentor: string;
  worker: string;
  maxRounds: number;
  readOnly?: boolean;
  phaseTimeoutSecs?: number;
  execution?: PhaseExecution;
}): Promise<Collaboration> {
  if (!inTauri) browserStub("协作");
  return invoke("start_collaboration", {
    sourceTaskId: params.sourceTaskId,
    mentor: params.mentor,
    worker: params.worker,
    maxRounds: params.maxRounds,
    readOnly: params.readOnly ?? false,
    phaseTimeoutSecs: params.phaseTimeoutSecs ?? 900,
    execution: params.execution,
  });
}

export async function cancelCollaboration(id: string): Promise<void> {
  if (!inTauri) browserStub("停止协作");
  await invoke("cancel_collaboration", { id });
}

export async function listCollaborations(): Promise<Collaboration[]> {
  if (!inTauri) return [];
  return invoke("list_collaborations");
}

export type SharedConversationState = { version: number; goal: string; notes: string };
export type ConversationInfo = {
  conversation_id: string;
  bindings: { harness: string; cwd: string; session_id: string; task_id: string; cursor_task_id: string | null; status: string }[];
  state: SharedConversationState;
  recovery_task_ids: string[];
  deliveries: { task_id: string; strategy: string; status: string; source_ids: string }[];
};
export type RecoveryCheck = {
  safe: boolean;
  active_processes: string[];
  workspace_changed: boolean;
  workspace_path: string;
  summary: string;
};
export type ContextPage = {
  items: { task_id: string; harness: string; seq: number; event: Record<string, unknown> }[];
  next_offset: number | null;
};
export async function getConversationInfo(taskId: string): Promise<ConversationInfo> {
  if (!inTauri) browserStub("会话状态");
  return invoke("get_conversation_info", { taskId });
}
export async function searchConversationContext(taskId: string, query: string, offset = 0): Promise<ContextPage> {
  if (!inTauri) browserStub("会话历史");
  return invoke("search_conversation_context", { taskId, query, offset });
}
export async function updateConversationState(taskId: string, expectedVersion: number, goal: string, notes: string): Promise<SharedConversationState> {
  if (!inTauri) browserStub("共享任务状态");
  return invoke("update_conversation_state", { taskId, expectedVersion, goal, notes });
}
export async function confirmConversationRecovery(taskId: string, confirmed: boolean): Promise<void> {
  if (!inTauri) browserStub("恢复会话");
  return invoke("confirm_conversation_recovery", { taskId, confirmed });
}
export async function inspectConversationRecovery(taskId: string): Promise<RecoveryCheck> {
  if (!inTauri) browserStub("核对恢复环境");
  return invoke("inspect_conversation_recovery", { taskId });
}
export async function resetConversationBinding(taskId: string, harness: string): Promise<void> {
  if (!inTauri) browserStub("重建上下文");
  return invoke("reset_conversation_binding", { taskId, harness });
}

export type ContextPolicy = {
  version: number; allowed_harnesses: string[]; redact_secrets: boolean; blocked_terms: string[];
  context_window: number; output_reserve: number; overhead_reserve: number;
};
export type GraphNodeSpec = {
  id: string; harness: string; prompt: string; dependencies: string[]; read_only: boolean; execution?: ExecutionConfig;
  supervision?: { commander: string; max_rounds: number; execution?: ExecutionConfig } | null;
};
export type GraphRun = {
  id: string; source_task_id: string; conversation_id: string; cwd: string; base_commit: string;
  status: string; integrated: boolean; max_parallel: number; timeout_secs: number; error: string | null;
  nodes: { spec: GraphNodeSpec; status: string; task_id: string | null; report: string | null; error: string | null;
    phase?: string; round?: number;
    history?: { phase: string; round: number; harness: string; task_id: string; report: string }[];
    patch_path: string | null; patch_hash: string | null; worktree: string | null }[];
};
export async function getContextPolicy(taskId: string): Promise<ContextPolicy> {
  return invoke("get_context_policy", { taskId });
}
export async function updateContextPolicy(taskId: string, expectedVersion: number, policy: ContextPolicy): Promise<ContextPolicy> {
  return invoke("update_context_policy", { taskId, expectedVersion, policy });
}
export async function listGraphRuns(taskId: string): Promise<GraphRun[]> {
  return invoke("list_graph_runs", { taskId });
}
export async function startGraphRun(taskId: string, nodes: GraphNodeSpec[], maxParallel: number, timeoutSecs: number): Promise<GraphRun> {
  return invoke("start_graph_run", { sourceTaskId: taskId, nodes, maxParallel, timeoutSecs });
}
export async function startApprovedPlan(taskId: string, approvalId: string, nodes: GraphNodeSpec[]): Promise<{
  kind: "task" | "graph"; task_id: string | null; run: GraphRun | null;
}> {
  return invoke("start_approved_plan", { taskId, approvalId, nodes });
}
export async function cancelGraphRun(id: string): Promise<void> { return invoke("cancel_graph_run", { id }); }
export async function cancelGraphNode(id: string, nodeId: string): Promise<void> {
  return invoke("cancel_graph_node", { id, nodeId });
}
export async function integrateGraphRun(id: string, confirmed: boolean): Promise<GraphRun> {
  return invoke("integrate_graph_run", { id, confirmed });
}
export async function discardGraphRun(id: string, confirmed: boolean): Promise<GraphRun> {
  return invoke("discard_graph_run", { id, confirmed });
}

export async function checkHarness(harness: string): Promise<HarnessHealth> {
  if (!inTauri) return { ready: false, issues: ["浏览器预览未连接桌面运行器"] };
  return invoke<HarnessHealth>("check_harness", { harness });
}

function browserStub(label: string): never {
  throw new Error(`${label} 仅在桌面应用内可用（请用 pnpm tauri dev 启动）`);
}

/** 后端命令的薄封装：类型集中在这里，组件不直接碰 invoke。
 *  纯浏览器预览时抛出友好提示而不是 undefined 崩溃。 */

export async function startTask(params: {
  harness: string;
  cwd: string;
  prompt: string;
  mode: string | null;
  model: string | null;
  effort?: string | null;
  permission: string | null;
  resumeSessionId: string | null;
  projectId?: string | null;
  /** 会话根 id：接力/续接轮次继承（跨 harness 归同一会话） */
  conversationId?: string | null;
  /** 自动接力请求隐藏；用户本轮原话始终独立保存 */
  relay?: boolean;
  /** 附件绝对路径（codex 只取图片；zcode/opencode/deck 全支持） */
  attachments?: string[];
}): Promise<string> {
  if (!inTauri) browserStub("派任务");
  // Rust/Tauri 的 Vec<String> 参数是必填键；无附件也必须传空数组。
  const { attachments = [], ...rest } = params;
  const { task_id } = await invoke<{ task_id: string }>("start_task", { ...rest, attachments });
  return task_id;
}

export type TurnFileChange = {
  path: string;
  status: "added" | "modified" | "deleted";
  added: number | null;
  removed: number | null;
  binary: boolean;
  diff: string;
};

export type TurnArtifact = {
  path: string;
  kind: "image" | "archive" | "sheet" | "doc" | "pdf" | "other";
  size: number;
};

export type TurnArtifacts = {
  files: TurnFileChange[];
  artifacts: TurnArtifact[];
  base_dir: string;
};

/** 轮次产出：改动文件（+/-行、diff、可撤销）与生成工件 */
export async function getTurnArtifacts(taskId: string): Promise<TurnArtifacts> {
  return await invoke<TurnArtifacts>("get_turn_artifacts", { taskId });
}

/** 撤销单文件改动（未跟踪 = 删除新文件；跟踪 = 还原到 HEAD） */
export async function undoTaskFile(taskId: string, path: string): Promise<void> {
  await invoke("undo_task_file", { taskId, path });
}

/** 用系统默认程序打开工件 */
export async function openArtifact(path: string, reveal = false): Promise<void> {
  if (!inTauri) browserStub("打开工件");
  await invoke("open_artifact", { path, reveal });
}

export async function deleteTask(taskId: string): Promise<void> {
  if (!inTauri) browserStub("删除会话");
  await invoke("delete_task", { taskId });
}

export async function deleteSession(taskId: string): Promise<string[]> {
  if (!inTauri) browserStub("删除会话");
  return invoke<string[]>("delete_session", { taskId });
}

export async function cancelTask(taskId: string): Promise<void> {
  if (!inTauri) browserStub("终止任务");
  // deck 任务走 pi 会话的协作式中断；CLI 任务走进程组强杀
  if (taskId.startsWith("deck-")) {
    await invoke("pi_command", { taskId, cmd: "abort", id: null });
    return;
  }
  await invoke("cancel_task", { taskId });
}

export async function listTasks(limit = 50): Promise<TaskRow[]> {
  if (!inTauri) return [];
  return await invoke<TaskRow[]>("list_tasks", { limit });
}

export async function getTaskEvents(taskId: string): Promise<AgentEvent[]> {
  const events = await getTaskReplay(taskId);
  const updates = events.map((event, key) => ({
    taskId, item: { event, key },
  }));
  return applyTaskUpdates({
    harness: "", cwd: "", prompt: "", mode: null, events: [], running: false, exitCode: null,
  }, updates).events.map((item) => item.event);
}

/** Unfolded events retain the overlap with IPC buffered during history loading. */
export async function getTaskReplay(taskId: string): Promise<AgentEvent[]> {
  if (!inTauri) return [];
  const events = await invoke<(PiEvent | AgentEvent)[]>("get_task_events", { taskId });
  return events.flatMap(normalizeAgentEvents);
}

export async function getTaskDiff(taskId: string): Promise<string> {
  if (!inTauri) browserStub("查看 Diff");
  return await invoke<string>("get_task_diff", { taskId });
}

/** 剪贴板粘贴图片：dataURL 落成临时文件，返回可派发的绝对路径。 */
export async function savePasteImage(dataUrl: string): Promise<string> {
  if (!inTauri) browserStub("粘贴图片");
  return await invoke<string>("save_paste_image", { dataUrl });
}

export async function runLogin(harness: string): Promise<void> {
  if (!inTauri) browserStub("唤起登录");
  await invoke("run_login", { harness });
}

export async function invokePiCommand(
  taskId: string,
  cmd: string,
  id?: string,
  answer?: string,
): Promise<void> {
  if (!inTauri) browserStub("审批操作");
  await invoke("pi_command", { taskId, cmd, id: id ?? null, answer: answer ?? null });
}

/** 原生适配器任务（opencode 提问作答）的命令通道，经 stdin 下发到适配器。 */
export async function invokeTaskCommand(
  taskId: string,
  cmd: string,
  id?: string,
  answer?: string,
): Promise<void> {
  if (!inTauri) browserStub("交互操作");
  await invoke("task_command", { taskId, cmd, id: id ?? null, answer: answer ?? null });
}

/** 手动压缩上下文（/compact）：deck 走 pi 命令通道，原生适配器走 stdin 命令通道。
 *  只能作用于正在运行的会话——压缩需要活着的运行时进程。 */
export async function compactTask(taskId: string, instructions?: string): Promise<void> {
  if (!inTauri) browserStub("压缩上下文");
  const command = taskId.startsWith("deck-") ? "pi_command" : "task_command";
  await invoke(command, { taskId, cmd: "compact", id: null, answer: instructions ?? null });
}

export async function getSetting(key: string): Promise<string | null> {
  if (!inTauri) return null;
  return await invoke<string | null>("get_setting", { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  if (!inTauri) browserStub("保存设置");
  await invoke("set_setting", { key, value });
}

export type ModelProfile = {
  id: string;
  provider: string;
  label: string | null;
  api_key: string;
  base_url: string | null;
  model: string | null;
  /** 上游协议：chat（默认，Chat Completions）| responses（Responses API） */
  protocol: string | null;
  enabled: boolean;
  created_at: number;
};

/** 供应商档案下的模型列表条目（context_window 单位 token，空 = 通道默认） */
export type ProfileModel = {
  id: string;
  profile_id: string;
  model: string;
  context_window: number | null;
  /** 最大输出 token（null = 通道默认 8192） */
  max_tokens: number | null;
  /** 计费倍率快照（sub2api 模型广场 / new-api pricing；null = 未知） */
  rate_multiplier: number | null;
  created_at: number;
};

export async function listModelProfiles(): Promise<ModelProfile[]> {
  if (!inTauri) return [];
  return await invoke<ModelProfile[]>("list_model_profiles", {});
}

export async function addModelProfile(params: {
  provider: string;
  label: string | null;
  api_key: string;
  base_url: string | null;
  model: string | null;
  protocol: string | null;
}): Promise<ModelProfile> {
  // Tauri 2 命令参数默认收 camelCase（Rust 侧 snake_case 自动转换）
  return await invoke<ModelProfile>("add_model_profile", {
    provider: params.provider,
    label: params.label,
    apiKey: params.api_key,
    baseUrl: params.base_url,
    model: params.model,
    protocol: params.protocol,
  });
}

export async function updateModelProfile(params: {
  id: string;
  provider: string;
  label: string | null;
  api_key: string;
  base_url: string | null;
  model: string | null;
  protocol: string | null;
}): Promise<ModelProfile> {
  return await invoke<ModelProfile>("update_model_profile", {
    id: params.id,
    provider: params.provider,
    label: params.label,
    apiKey: params.api_key,
    baseUrl: params.base_url,
    model: params.model,
    protocol: params.protocol,
  });
}

export async function listProfileModels(profileId: string): Promise<ProfileModel[]> {
  return await invoke<ProfileModel[]>("list_profile_models", { profileId });
}

export async function addProfileModel(
  profileId: string,
  model: string,
  contextWindow: number | null,
  maxTokens: number | null,
): Promise<ProfileModel> {
  return await invoke<ProfileModel>("add_profile_model", {
    profileId,
    model,
    contextWindow,
    maxTokens,
  });
}

export async function updateProfileModel(
  id: string,
  model: string,
  contextWindow: number | null,
  maxTokens: number | null,
): Promise<void> {
  await invoke("update_profile_model", {
    id,
    model,
    contextWindow,
    maxTokens,
  });
}

export async function deleteProfileModel(id: string): Promise<void> {
  await invoke("delete_profile_model", { id });
}

export async function clearProfileModels(profileId: string): Promise<void> {
  await invoke("clear_profile_models", { profileId });
}

/** 从上游（OpenAI 兼容 GET {base}/models）拉取可用模型 ID 列表 */
export async function fetchUpstreamModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  return await invoke<string[]>("fetch_upstream_models", { baseUrl, apiKey });
}

/** 获取上游计费倍率并落库（sub2api 模型广场优先，new-api 价格表兜底） */
export async function fetchUpstreamRates(
  profileId: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ source: string; applied: number }> {
  return await invoke("fetch_upstream_rates", {
    profileId,
    baseUrl,
    apiKey,
  });
}

export async function setModelProfileEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await invoke("set_model_profile_enabled", { id, enabled });
}

export async function deleteModelProfile(id: string): Promise<void> {
  await invoke("delete_model_profile", { id });
}

/** 把任务 worktree 分支合并回主目录并清理 */
export async function mergeTaskWorktree(taskId: string): Promise<string> {
  if (!inTauri) browserStub("合并 worktree");
  return await invoke<string>("merge_task_worktree", { taskId });
}

/** 放弃任务的 worktree（不合并） */
export async function discardTaskWorktree(taskId: string): Promise<void> {
  if (!inTauri) browserStub("放弃 worktree");
  await invoke("discard_task_worktree", { taskId });
}

export async function listProjects(): Promise<
  { id: string; name: string; dir: string; created_at: number }[]
> {
  if (!inTauri) return [];
  return await invoke("list_projects", {});
}

export async function createProject(
  name: string,
  dir: string,
): Promise<void> {
  await invoke("create_project", { name, dir });
}

export async function deleteProject(id: string): Promise<void> {
  await invoke("delete_project", { id });
}

export async function getDefaultCwd(): Promise<string> {
  if (!inTauri) return "";
  return await invoke<string>("get_default_cwd");
}

/** 可选 AI 交接简报；普通发送与接力不依赖此命令。失败会明确报错。 */
export async function buildSmartHandoffPrompt(taskId: string): Promise<string> {
  if (!inTauri) browserStub("会话接力");
  return await invoke<string>("build_smart_handoff_prompt", { taskId });
}

/** 动态发现 harness 的真实模型列表（codex 读 desktop 状态、opencode 调 CLI） */
const modelDiscovery = new Map<string, { expires: number; request: Promise<string[]> }>();

export async function discoverModels(harness: string): Promise<string[]> {
  if (!inTauri) return [];
  const cached = modelDiscovery.get(harness);
  if (cached && cached.expires > Date.now()) return cached.request;
  const entry = { expires: Number.POSITIVE_INFINITY, request: invoke<string[]>("discover_models", { harness }) };
  modelDiscovery.set(harness, entry);
  try {
    const models = await entry.request;
    entry.expires = Date.now() + 60_000;
    return models;
  } catch (error) {
    if (modelDiscovery.get(harness) === entry) modelDiscovery.delete(harness);
    throw error;
  }
}
