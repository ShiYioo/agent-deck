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

let session = null;
let currentModel = null;
let pendingApproval = null; // { id, resolve }
let aborting = false;

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function deckEvent(type, extra = {}) {
  emit({ type: `deck_${type}`, ...extra });
}

// ── 模型解析：GLM / GPT（pi-ai ModelRegistry 风格的内置目录） ──────

function resolveModel(name, apiKey) {
  // pi-ai 的 Model 对象最小面：provider/id/apiKey/baseURL
  if (name === "glm") {
    return {
      provider: "zai",
      id: "glm-4.7",
      apiKey,
      baseUrl: process.env.ZAI_BASE_URL || "https://api.z.ai/api/paas/v4",
    };
  }
  return {
    provider: "openai",
    id: "gpt-5.1",
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL,
  };
}

// ── 会话生命周期 ─────────────────────────────────────────────

async function ensureSession({ model, apiKey, cwd, mode }) {
  const want = JSON.stringify([model, Boolean(apiKey), cwd, mode]);
  if (session && currentModel === want) return session;

  const resolved = resolveModel(model, apiKey);
  if (!resolved.apiKey) {
    throw new Error(
      `缺少 ${model === "glm" ? "ZAI_API_KEY" : "OPENAI_API_KEY"}（指令里带 apiKey 或环境变量均可）`,
    );
  }

  if (session) {
    try { await session.dispose?.(); } catch {}
    session = null;
  }

  const tools = createCodingTools();
  session = await createAgentSession({
    cwd: cwd || process.cwd(),
    model: resolved,
    // 权限门在 approved 模式下由 deck_approval 流程接管
    customTools: mode === "approved" ? tools.map(wrapWithGate) : tools,
    noTools: undefined,
  });
  currentModel = want;
  session.subscribe((event) => {
    // pi 结构化事件原样透传（含 message_* / tool_execution_* / agent_*）
    emit(event);
  });
  return session;
}

/** 工具包装：执行前发审批请求，等 stdin 的 approve/abort */
function wrapWithGate(tool) {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const id = toolCallId || randomUUID();
      pendingApproval = { id, resolve: null };
      const approved = await new Promise((resolve) => {
        pendingApproval.resolve = resolve;
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
