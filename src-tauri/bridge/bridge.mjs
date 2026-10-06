#!/usr/bin/env node
/**
 * AgentDeck Bridge — 零依赖 MCP stdio server
 *
 * 给任意 MCP 客户端（Codex、ZCode 等）提供跨 harness 委派工具：
 *   - zcode_task({ prompt, cwd?, mode? })
 *   - codex_task({ prompt, cwd? })
 *
 * 协议：newline-delimited JSON-RPC（MCP 2024-11-05 stdio）。
 * 返回给调用方的是 LLM 友好的纯文本结论（最终回复 + 状态 + 会话 ID），
 * 内部细节（JSONL 事件流）在此处消化掉。
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SERVER_INFO = { name: "agent-deck-bridge", version: "0.1.0" };
const TASK_TIMEOUT_MS = 15 * 60 * 1000;

const TOOLS = [
  {
    name: "zcode_task",
    description:
      "把一个编码任务委派给 ZCode（GLM）无头执行，阻塞直到完成，返回最终结论。适合把实现类子任务外包给 GLM。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "任务描述，需自包含（对方看不到当前上下文）" },
        cwd: { type: "string", description: "工作目录（绝对路径）" },
        mode: { type: "string", enum: ["yolo", "build", "edit", "plan"] },
      },
      required: ["prompt"],
    },
  },
  {
    name: "codex_task",
    description:
      "把一个编码任务委派给 Codex（GPT）无头执行，阻塞直到完成，返回最终结论。适合把推理/算法类子任务外包给 GPT。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "任务描述，需自包含" },
        cwd: { type: "string", description: "工作目录（绝对路径）" },
      },
      required: ["prompt"],
    },
  },
];

// ── harness 命令拼装 ──────────────────────────────────────────

function buildTask(harness, { prompt, cwd, mode }) {
  if (harness === "zcode") {
    const m = ["yolo", "build", "edit", "plan"].includes(mode) ? mode : "yolo";
    return {
      program: "zcode",
      args: ["--json", "--mode", m, "-p", prompt],
      label: "ZCode",
    };
  }
  return {
    program: "codex",
    args: ["exec", "--json", "--skip-git-repo-check", prompt],
    label: "Codex",
  };
}

/** Windows 上 npm CLI 是 .cmd 垫片，必须经 cmd /C 启动；命令串手工转义 */
function launch(program, args, cwd) {
  const options = {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
    windowsHide: true,
  };
  if (cwd) options.cwd = cwd;

  if (process.platform === "win32") {
    const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const line = [program, ...args].map(q).join(" ");
    return spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(program, args, options);
}

// ── 防御式事件解析（与 AgentDeck 主程序同一套语义） ────────────

function extractSessionId(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractSessionId(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of ["session_id", "sessionId", "thread_id"]) {
      if (typeof value[key] === "string") return value[key];
    }
    for (const v of Object.values(value)) {
      const found = extractSessionId(v);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "string" && (value.startsWith("sess_") || value.startsWith("thread_"))) {
    return value;
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return null;
}

function parseLine(line, acc) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    acc.raw.push(line);
    return;
  }
  const sessionId = extractSessionId(value);
  if (sessionId) acc.sessionId = sessionId;

  const kind = value.kind ?? value.type;
  const inner = value.message ?? value;
  const role = inner?.role ?? value.role;

  if (kind === "assistant" || kind === "assistant_message" || (kind === "message" && role === "assistant")) {
    const text = textOf(inner?.content ?? value.content);
    if (text?.trim()) acc.finalText = text;
  }
  if (kind === "item.completed" && inner?.item?.type === "agent_message") {
    if (inner.item.text) acc.finalText = inner.item.text;
  }
  if (kind === "error" || kind === "turn.failed") {
    const msg = value.message ?? value.error?.message ?? "unknown error";
    acc.errors.push(msg);
  }
  if ((kind === "complete" || kind === "result") && (value.ok === false || value.is_error === true)) {
    acc.errors.push(value.error?.message ?? "执行失败");
  }
}

// ── 执行一次委派任务 ──────────────────────────────────────────

function runTask(harness, args) {
  return new Promise((resolve) => {
    if (!args?.prompt || !String(args.prompt).trim()) {
      resolve({ ok: false, text: "参数错误：prompt 不能为空" });
      return;
    }
    const { program, args: cliArgs, label } = buildTask(harness, args);
    const acc = { sessionId: null, finalText: null, errors: [], raw: [] };

    let child;
    try {
      child = launch(program, cliArgs, args.cwd);
    } catch (err) {
      resolve({ ok: false, text: `启动 ${label} 失败：${err.message}` });
      return;
    }

    const timer = setTimeout(() => {
      acc.errors.push(`任务超时（${TASK_TIMEOUT_MS / 60000} 分钟），已终止`);
      child.kill();
    }, TASK_TIMEOUT_MS);

    let stderrTail = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) parseLine(trimmed, acc);
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      stderrTail = (line.trim() + "\n" + stderrTail).slice(0, 2000);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `启动 ${label} 失败：${err.message}（CLI 是否已安装并在 PATH？）` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const failed = code !== 0 || acc.errors.length > 0;
      const parts = [`【${label} 任务${failed ? "失败" : "完成"}】`];
      if (acc.errors.length) parts.push(`错误：${[...new Set(acc.errors)].join("；")}`);
      else if (code !== 0 && stderrTail.trim()) parts.push(`stderr 尾部：${stderrTail.trim()}`);
      if (acc.finalText) parts.push(`最终回复：\n${acc.finalText}`);
      else if (acc.raw.length) parts.push(`原始输出尾部：\n${acc.raw.slice(-5).join("\n")}`);
      else if (!failed) parts.push("（无文本输出）");
      if (acc.sessionId) parts.push(`（会话：${acc.sessionId}）`);
      resolve({ ok: !failed, text: parts.join("\n\n") });
    });
  });
}

// ── MCP stdio 协议（newline-delimited JSON-RPC） ───────────────

function handleMessage(msg) {
  const { id, method, params } = msg;
  const respond = (result, error) => {
    if (id === undefined || id === null) return;
    const resp = { jsonrpc: "2.0", id };
    if (error) resp.error = error;
    else resp.result = result;
    process.stdout.write(JSON.stringify(resp) + "\n");
  };

  switch (method) {
    case "initialize":
      respond({
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "tools/list":
      respond({ tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      if (!["zcode_task", "codex_task"].includes(name)) {
        respond(undefined, { code: -32602, message: `unknown tool: ${name}` });
        return;
      }
      const harness = name === "zcode_task" ? "zcode" : "codex";
      runTask(harness, params?.arguments ?? {}).then(({ ok, text }) => {
        respond({ content: [{ type: "text", text }], isError: !ok });
      });
      return;
    }
    case "ping":
      respond({});
      return;
    default:
      if (id !== undefined && id !== null) {
        respond(undefined, { code: -32601, message: `method not found: ${method}` });
      }
  }
}

// stdin 停止供给后（宿主关闭），等在途任务收尾再退出
let pending = 0;
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.method === "tools/call") {
    pending++;
    const { id, params } = msg;
    const name = params?.name;
    const finish = (result, error) => {
      const resp = { jsonrpc: "2.0", id };
      if (error) resp.error = error;
      else resp.result = result;
      process.stdout.write(JSON.stringify(resp) + "\n");
      pending--;
    };
    if (!["zcode_task", "codex_task"].includes(name)) {
      finish(undefined, { code: -32602, message: `unknown tool: ${name}` });
      return;
    }
    const harness = name === "zcode_task" ? "zcode" : "codex";
    runTask(harness, params?.arguments ?? {}).then(({ ok, text }) => {
      finish({ content: [{ type: "text", text }], isError: !ok });
    });
    return;
  }
  handleMessage(msg);
});
process.stdin.on("end", () => {
  const check = setInterval(() => {
    if (pending <= 0) {
      clearInterval(check);
      process.exit(0);
    }
  }, 200);
});
