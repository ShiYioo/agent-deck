import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent, TaskRow } from "./types";

/** 后端命令的薄封装：类型集中在这里，组件不直接碰 invoke */

export async function startTask(params: {
  harness: string;
  cwd: string;
  prompt: string;
  mode: string | null;
  resumeSessionId: string | null;
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
