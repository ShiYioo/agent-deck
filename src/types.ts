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

/** 与 Rust 侧 store::TaskRow 对应（snake_case 透传） */
export type TaskRow = {
  id: string;
  harness: string;
  cwd: string;
  prompt: string;
  mode: string | null;
  session_id: string | null;
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
};
