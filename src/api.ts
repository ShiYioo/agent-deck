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
}): Promise<string> {
  if (!inTauri) browserStub("派任务");
  const { task_id } = await invoke<{ task_id: string }>("start_task", params);
  return task_id;
}

export async function cancelTask(taskId: string): Promise<void> {
  if (!inTauri) browserStub("终止任务");
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

export async function getDefaultCwd(): Promise<string> {
  if (!inTauri) return "";
  return await invoke<string>("get_default_cwd");
}

/** 动态发现 harness 的真实模型列表（codex 读 desktop 状态、opencode 调 CLI） */
export async function discoverModels(harness: string): Promise<string[]> {
  if (!inTauri) return [];
  return await invoke<string[]>("discover_models", { harness });
}
