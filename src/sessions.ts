import type { TaskRow } from "./types";

export type SessionGroup = {
  key: string;
  turns: TaskRow[];
};

export function sessionKey(task: TaskRow): string {
  // 会话根 id 跨 harness 传递：接力/续接轮次与原会话同组
  if (task.conversation_id) return JSON.stringify(["conv", task.conversation_id]);
  return JSON.stringify(task.session_id
    ? [task.harness, "session", task.session_id]
    : [task.harness, "task", task.id]);
}

export function transferMode(source: string, mode: string | null, target: string, permission?: string | null): string {
  if (source === target) return mode ?? "default";
  const full = ["full", "yolo", "default", ""].includes(mode ?? "");
  // Approval and sandbox modes are not interchangeable across native CLIs.
  const restricted = !full || (source === "deck" && permission === "approved");
  if (target === "codex") return restricted ? "readonly" : "full";
  if (target === "zcode") return restricted ? "plan" : "yolo";
  return restricted ? "plan" : "default";
}

export function groupSessions(tasks: TaskRow[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const task of tasks) {
    const key = sessionKey(task);
    const group = groups.get(key);
    if (group) group.turns.push(task);
    else groups.set(key, { key, turns: [task] });
  }
  for (const group of groups.values()) {
    group.turns.sort((a, b) => a.conversation_seq != null && b.conversation_seq != null
      ? a.conversation_seq - b.conversation_seq || a.id.localeCompare(b.id)
      : a.created_at - b.created_at || a.id.localeCompare(b.id));
  }
  return [...groups.values()].sort((a, b) =>
    b.turns[b.turns.length - 1].created_at - a.turns[a.turns.length - 1].created_at
    || a.key.localeCompare(b.key));
}
