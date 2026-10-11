/** 与 Rust 侧 AgentEvent 严格对应的统一事件模型 */
export type AgentEvent =
  | { type: "session_id"; id: string }
  | { type: "user_message"; text: string; hidden?: boolean }
  | { type: "assistant_message"; text: string; streamId?: string; streaming?: boolean }
  | { type: "thinking"; text: string; streamId?: string; streaming?: boolean; durationMs?: number }
  | { type: "tool_use"; tool: string; detail: string; args?: Record<string, unknown> }
  | { type: "tool_result"; tool: string; ok: boolean; detail: string }
  | { type: "status"; text: string }
  | { type: "complete"; ok: boolean; durationMs?: number }
  | { type: "error"; kind: string; message: string }
  | { type: "raw"; line: string };

/** 统一事件可携带入库时间戳（ms，Rust append_event 统一打点），用于思考/轮次耗时 */
export type TimedAgentEvent = AgentEvent & { ts?: number };

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
  taskId: string;
  id: string;
  tool: string;
  args: Record<string, unknown>;
};

/** 把 pi 事件归一化为可渲染事件（与 CLI 事件同一套 UI）。
 *  审批请求不进日志流，由 App 单独呈现为操作卡片。 */
/** 从上游错误串（如 `429: {"error":{"message":"余额不足…"}}`）提取人话 */
export function providerErrorMessage(raw: string): string {
  const m = raw.match(/^\d+:\s*([\s\S]*)$/);
  const body = (m ? m[1] : raw).trim();
  try {
    const v = JSON.parse(body) as { message?: string; error?: { message?: string } };
    const message = v?.error?.message ?? v?.message;
    return typeof message === "string" ? message : body;
  } catch {
    return body;
  }
}

export function errorEvent(raw: string): AgentEvent {
  const message = providerErrorMessage(raw);
  const kind = /401|403|unauthorized|invalid.*(key|token)|authentication|鉴权|认证|令牌/i.test(raw)
    ? "auth"
    : /429|quota|credit|balance|rate.limit|余额|额度|限流|1113/i.test(raw)
      ? "quota"
      : "other";
  return { type: "error", kind, message };
}

export function piEventToAgentEvent(ev: PiEvent): AgentEvent | null {
  const t = ev.type;
  if (t === "deck_error") {
    return errorEvent(String(ev.message ?? "未知错误"));
  }
  if (t === "auto_retry_start") {
    return {
      type: "status",
      text: `请求失败，自动重试（第 ${ev.attempt ?? "?"}/${ev.maxAttempts ?? "?"} 次）…`,
    };
  }
  if (t === "deck_run_start") return { type: "status", text: "pi 运行时启动" };
  if (t === "deck_status") return { type: "status", text: String(ev.text ?? "") };
  if (t === "deck_session_file") return { type: "session_id", id: String(ev.path ?? "") };
  if (t === "deck_run_end") return { type: "complete", ok: ev.ok !== false && ev.status !== "cancelled" && ev.status !== "failed" };
  if (t === "deck_approval_decided") {
    return {
      type: "status",
      text: ev.approved ? "已批准" : "已拒绝",
    };
  }
  if (t === "tool_execution_start") {
    const tool = String(ev.toolName ?? "tool");
    const args = ev.args as Record<string, unknown> | undefined;
    // bash 命令透明：展示命令本身而非 JSON 包装，长度放宽保证可读
    const detail =
      tool === "bash" && typeof args?.command === "string"
        ? String(args.command).slice(0, 800)
        : JSON.stringify(args ?? {}, null, 2).slice(0, 400);
    return {
      type: "tool_use",
      tool,
      detail,
      args: args && typeof args === "object" ? (args as Record<string, unknown>) : undefined,
    };
  }
  if (t === "tool_execution_end") {
    const out = ev.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const text =
      out?.content
        ?.map((c) => c.text ?? "")
        .join("\n")
         ?? "";
    return { type: "tool_result", tool: String(ev.toolName ?? "tool"), ok: !ev.isError && !out?.isError, detail: text };
  }
  if (t === "message_end" || t === "message_update") {
    const message = ev.message as
      | {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
          stopReason?: string;
          errorMessage?: string;
          timestamp?: number;
        }
      | undefined;
    if (!message || message.role !== "assistant") return null;
    const text = (message.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    if (text.trim()) return {
      type: "assistant_message", text,
      streamId: String(message.timestamp ?? "assistant"),
      streaming: t === "message_update",
    };
    // 失败的空回复：上游错误（401 令牌过期 / 1113 余额不足…）必须可见，不能吞
    if (message.stopReason === "error" && message.errorMessage) {
      return errorEvent(message.errorMessage);
    }
    return null;
  }
  return null;
}

/** Live IPC and persisted SDK events go through the same adapter. */
export function normalizeAgentEvents(ev: PiEvent | AgentEvent): AgentEvent[] {
  const nativeTypes = new Set([
    "session_id", "user_message", "assistant_message", "thinking", "tool_use",
    "tool_result", "status", "complete", "error", "raw",
  ]);
  // 思考/轮次耗时的数据源：每个事件都带到达时刻（入库事件自带 ts，实时流补当前时刻）
  type Timed = AgentEvent & { ts?: number };
  const stamp = (e: Timed): AgentEvent =>
    ({ ...e, ts: e.ts ?? (ev as Timed).ts ?? Date.now() }) as unknown as AgentEvent;
  if (nativeTypes.has(ev.type)) return [stamp(ev as AgentEvent)];
  const mapped = piEventToAgentEvent(ev as PiEvent);
  const result = mapped ? [stamp(mapped)] : [];
  const message = (ev as PiEvent).message as {
    role?: string; timestamp?: number; stopReason?: string; errorMessage?: string;
    content?: { type?: string; thinking?: string }[];
  } | undefined;
  if (message?.role === "assistant") {
    const thinking = (message.content ?? []).filter((c) => c.type === "thinking").map((c) => c.thinking ?? "").join("");
    if (thinking) result.unshift(stamp({
      type: "thinking", text: thinking,
      streamId: String(message.timestamp ?? "thinking"),
      streaming: ev.type === "message_update",
    }));
    if (ev.type === "message_end" && message.stopReason === "error" && message.errorMessage && mapped?.type !== "error") {
      result.push(stamp(errorEvent(message.errorMessage)));
    }
  }
  return result;
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
  /** 会话根任务 id：接力/续接轮次继承（跨 harness 归同一会话） */
  conversation_id: string | null;
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
  model?: string | null;
  permission?: string | null;
  projectId?: string | null;
  events: { event: AgentEvent; key: number }[];
  running: boolean;
  status?: TaskRow["status"];
  exitCode: number | null;
  sessionId?: string;
  /** 运行中排队的后续消息（任务结束自动续发） */
  queued?: string[];
  /** deck 运行时的 todo 清单（todo_write 工具维护） */
  todos?: { content: string; status: string }[];
};
