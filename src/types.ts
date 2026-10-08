/** 与 Rust 侧 AgentEvent 严格对应的统一事件模型 */
export type AgentEvent =
  | { type: "session_id"; id: string }
  | { type: "user_message"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; tool: string; detail: string }
  | { type: "tool_result"; tool: string; ok: boolean; detail: string }
  | { type: "status"; text: string }
  | { type: "complete"; ok: boolean }
  | { type: "error"; kind: string; message: string }
  | { type: "raw"; line: string };

/** deck-agent sidecar 的 pi 事件（结构化，Rust 原样入库） */
export type PiEvent = {
  type: string;
  taskId?: string;
  // 审批请求携带的工具信息
  id?: string;
  tool?: string;
  args?: Record<string, unknown>;
  // message_update / message_end 等按需展开的松散字段
  [key: string]: unknown;
};

/** 审批请求渲染用的结构 */
export type ApprovalRequest = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
};

/** 把 pi 事件归一化为可渲染事件（与 CLI 事件同一套 UI）。
 *  审批请求不进日志流，由 App 单独呈现为操作卡片。 */
export function piEventToAgentEvent(ev: PiEvent): AgentEvent | null {
  const t = ev.type;
  if (t === "deck_error") {
    return { type: "error", kind: "other", message: String(ev.message ?? "未知错误") };
  }
  if (t === "deck_run_start") return { type: "status", text: "pi 运行时启动" };
  if (t === "deck_run_end") return { type: "complete", ok: true };
  if (t === "deck_approval_decided") {
    return {
      type: "status",
      text: ev.approved ? "已批准" : "已拒绝",
    };
  }
  if (t === "tool_execution_start") {
    return {
      type: "tool_use",
      tool: String(ev.toolName ?? "tool"),
      detail: JSON.stringify(ev.args ?? {}).slice(0, 160),
    };
  }
  if (t === "tool_execution_end") {
    const out = ev.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const text =
      out?.content
        ?.map((c) => c.text ?? "")
        .join("\n")
        .slice(0, 400) ?? "";
    return { type: "tool_result", tool: String(ev.toolName ?? "tool"), ok: !out?.isError, detail: text };
  }
  if (t === "message_end" || t === "message_update") {
    const message = ev.message as
      | { role?: string; content?: Array<{ type?: string; text?: string }> }
      | undefined;
    if (!message || message.role !== "assistant") return null;
    const text = (message.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    if (t === "message_update") return null; // 流式增量暂不渲染，end 时整段出
    if (text.trim()) return { type: "assistant_message", text };
    return null;
  }
  return null;
}

/** 与 Rust 侧 store::TaskRow 对应（snake_case 透传） */
export type ProjectRow = {
  id: string;
  name: string;
  dir: string;
  created_at: number;
};

export type TaskRow = {
  id: string;
  harness: string;
  cwd: string;
  prompt: string;
  mode: string | null;
  model: string | null;
  project_id: string | null;
  session_id: string | null;
  base_branch: string | null;
  worktree_dir: string | null;
  status: "running" | "done" | "failed" | "cancelled";
  exit_code: number | null;
  created_at: number;
  finished_at: number | null;
};

/** 前端内存中的运行态任务 */
export type LiveTask = {
  harness: string;
  cwd: string;
  prompt: string;
  mode: string | null;
  events: { event: AgentEvent; key: number }[];
  running: boolean;
  exitCode: number | null;
  sessionId?: string;
  /** 运行中排队的后续消息（任务结束自动续发） */
  queued?: string[];
  /** deck 运行时的 todo 清单（todo_write 工具维护） */
  todos?: { content: string; status: string }[];
};
