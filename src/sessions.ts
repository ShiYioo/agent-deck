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

/** 各 harness 的权限模式目录。取值互不通用，切换 harness 时必须收敛。 */
export const MODE_CATALOG: Record<string, { value: string; label: string }[]> = {
  zcode: [
    { value: "yolo", label: "完全访问" },
    { value: "build", label: "编辑前确认" },
    { value: "edit", label: "允许编辑" },
    { value: "plan", label: "只读规划" },
  ],
  codex: [
    { value: "full", label: "完全访问" },
    { value: "write", label: "沙箱内写入" },
    { value: "readonly", label: "只读" },
  ],
  opencode: [
    { value: "default", label: "完全访问" },
    { value: "plan", label: "只读规划（plan）" },
  ],
  deck: [
    { value: "default", label: "标准执行" },
    { value: "plan", label: "计划模式（只读出方案）" },
    { value: "goal", label: "目标模式（目标跨轮持续）" },
  ],
};

/**
 * 把 mode 收敛到 `target` harness 的合法取值。
 *
 * mode 是跨 harness 共用的一个状态，而各 harness 的取值完全不重叠（zcode 的 yolo、
 * codex 的 full、opencode/deck 的 default…）。恢复持久化设置或切换 harness 时若不收敛，
 * Dropdown 会因为找不到匹配项而直接显示原始字符串（例如非 zcode harness 下显示裸的
 * "yolo"），并配上「完全访问」的警示图标，看起来像是个坏档位。
 */
export function normalizeMode(target: string, mode: string | null | undefined): string {
  const catalog = MODE_CATALOG[target];
  if (!catalog) return mode ?? "";
  if (mode && catalog.some((m) => m.value === mode)) return mode;
  return catalog[0].value;
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
