import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent, TaskRow } from "./types";

/** 后端命令的薄封装：类型集中在这里，组件不直接碰 invoke */

export async function startTask(params: {
  harness: string;
  cwd: string;
  prompt: string;
  mode: string | null;
  resumeSessionId: string | null;
  apiKey?: string;
}): Promise<string> {
  const { task_id } = await invoke<{ task_id: string }>("start_task", params);
  return task_id;
}

export async function cancelTask(taskId: string): Promise<void> {
  await invoke("cancel_task", { taskId });
}

export async function listTasks(limit = 50): Promise<TaskRow[]> {
  return await invoke<TaskRow[]>("list_tasks", { limit });
}

export async function getTaskEvents(taskId: string): Promise<AgentEvent[]> {
  return await invoke<AgentEvent[]>("get_task_events", { taskId });
}

export async function getTaskDiff(taskId: string): Promise<string> {
  return await invoke<string>("get_task_diff", { taskId });
}

export async function runLogin(harness: string): Promise<void> {
  await invoke("run_login", { harness });
}

export async function invokePiCommand(
  taskId: string,
  cmd: string,
  id?: string,
): Promise<void> {
  await invoke("pi_command", { taskId, cmd, id: id ?? null });
}

export async function getSetting(key: string): Promise<string | null> {
  return await invoke<string | null>("get_setting", { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  await invoke("set_setting", { key, value });
}

export async function getDefaultCwd(): Promise<string> {
  return await invoke<string>("get_default_cwd");
}
