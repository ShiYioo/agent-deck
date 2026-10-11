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

export function groupSessions(tasks: TaskRow[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const task of tasks) {
    const key = sessionKey(task);
    const group = groups.get(key);
    if (group) group.turns.push(task);
    else groups.set(key, { key, turns: [task] });
  }
  for (const group of groups.values()) {
    group.turns.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  }
  return [...groups.values()].sort((a, b) =>
    b.turns[b.turns.length - 1].created_at - a.turns[a.turns.length - 1].created_at
    || a.key.localeCompare(b.key));
}
