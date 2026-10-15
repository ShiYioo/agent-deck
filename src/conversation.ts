import type { AgentEvent } from "./types";

/** 对话流归约：事件流（追加式）→ 语义行（upsert）。
 *  移植 ZCode 的 Message{parts} 思想：工具按调用配对就地收口，重复 emission
 *  在结构上不可能产生重复行；重试合并、耗时标注在归约时一次完成，
 *  渲染层只做行的纯函数投影。 */

export type ToolStatus = "running" | "completed" | "failed";

export type ConversationRow =
  | { kind: "user"; key: number; text: string; hidden: boolean; sourceHarness?: string }
  | { kind: "assistant"; key: number; text: string; sourceHarness?: string }
  | { kind: "thought"; key: number; text: string; durationMs?: number }
  | {
      kind: "tool";
      key: number;
      tool: string;
      status: ToolStatus;
      /** 工具入参投影（命令/问题文本/路径等） */
      detail?: string;
      /** 工具输出（tool_result.detail） */
      output?: string;
      args?: Record<string, unknown>;
      isCommand: boolean;
      isQuestion: boolean;
    }
  | { kind: "status"; key: number; text: string; retryKey?: string | null; compacting?: boolean }
  | {
      kind: "complete";
      key: number;
      ok: boolean;
      durationMs?: number;
      tokens?: { input: number; output: number; reasoning?: number; cached?: number };
    }
  | { kind: "error"; key: number; message: string }
  | { kind: "raw"; key: number; line: string };

/** 命令类工具：输入输出必须直接可见（v2 的 bash 工具名叫 shell） */
const COMMAND_TOOL = /bash|shell|exec|terminal|command|cmd|powershell/i;

type ToolRow = Extract<ConversationRow, { kind: "tool" }>;

function isCommandTool(tool: string): boolean {
  return COMMAND_TOOL.test(tool);
}

/** 事件流 → 行。入参保持 {event, key} 形状（live 流与 DB 回放同构）。 */
export function buildConversation(items: { event: AgentEvent; key: number }[]): ConversationRow[] {
  const rows: ConversationRow[] = [];
  // 进行中的工具调用：tool → 行下标（tool_result 就地收口；无 id 的流按工具名配对）
  const openByTool = new Map<string, number>();
  let prevTs: number | null = null;
  let turnStart: number | null = null;

  for (const { event, key } of items) {
    const ev = event as AgentEvent & { ts?: number; durationMs?: number };
    switch (ev.type) {
      case "user_message":
        if (!ev.hidden && ev.ts) turnStart = ev.ts;
        rows.push({ kind: "user", key, text: ev.text, hidden: !!ev.hidden, sourceHarness: ev.sourceHarness });
        break;
      case "assistant_message":
        rows.push({ kind: "assistant", key, text: ev.text, sourceHarness: ev.sourceHarness });
        break;
      case "thinking": {
        // 思考块耗时 = 上一事件到达 → 本块到达（ts 由入库统一打点）
        let durationMs: number | undefined;
        if (ev.ts && prevTs !== null && ev.ts > prevTs) durationMs = ev.ts - prevTs;
        rows.push({ kind: "thought", key, text: ev.text, durationMs });
        break;
      }
      case "tool_use": {
        const isQuestion = !!ev.args?.questions;
        const args = ev.args;
        const isCommand = !isQuestion && (isCommandTool(ev.tool) || typeof args?.command === "string");
        const row: ToolRow = {
          kind: "tool", key, tool: ev.tool, status: "running",
          detail: ev.detail || undefined, args, isCommand, isQuestion,
        };
        rows.push(row);
        openByTool.set(ev.tool, rows.length - 1);
        break;
      }
      case "tool_result": {
        const openIndex = openByTool.get(ev.tool);
        if (openIndex !== undefined && rows[openIndex]?.kind === "tool") {
          const row = rows[openIndex] as ToolRow;
          row.status = ev.ok ? "completed" : "failed";
          row.output = ev.detail;
          openByTool.delete(ev.tool);
        } else {
          // 无前置 tool_use（CLI 平铺/回放缺事件）：合成完整行
          rows.push({
            kind: "tool", key, tool: ev.tool,
            status: ev.ok ? "completed" : "failed",
            output: ev.detail,
            isCommand: isCommandTool(ev.tool),
            isQuestion: false,
          });
        }
        break;
      }
      case "status": {
        // 连续同因重试合并：保留最新计数，key 复用首条
        const prev = rows[rows.length - 1];
        if (
          ev.retryKey
          && prev?.kind === "status"
          && prev.retryKey === ev.retryKey
        ) {
          rows[rows.length - 1] = {
            kind: "status", key: prev.key, text: ev.text,
            retryKey: ev.retryKey, compacting: ev.compacting,
          };
        } else {
          rows.push({ kind: "status", key, text: ev.text, retryKey: ev.retryKey ?? null, compacting: ev.compacting });
        }
        break;
      }
      case "complete":
        if (turnStart !== null && ev.ts && ev.ts > turnStart) {
          (ev as { durationMs?: number }).durationMs = ev.ts - turnStart;
        }
        turnStart = null;
        rows.push({
          kind: "complete", key, ok: ev.ok,
          durationMs: ev.durationMs, tokens: ev.tokens,
        });
        break;
      case "error":
        rows.push({ kind: "error", key, message: ev.message });
        break;
      case "raw":
        rows.push({ kind: "raw", key, line: ev.line });
        break;
      default:
        break; // session_id 等簿记事件不入流
    }
    if (ev.ts) prevTs = ev.ts;
  }
  return claimLocalCompact(rows);
}

/** 乐观占位认领：/compact 发出时本地先插一条「已请求压缩上下文…」占位行；
 *  一旦其后出现真实压缩状态（compacting 字段）或任务终态，占位即被认领移除——
 *  与 ZCode 的 local-compact-N 同语义，但用纯函数规则而非状态跟踪。 */
function claimLocalCompact(rows: ConversationRow[]): ConversationRow[] {
  let localIndex = -1;
  let claimIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (localIndex === -1 && row.kind === "status" && row.retryKey === "local-compact") {
      localIndex = i;
    } else if (
      localIndex !== -1
      && i > localIndex
      && (row.kind === "complete"
        || (row.kind === "status" && row.retryKey !== "local-compact" && row.compacting !== undefined)
        || row.kind === "error")
    ) {
      claimIndex = i;
      break;
    }
  }
  if (localIndex === -1 || claimIndex === -1) return rows;
  return rows.filter((_, i) => i !== localIndex);
}

/** 视图层折叠：连续的已完成/失败非命令工具行 + 思考收成「工具操作 ×N」摘要；
 *  命令类、提问、进行中的行永不折叠。紧邻 assistant 的尾部思考保持在外。 */
export type ToolSegment = {
  kind: "segment";
  rows: ToolRow[];
  thoughts: ConversationRow[];
  uses: { tool: string; n: number; targets: number | null }[];
  failed: boolean;
};
export type DisplayRow =
  | { kind: "single"; row: ConversationRow }
  | ToolSegment;

const TOOL_RUN_MIN = 2;

function foldable(row: ConversationRow): boolean {
  return row.kind === "thought"
    || (row.kind === "tool" && !row.isCommand && !row.isQuestion && row.status !== "running");
}

function rowTargets(row: ToolRow): string | null {
  const a = row.args ?? {};
  if (typeof a.path === "string") return a.path;
  if (typeof a.file_path === "string") return a.file_path;
  if (typeof a.pattern === "string") return `搜索 ${typeof a.path === "string" ? `${a.path}/` : ""}${a.pattern}`;
  return null;
}

export function foldToolRows(rows: ConversationRow[]): DisplayRow[] {
  const out: DisplayRow[] = [];
  let seg: ConversationRow[] = [];
  const flush = (keepTrailingThought: boolean) => {
    if (seg.length === 0) return;
    let tail: ConversationRow[] = [];
    if (keepTrailingThought) {
      while (seg.length > 0 && seg[seg.length - 1].kind === "thought") {
        tail.unshift(seg.pop() as ConversationRow);
      }
    }
    const tools = seg.filter((r): r is ToolRow => r.kind === "tool");
    const uses = new Map<string, number>();
    const files = new Map<string, Set<string>>();
    let failed = false;
    for (const row of tools) {
      uses.set(row.tool, (uses.get(row.tool) ?? 0) + 1);
      const target = rowTargets(row);
      if (target) {
        const set = files.get(row.tool) ?? new Set<string>();
        set.add(target);
        files.set(row.tool, set);
      }
      if (row.status === "failed") failed = true;
    }
    if (tools.length >= TOOL_RUN_MIN) {
      out.push({
        kind: "segment", rows: tools, thoughts: tail,
        uses: [...uses.entries()].map(([tool, n]) => {
          const targets = files.get(tool);
          return { tool, n, targets: targets ? targets.size : null };
        }),
        failed,
      });
    } else {
      for (const row of seg) out.push({ kind: "single", row });
    }
    for (const row of tail) out.push({ kind: "single", row });
    seg = [];
  };
  for (const row of rows) {
    if (foldable(row)) {
      seg.push(row);
    } else {
      flush(row.kind === "assistant");
      out.push({ kind: "single", row });
    }
  }
  flush(false);
  return out;
}
