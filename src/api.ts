import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent, PiEvent, TaskRow } from "./types";
import { normalizeAgentEvents } from "./types";
import { applyTaskUpdates } from "./taskState";

/** 是否运行在 Tauri 窗口内。纯浏览器（vite 预览）下 IPC 桥不存在。 */
export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type HarnessHealth = { ready: boolean; issues: string[] };
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
};

export async function startCollaboration(params: {
  sourceTaskId: string;
  mentor: string;
  worker: string;
  maxRounds: number;
}): Promise<Collaboration> {
  if (!inTauri) browserStub("协作");
  return invoke("start_collaboration", {
    sourceTaskId: params.sourceTaskId,
    mentor: params.mentor,
    worker: params.worker,
    maxRounds: params.maxRounds,
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
  permission: string | null;
  resumeSessionId: string | null;
  projectId?: string | null;
  /** 会话根 id：接力/续接轮次继承（跨 harness 归同一会话） */
  conversationId?: string | null;
  /** 接力轮次：注入的简报不作为用户消息展示 */
  relay?: boolean;
}): Promise<string> {
  if (!inTauri) browserStub("派任务");
  const { task_id } = await invoke<{ task_id: string }>("start_task", params);
  return task_id;
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
  if (!inTauri) return [];
  const events = await invoke<(PiEvent | AgentEvent)[]>("get_task_events", { taskId });
  const updates = events.flatMap(normalizeAgentEvents).map((event, key) => ({
    taskId, item: { event, key },
  }));
  return applyTaskUpdates({
    harness: "", cwd: "", prompt: "", mode: null, events: [], running: false, exitCode: null,
  }, updates).events.map((item) => item.event);
}

export async function getTaskDiff(taskId: string): Promise<string> {
  if (!inTauri) browserStub("查看 Diff");
  return await invoke<string>("get_task_diff", { taskId });
}

export async function runLogin(harness: string): Promise<void> {
  if (!inTauri) browserStub("唤起登录");
  await invoke("run_login", { harness });
}

export async function invokePiCommand(
  taskId: string,
  cmd: string,
  id?: string,
): Promise<void> {
  if (!inTauri) browserStub("审批操作");
  await invoke("pi_command", { taskId, cmd, id: id ?? null });
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

/** AI 会话接力：deck 运行时压缩会话记录为交接简报（失败自动回退机械版） */
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
