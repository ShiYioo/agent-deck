#!/usr/bin/env node
/**
 * deck-agent — AgentDeck 的统一 agent 运行时（pi 二次开发）
 *
 * 以库形态使用 @earendil-works/pi-coding-agent：
 *   pi agent loop + pi-ai 统一 LLM API → 一条结构化事件流
 *
 * 协议（newline-delimited JSON over stdio）：
 *   stdin  指令：{ "cmd": "run",    "prompt": "...", "model": "glm|gpt", "cwd": "...",
 *                  "apiKey": "...", "mode": "auto|approved" }
 *               { "cmd": "approve", "id": "<toolCallId>" }
 *               { "cmd": "abort" }
 *   stdout 事件：pi AgentEvent 原样透传 + deck 事件（{type:"deck_*"...}）
 *
 * 权限门：mode=approved 时，工具执行前发 {type:"deck_approval_request"} 并暂停，
 * 收到 approve 后继续（AgentDeck UI 呈现审批卡片）。
 */

import { createAgentSession, createCodingTools } from "@earendil-works/pi-coding-agent";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

let session = null;
let currentModel = null;
let pendingApproval = null; // { resolve, info: {id, tool, args} }
let currentCwd = null;
let currentApiKey = null;
let currentModeName = null;

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function deckEvent(type, extra = {}) {
  emit({ type: `deck_${type}`, ...extra });
}

// ── 委派工具：pi agent 原生调用 zcode/codex CLI（互调语义） ────────

function runHeadless(program, args, cwd, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const options = {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
    };
    if (cwd) options.cwd = cwd;

    let child;
    if (process.platform === "win32") {
      const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      const line = [program, ...args].map(q).join(" ");
      child = spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
        ...options,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(program, args, options);
    }

    let out = "";
    let errTail = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, out, errTail: `委派超时（${timeoutMs / 60000} 分钟）` });
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (errTail = (d.toString() + errTail).slice(0, 1500)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, errTail: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, errTail });
    });
  });
}

/** 从无头 CLI 的 JSONL 输出提取最终回复（与主程序解析语义一致） */
function extractFinalText(raw) {
  let text = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const v = JSON.parse(trimmed);
      const kind = v.kind ?? v.type;
      const inner = v.message ?? v;
      if (kind === "assistant" || kind === "assistant_message") {
        const c = inner?.content ?? v.content;
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) {
          const t = c.filter((b) => b?.type === "text").map((b) => b.text).join("");
          if (t) text = t;
        }
      }
      if (kind === "item.completed" && inner?.item?.type === "agent_message" && inner.item.text) {
        text = inner.item.text;
      }
    } catch {}
  }
  return text;
}

const DELEGATE_TOOLS = [
  {
    name: "delegate_to_zcode",
    label: "委派给 ZCode (GLM)",
    description:
      "把一个自包含的编码子任务委派给 ZCode（GLM）无头执行，阻塞直到完成并返回最终结论。适合实现类子任务。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "任务描述，必须自包含（对方看不到当前对话）" },
        cwd: { type: "string", description: "工作目录，默认当前项目目录" },
      },
      required: ["prompt"],
    },
    execute: async (_id, args) => {
      const r = await runHeadless(
        "zcode",
        ["--json", "--mode", "yolo", "-p", String(args?.prompt ?? "")],
        args?.cwd || currentCwd,
      );
      const text = extractFinalText(r.out);
      const ok = r.code === 0 && !/invalid token|unauthorized/i.test(r.errTail);
      const parts = [ok ? "【ZCode 完成】" : "【ZCode 失败】"];
      if (!ok && r.errTail.trim()) parts.push(r.errTail.trim());
      if (text) parts.push(text);
      else if (ok && !text) parts.push("（无文本输出）");
      return { content: [{ type: "text", text: parts.join("\n\n") }], isError: !ok };
    },
  },
  {
    name: "delegate_to_codex",
    label: "委派给 Codex (GPT)",
    description:
      "把一个自包含的编码子任务委派给 Codex（GPT）无头执行，阻塞直到完成并返回最终结论。适合推理/算法类子任务。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "任务描述，必须自包含" },
        cwd: { type: "string", description: "工作目录，默认当前项目目录" },
      },
      required: ["prompt"],
    },
    execute: async (_id, args) => {
      const r = await runHeadless(
        "codex",
        ["exec", "--json", "--skip-git-repo-check", String(args?.prompt ?? "")],
        args?.cwd || currentCwd,
      );
      const text = extractFinalText(r.out);
      const ok = r.code === 0;
      const parts = [ok ? "【Codex 完成】" : "【Codex 失败】"];
      if (!ok && r.errTail.trim()) parts.push(r.errTail.trim());
      if (text) parts.push(text);
      else if (ok && !text) parts.push("（无文本输出）");
      return { content: [{ type: "text", text: parts.join("\n\n") }], isError: !ok };
    },
  },
];

// ── 模型解析：GLM / GPT（pi-ai ModelRegistry 风格的内置目录） ──────

function resolveModel(name, apiKey, baseUrl) {
  // pi-ai 的 Model 对象最小面：provider/id/apiKey/baseURL
  if (name === "glm") {
    return {
      provider: "zai",
      id: "glm-4.7",
      apiKey,
      // Z.ai coding-plan key 配套的 OpenAI 兼容端点
      baseUrl: baseUrl || process.env.ZAI_BASE_URL || "https://api.z.ai/api/coding/paas/v4",
    };
  }
  return {
    provider: "openai",
    id: "gpt-5.1",
    apiKey,
    baseUrl: baseUrl || process.env.OPENAI_BASE_URL,
  };
}

// ── 会话生命周期 ─────────────────────────────────────────────

async function ensureSession({ model, apiKey, baseUrl, cwd, mode }) {
  const want = JSON.stringify([model, Boolean(apiKey), baseUrl, cwd, mode]);
  if (session && currentModel === want) return session;

  const resolved = resolveModel(model, apiKey, baseUrl);
  if (!resolved.apiKey) {
    throw new Error(
      `缺少 ${model === "glm" ? "ZAI_API_KEY" : "OPENAI_API_KEY"}（指令里带 apiKey 或环境变量均可）`,
    );
  }

  if (session) {
    try { await session.dispose?.(); } catch {}
    session = null;
  }

  currentCwd = cwd || process.cwd();
  const builtin = createCodingTools();
  const gated = mode === "approved" ? builtin.map(wrapWithGate) : builtin;
  session = await createAgentSession({
    cwd: currentCwd,
    model: resolved,
    // 委派工具始终注册（互调是 deck 运行时的一等能力）；
    // approved 模式下委派工具同样过权限门
    customTools: [
      ...gated,
      ...(mode === "approved"
        ? DELEGATE_TOOLS.map(wrapWithGate)
        : DELEGATE_TOOLS),
    ],
    noTools: undefined,
  });
  currentModel = want;
  session.subscribe((event) => {
    // pi 结构化事件原样透传（含 message_* / tool_execution_* / agent_*）
    emit(event);
  });
  return session;
}

/** 工具包装：执行前发审批请求（带工具名与参数），等 stdin 的 approve/reject */
function wrapWithGate(tool) {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const id = toolCallId || randomUUID();
      const approved = await new Promise((resolve) => {
        pendingApproval = {
          resolve,
          info: { id, tool: tool.name ?? "tool", args },
        };
        emit({
          type: "deck_approval_request",
          id,
          tool: tool.name ?? "tool",
          args,
        });
      });
      pendingApproval = null;
      if (!approved) {
        return {
          content: [{ type: "text", text: "用户拒绝执行该工具。" }],
          isError: true,
        };
      }
      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

// ── 指令处理 ─────────────────────────────────────────────────

async function handle(msg) {
  switch (msg.cmd) {
    case "run": {
      try {
        const s = await ensureSession(msg);
        deckEvent("run_start", { model: msg.model });
        await s.prompt(msg.prompt);
        deckEvent("run_end");
      } catch (err) {
        deckEvent("error", { message: String(err?.message ?? err) });
      }
      break;
    }
    case "approve": {
      if (pendingApproval?.resolve) {
        deckEvent("approval_decided", { id: msg.id, approved: true });
        pendingApproval.resolve(true);
      }
      break;
    }
    case "reject": {
      if (pendingApproval?.resolve) {
        deckEvent("approval_decided", { id: msg.id, approved: false });
        pendingApproval.resolve(false);
      }
      break;
    }
    case "abort": {
      aborting = true;
      try { await session?.abort?.(); } catch {}
      aborting = false;
      break;
    }
    case "summarize": {
      // 会话压缩：把交接记录压成结构化简报（AI 交接的核心步骤）
      try {
        const s = await ensureSession({
          model: msg.model || "glm",
          apiKey: msg.apiKey,
          baseUrl: msg.baseUrl,
          cwd: msg.cwd || process.cwd(),
          mode: "auto",
        });
        let last = "";
        let active = true;
        const un = s.subscribe((ev) => {
          if (!active) return;
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            const text = (ev.message.content ?? [])
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("");
            if (text.trim()) last = text;
          }
        });
        deckEvent("summarize_start");
        await s.prompt(
          "你是一个会话压缩器。把下面的编码任务会话记录压缩成给下一个 AI 助手的交接简报，" +
            "严格按此结构输出（Markdown）：\n" +
            "## 任务\n（原始目标，1-2 句）\n## 已完成\n（带具体文件路径/命令的完成项）\n" +
            "## 未完成\n（剩余工作，按优先级）\n## 关键决策与注意事项\n（约定、坑、参数）\n\n" +
            "要求：只输出简报本身，不要执行任务；保留具体路径、命令名、参数；总长不超过 500 字。\n\n" +
            "===== 会话记录 =====\n" +
            String(msg.text ?? ""),
        );
        active = false;
        un();
        deckEvent("summarize_result", { text: last });
      } catch (err) {
        deckEvent("summarize_error", { message: String(err?.message ?? err) });
      }
      break;
    }
    case "ping":
      deckEvent("pong");
      break;
    default:
      deckEvent("error", { message: `unknown cmd: ${msg.cmd}` });
  }
}

// ── stdio 协议循环 ───────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    deckEvent("error", { message: "无法解析的指令行" });
    return;
  }
  Promise.resolve(handle(msg)).catch((err) =>
    deckEvent("error", { message: String(err?.message ?? err) }),
  );
});
process.stdin.on("end", () => process.exit(0));
