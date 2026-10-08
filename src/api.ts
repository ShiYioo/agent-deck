import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent, TaskRow } from "./types";

/** 是否运行在 Tauri 窗口内。纯浏览器（vite 预览）下 IPC 桥不存在。 */
export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
}): Promise<string> {
  if (!inTauri) browserStub("派任务");
  const { task_id } = await invoke<{ task_id: string }>("start_task", params);
  return task_id;
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
  return await invoke<AgentEvent[]>("get_task_events", { taskId });
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
  enabled: boolean;
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
}): Promise<void> {
  await invoke("add_model_profile", params);
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
export async function discoverModels(harness: string): Promise<string[]> {
  if (!inTauri) return [];
  return await invoke<string[]>("discover_models", { harness });
}
