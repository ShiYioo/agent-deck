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

import {
  createAgentSession,
  createCodingTools,
  createReadTool as m_createReadTool,
  createWriteTool as m_createWriteTool,
  createEditTool as m_createEditTool,
  createBashTool as m_createBashTool,
  createGrepTool as m_createGrepTool,
  createFindTool as m_createFindTool,
  createLsTool as m_createLsTool,
} from "@earendil-works/pi-coding-agent";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

let session = null;
let currentModel = null; // 当前底层模型名（glm/gpt）
let pendingApproval = null; // { resolve, info: {id, tool, args} }
let currentCwd = null;
let firstRun = true;

// 模型自治：双池 key/url（设置面板写入，随 run/summarize 指令下发）
const modelKeys = { glm: null, gpt: null };
const modelUrls = { glm: null, gpt: null };

/** 通用级运行规范（会话首轮注入，全局纪律只说一次） */
const UNIVERSAL_PROMPT = [
  "【运行规范 · AgentDeck】",
  "你是在用户本机工作的编码智能体，直接操作真实文件系统。纪律：",
  "1) 先理解再动手：改动前先读相关文件；不确定就 ls/grep 查证，不猜接口。",
  "2) 计划先行：超过 3 步的任务先给出极简计划，再逐步执行。",
  "3) 小步修改 + 即时验证：每次改动后运行编译/测试/脚本自证；验证不过就修，不许留红。",
  "4) 诚实汇报：失败如实报告并附错误原文；绝不伪造成功。",
  "5) 中文沟通，结论先行，关键路径与命令原样给出。",
].join("\n");

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

/** 模型自治工具：agent 自己切换底层模型（setModel 保留会话上下文） */
const SWITCH_MODEL_TOOL = {
  name: "switch_model",
  description:
    "切换你自己（deck 运行时）的底层模型：glm（GLM）或 gpt（GPT）。当前模型额度不足、任务更适合另一家时使用。切换保留当前会话上下文。",
  parameters: {
    type: "object",
    properties: {
      model: { type: "string", enum: ["glm", "gpt"], description: "目标模型" },
    },
    required: ["model"],
  },
  execute: async (_id, args) => {
    const target = String(args?.model ?? "").toLowerCase();
    if (!["glm", "gpt"].includes(target) || !modelKeys[target]) {
      return {
        content: [{ type: "text", text: `未配置 ${target} 的 API Key，无法切换` }],
        isError: true,
      };
    }
    try {
      if (!session) throw new Error("会话未建立");
      await session.setModel(resolveModel(target));
      currentModel = JSON.stringify([target, currentCwd, "auto"]);
      return {
        content: [{ type: "text", text: `已切换到底层模型 ${target}，会话上下文保留` }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: "切换失败：" + String(e?.message ?? e) }],
        isError: true,
      };
    }
  },
};

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

function resolveModel(name) {
  // pi-ai 的 Model 对象最小面：provider/id/apiKey/baseURL
  if (name === "glm") {
    return {
      provider: "zai",
      id: "glm-4.7",
      apiKey: modelKeys.glm,
      // Z.ai coding-plan key 配套的 OpenAI 兼容端点
      baseUrl: modelUrls.glm || process.env.ZAI_BASE_URL || "https://api.z.ai/api/coding/paas/v4",
    };
  }
  return {
    provider: "openai",
    id: "gpt-5.1",
    apiKey: modelKeys.gpt,
    baseUrl: modelUrls.gpt || process.env.OPENAI_BASE_URL,
  };
}

/** 模型自治链：按可用 key 顺序降级（glm 优先） */
function modelChain() {
  const chain = [];
  if (modelKeys.glm) chain.push("glm");
  if (modelKeys.gpt) chain.push("gpt");
  return chain;
}

// ── 会话生命周期 ─────────────────────────────────────────────

/** deck 自持工具集（抄 OpenCode 工具形态）：读/写/改/命令/搜索/定位/列表 */
function buildTools(mode) {
  const factories = [
    m_createReadTool,
    m_createWriteTool,
    m_createEditTool,
    m_createBashTool,
    m_createGrepTool,
    m_createFindTool,
    m_createLsTool,
  ];
  let tools = [];
  for (const f of factories) {
    try {
      const t = f?.();
      if (t) tools.push(t);
    } catch {
      /* 逐个容错 */
    }
  }
  if (tools.length === 0) tools = [...createCodingTools()];
  // 委派工具：互调是 deck 运行时的一等能力；switch_model：模型自治
  tools = [...tools, ...DELEGATE_TOOLS, SWITCH_MODEL_TOOL];
  // 权限门：approved 模式下全部工具（含委派）执行前经 UI 审批
  return mode === "approved" ? tools.map(wrapWithGate) : tools;
}

async function ensureSessionFor(name, { cwd, mode }) {
  const resolved = resolveModel(name);
  if (!resolved.apiKey) {
    throw new Error(`未配置 ${name === "glm" ? "GLM" : "GPT"} 的 API Key（设置面板）`);
  }
  const want = JSON.stringify([name, cwd, mode]);
  if (session && currentModel === want) return session;

  if (session) {
    try {
      await session.dispose?.();
    } catch {}
    session = null;
  }

  currentCwd = cwd || process.cwd();
  session = await createAgentSession({
    cwd: currentCwd,
    model: resolved,
    customTools: buildTools(mode),
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
      // 同步双池 key/url
      modelKeys.glm = msg.apiKeyGlm || null;
      modelKeys.gpt = msg.apiKeyGpt || null;
      modelUrls.glm = msg.baseUrlGlm || null;
      modelUrls.gpt = msg.baseUrlGpt || null;

      const chain = modelChain();
      if (chain.length === 0) {
        deckEvent("error", {
          message: "未配置任何模型 Key——请到设置面板填写 GLM/GPT 的 API Key",
        });
        break;
      }

      // 模型自治：主模型失败（额度/认证/网络）自动降级到链中下一个
      let lastErr = null;
      let succeeded = false;
      for (let i = 0; i < chain.length; i++) {
        const name = chain[i];
        try {
          const s = await ensureSessionFor(name, {
            cwd: msg.cwd,
            mode: msg.mode === "approved" ? "approved" : "auto",
          });
          deckEvent("run_start", { model: name });
          // 通用级运行规范：仅会话首轮注入（纪律只说一次）
          const promptText = firstRun
            ? UNIVERSAL_PROMPT + "\n\n==== 任务 ====\n" + msg.prompt
            : msg.prompt;
          await s.prompt(promptText);
          firstRun = false;
          succeeded = true;
          deckEvent("run_end");
          break;
        } catch (err) {
          lastErr = err;
          const reason = String(err?.message ?? err).slice(0, 160);
          deckEvent("status", { text: `${name} 执行失败：${reason}` });
          if (i < chain.length - 1) {
            deckEvent("status", { text: `自动切换到 ${chain[i + 1]} 继续` });
          }
        }
      }
      if (!succeeded && lastErr) {
        deckEvent("error", {
          message: `所有已配置模型均失败：${String(lastErr?.message ?? lastErr)}`,
        });
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
        modelKeys.glm = msg.apiKeyGlm || null;
        modelKeys.gpt = msg.apiKeyGpt || null;
        modelUrls.glm = msg.baseUrlGlm || null;
        modelUrls.gpt = msg.baseUrlGpt || null;
        const chain = modelChain();
        if (chain.length === 0) throw new Error("未配置任何模型 Key（设置面板）");
        const s = await ensureSessionFor(chain[0], {
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
