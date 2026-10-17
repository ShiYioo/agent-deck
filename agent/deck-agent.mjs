#!/usr/bin/env node
/**
 * deck-agent — AgentDeck 的统一 agent 运行时（pi 二次开发）
 *
 * 以库形态使用 @earendil-works/pi-coding-agent：
 *   pi agent loop + pi-ai 统一 LLM API → 一条结构化事件流
 *
 * 协议（newline-delimited JSON over stdio）：
 *   stdin  指令：{ "cmd": "run", "prompt": "...", "profiles": [{provider,key,baseUrl}...],
 *                  "cwd": "...", "mode": "auto|approved" }
 *               { "cmd": "summarize", "text": "...", "profiles": [...] }
 *               { "cmd": "approve" | "reject", "id": "<toolCallId>" }
 *               { "cmd": "abort" }
 *   stdout 事件：pi AgentEvent 原样透传 + deck_* 控制事件
 *
 * 模型自治：profiles 按启用顺序构成降级链（主模型失败自动换下一个）；
 * switch_model 原生工具让 agent 自己切模型（session.setModel，上下文保留）。
 */

import {
  createAgentSession,
  createCodingTools,
  ModelRuntime,
  SessionManager,
  createReadTool as m_createReadTool,
  createWriteTool as m_createWriteTool,
  createEditTool as m_createEditTool,
  createBashTool as m_createBashTool,
  createPowerShellTool as m_createPowerShellTool,
  getShellConfig,
  createGrepTool as m_createGrepTool,
  createFindTool as m_createFindTool,
  createLsTool as m_createLsTool,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { normalizeWorkflowPlan } from "./workflow-plan.mjs";

let session = null;
let currentModel = null; // 当前底层 provider（glm/gpt）
let pendingApproval = null; // { resolve, info: {id, tool, args} }
let currentCwd = null;
let firstRun = true;
let currentGoal = null; // 目标模式：会话目标（进程内跨轮注入）
let abortRequested = false;
let activeRun = null;
let sessionKey = null;

// 模型自治：启用的配置档案（随 run/summarize 指令下发，按顺序降级）
let modelProfiles = [];
let lastAssistantText = ""; // 最近一条助手文本（memorize 抽取用）

/**
 * 通用级运行规范（会话首轮注入）——分区式（抄 ZCode context/sections 架构）：
 * 身份+安全 → 运行纪律 → 输出规范 → 环境注入（cwd/平台/日期，按会话实际值生成）。
 */
/** 附件 → pi 内联图片（图片附件）；非图片以可读路径注入提示（deck 有 read/bash 可自行打开） */
const IMAGE_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif",
};
function buildAttachments(msg) {
  const list = Array.isArray(msg.attachments) ? msg.attachments : [];
  const images = [];
  const paths = [];
  for (const a of list) {
    if (typeof a !== "string" || !a) continue;
    const ext = a.split(".").pop()?.toLowerCase() ?? "";
    const mime = IMAGE_MIME[ext];
    if (mime) {
      try {
        const data = fs.readFileSync(a).toString("base64");
        images.push({ type: "image", data, mimeType: mime });
        continue;
      } catch {}
    }
    paths.push(a);
  }
  const note = paths.length
    ? "\n\n（附件文件（可用 read 或命令工具查看）：" + paths.join("；") + "）"
    : "";
  return { images, note };
}

function buildUniversalPrompt(cwd, memories = []) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const identity = [
    "你是 AgentDeck 自有运行时的编码智能体，在用户本机直接操作真实文件系统。",
    "协助用户完成软件工程任务：授权的安全测试、防御性分析与教学场景均可协助；拒绝破坏性技术、DoS、供应链投毒或恶意逃避检测的请求。",
  ].join("\n");

  const discipline = [
    "运行纪律：",
    "1) 先理解再动手：改动前先读相关文件；不确定就 ls/grep 查证，不猜接口。",
    "2) 计划先行：超过 3 步的任务先用 todo_write 给出计划，再逐步执行并更新状态。",
    "3) 小步修改 + 即时验证：每次改动后运行编译/测试/脚本自证；验证不过就修，不许留红。",
    "4) 诚实汇报：失败如实报告并附错误原文；绝不伪造成功。",
    "5) 善用自持能力：查资料用 webfetch；额度紧张时用 list_models/switch_model 自主管理模型。",
    "6) 删除文件用 delete_file（不用 shell 的 rm/del）：这样删除了哪个文件在对话里可见。",
  ].join("\n");

  const output = [
    "输出规范：",
    "- 中文沟通，结论先行。",
    "- 引用代码位置用 文件路径:行号 格式（可点击）。",
    "- 关键路径与命令原样给出，不省略。",
  ].join("\n");

  const env = [
    "<env>",
    `工作目录：${cwd || currentCwd || "(未定)"}`,
    `平台：${process.platform}`,
    `今日日期：${date}`,
    "</env>",
  ].join("\n");

  const memory =
    memories.length > 0
      ? [
          "已知记忆（本项目历史要点，供参考，不要重复询问）：",
          ...memories.map((m) => "- " + m),
        ].join("\n")
      : null;

  return [identity, discipline, output, env, memory]
    .filter(Boolean)
    .join("\n\n");
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function deckEvent(type, extra = {}) {
  emit({ type: `deck_${type}`, ...extra });
}

// 进程级兜底：未捕获异常/拒绝 → 作为 deck_error 上报（进程保活让 Rust 把事件送达前端），
// 避免"任务永远转圈"或只有一行崩溃日志
process.on("uncaughtException", (err) => {
  try {
    deckEvent("error", { message: `运行时异常：${err?.message ?? err}` });
  } catch {}
});
process.on("unhandledRejection", (reason) => {
  try {
    deckEvent("error", { message: `运行时异常：${reason?.message ?? reason}` });
  } catch {}
});

// Windows 盘根坑：lstat/realpath 裸盘符（如 "C:"）会 EISDIR——pi 目录遍历走到盘根时触发。
// 统一改写成带反斜杠的形式。
import fs from "node:fs";
for (const target of [fs, fs.promises]) {
  const orig = target.lstat;
  target.lstat = function (path, ...rest) {
    if (typeof path === "string" && /^[a-zA-Z]:$/.test(path)) path = path + "\\";
    return orig.call(this, path, ...rest);
  };
}

/**
 * 模型池 → pi 声明式供应商配置（models.json，等价 opencode.json 的角色）。
 * 每个启用档案一个 provider：baseUrl / apiKey / api（协议）/ models 目录
 * （contextWindow/maxTokens 随行声明，pi 以此判断压缩与输出上限）。
 * 写入临时文件后由 ModelRuntime.create({ modelsPath }) 加载——
 * 模型、凭据、寻址（providerId/modelId）全部走 pi 注册表，不再手搓 Model。
 */
function buildModelsJson(profiles) {
  const providers = {};
  for (const p of profiles) {
    const rows = profileModelRows(p);
    const models = rows.length
      ? rows.map((m) => ({
          id: m.id,
          name: m.id,
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 8192,
          reasoning: false,
          input: ["text", "image"],
        }))
      : p.model
        ? [
            {
              id: p.model,
              name: p.model,
              contextWindow: 128000,
              maxTokens: 8192,
              reasoning: false,
              input: ["text", "image"],
            },
          ]
        : [];
    providers[p.id] = {
      name: p.label || p.provider,
      baseUrl:
        p.baseUrl ||
        (p.provider === "glm" ? process.env.ZAI_BASE_URL : process.env.OPENAI_BASE_URL) ||
        (p.provider === "glm" ? "https://api.z.ai/api/coding/paas/v4" : "https://api.openai.com/v1"),
      api:
        p.protocol === "responses"
          ? "openai-responses"
          : p.protocol === "anthropic"
            ? "anthropic-messages"
            : "openai-completions",
      apiKey: p.key,
      models,
    };
  }
  return { providers };
}

/** 从声明式配置建 runtime，并解析默认模型（providerId/modelId 寻址） */
async function createRuntimeForProfile(p) {
  const modelsFile = path.join(os.tmpdir(), `deck-models-${process.pid}.json`);
  fs.writeFileSync(modelsFile, JSON.stringify(buildModelsJson([p])), { mode: 0o600 });
  let runtime;
  try {
    runtime = await ModelRuntime.create({ modelsPath: modelsFile, refreshOnCreate: false });
  } finally {
    fs.rmSync(modelsFile, { force: true });
  }
  const rows = profileModelRows(p);
  const defaultId = (rows.find((r) => r.id === p.model) ?? rows[0] ?? { id: p.model }).id;
  if (!defaultId) {
    throw new Error(`模型档案「${p.label || p.provider}」未配置模型——请到设置添加模型`);
  }
  const model = runtime.getModel(p.id, defaultId);
  if (!model) {
    throw new Error(`模型 ${p.id}/${defaultId} 未注册成功——检查 Base URL 与上游协议`);
  }
  const scoped = rows
    .map((r) => runtime.getModel(p.id, r.id))
    .filter(Boolean)
    .map((m) => ({ model: m }));
  return { runtime, model, scoped };
}

/** 档案 → 模型目录行（无目录时回退到默认模型单行） */
function profileModelRows(p) {
  const rows = Array.isArray(p.models)
    ? p.models.filter((m) => m && m.id).map((m) => ({
        id: m.id,
        contextWindow: m.context_window || m.contextWindow,
        maxTokens: m.max_tokens || m.maxTokens,
      }))
    : [];
  if (rows.length === 0 && p.model) rows.push({ id: p.model, contextWindow: null, maxTokens: null });
  return rows;
}



/** Windows 上 bash 会落到 WSL 吗？pi 的 shell 解析顺序是 Git Bash → PATH 上的 bash.exe，
 *  没有 Git Bash 时就会命中 C:\Windows\System32\bash.exe（WSL）。WSL 里 Windows 路径
 *  （C:/…）与 cwd 都不可用，因此这种情况改注册 PowerShell 工具（对齐 ZCode 的
 *  「绝不退到 WSL bash，改用系统 shell」）。 */
function usesWslBash() {
  if (process.platform !== "win32") return false;
  try {
    const { shell } = getShellConfig();
    const normalized = String(shell).replace(/\//g, "\\").toLowerCase();
    return /\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized) || /\\windowsapps\\bash\.exe$/.test(normalized);
  } catch {
    // 找不到任何 bash：pi 会直接报错，不属于"静默落到 WSL"
    return false;
  }
}

/** deck 自持工具集（抄 OpenCode 工具形态）：读/写/改/命令/搜索/定位/列表 */
function buildTools(mode, cwd) {
  const factories = [
    m_createReadTool,
    m_createWriteTool,
    m_createEditTool,
    usesWslBash() ? m_createPowerShellTool : m_createBashTool,
    m_createGrepTool,
    m_createFindTool,
    m_createLsTool,
  ];
  let tools = [];
  for (const f of factories) {
    try {
      const t = f?.(cwd);
      if (t) tools.push(t);
    } catch {
      /* 逐个容错 */
    }
  }
  if (tools.length === 0) tools = [...createCodingTools(cwd)];
  // 委派工具：互调是 deck 运行时的一等能力；switch_model：模型自治；
  // webfetch/todo_write/list_models：向 ZCode(45 契约)/OpenCode 看齐的自持能力
  tools = [
    ...tools,
    ...DELEGATE_TOOLS,
    PROPOSE_COLLABORATION_TOOL,
    SWITCH_MODEL_TOOL,
    WEBFETCH_TOOL,
    TODO_TOOL,
    ASK_USER_TOOL,
    LIST_MODELS_TOOL,
    DELETE_FILE_TOOL,
  ];
  // 权限门：approved 模式下全部工具（含委派）执行前经 UI 审批
  return mode === "approved" ? tools.map(wrapWithGate) : tools;
}

async function ensureSessionForProfile(p, { cwd, mode, resumeFile, toolsEnabled = true } = {}) {
  const rows = profileModelRows(p);
  const resolved = await createRuntimeForProfile(p);
  if (!p.key) {
    throw new Error(`配置 ${p.provider} 缺少 API Key`);
  }
  const want = JSON.stringify([p.id, p.key, p.baseUrl, p.protocol, rows, cwd, mode, resumeFile ?? null, toolsEnabled]);
  if (session && sessionKey === want) return session;

  if (session) {
    try {
      await session.dispose?.();
    } catch {}
    session = null;
  }

  currentCwd = cwd || process.cwd();
  // A missing resume handle is an error, not a silent loss of conversation.
  let sessionManager;
  if (resumeFile) {
    if (!fs.existsSync(resumeFile)) throw new Error(`续聊会话文件不存在：${resumeFile}`);
    sessionManager = SessionManager.open(resumeFile, undefined, currentCwd);
  }
  // createAgentSession 返回 { session, extensionsResult } 包装，必须解包
  const tools = toolsEnabled ? buildTools(mode, currentCwd) : [];
  const created = await createAgentSession({
    cwd: currentCwd,
    model: resolved.model,
    modelRuntime: resolved.runtime,
    // 模型目录：该供应商下配置的全部模型（切换/循环的基础）
    scopedModels: resolved.scoped,
    sessionManager,
    customTools: tools,
    tools: tools.map((tool) => tool.name),
    noTools: toolsEnabled ? "builtin" : "all",
  });
  session = created?.session;
  if (!session || typeof session.subscribe !== "function") {
    throw new Error(
      `会话创建失败：返回了非会话对象（${created?.error ?? created?.message ?? typeof created}）`,
    );
  }
  sessionKey = want;
  currentModel = p.provider;
  // 上报会话 ID 与恢复句柄（持久化到任务记录，支撑续接语义）
  try {
    const sid = session.sessionId ?? session.id;
    if (sid) emit({ type: "deck_session_id", id: String(sid) });
    const sf = session.sessionFile;
    if (sf) emit({ type: "deck_session_file", path: String(sf) });
  } catch {}
  // 上下文治理（pi 内置，显式开启）：auto-compaction 压缩增长的历史，
  // auto-retry 对过载/限流做指数退避（上下文溢出走 compaction 不重试）
  try {
    session.setAutoCompactionEnabled?.(true);
    session.setAutoRetryEnabled?.(true);
  } catch {}
  session.subscribe((event) => {
    // pi 结构化事件原样透传（含 message_* / tool_execution_* / agent_*）
    emit(event);
    // 记录最近一条助手文本（memorize 抽取用）
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = (event.message.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      if (text.trim()) lastAssistantText = text;
      // 上下文用量上报（ZCode 交互层设计）：input+cacheRead ≈ 当前上下文占用
      const u = event.message.usage;
      if (u && (u.input || u.cacheRead)) {
        const used = (u.input || 0) + (u.cacheRead || 0) + (u.output || 0);
        if (used > 0) {
          emit({
            type: "deck_context_usage",
            usedTokens: used,
            totalTokens: u.totalTokens ?? null,
          });
        }
      }
    }
  });
  return session;
}

/** 工具包装：执行前发审批请求（带工具名与参数），等 stdin 的 approve/reject */
function wrapWithGate(tool) {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      const id = toolCallId || randomUUID();
      if (signal?.aborted || abortRequested) throw new Error("Operation aborted");
      const approved = await new Promise((resolve) => {
        const onAbort = () => resolve(false);
        signal?.addEventListener("abort", onAbort, { once: true });
        pendingApproval = {
          resolve: (value) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
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
      if (signal?.aborted || abortRequested) throw new Error("Operation aborted");
      return tool.execute(toolCallId, args, signal, onUpdate, ctx);
    },
  };
}

// ── 委派工具：pi agent 原生调用 zcode/codex CLI（互调语义） ────────

function runHeadless(program, args, cwd, timeoutMs = 10 * 60 * 1000, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: -1, out: "", errTail: "委派已取消" });
      return;
    }
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
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const kill = () => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true, stdio: "ignore",
        });
        killer.on("error", () => child.kill());
      } else child.kill();
    };
    const onAbort = () => {
      kill();
      finish({ code: -1, out, errTail: "委派已取消" });
    };
    const timer = setTimeout(() => {
      kill();
      finish({ code: -1, out, errTail: `委派超时（${timeoutMs / 60000} 分钟）` });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (errTail = (d.toString() + errTail).slice(0, 1500)));
    child.on("error", (e) => {
      finish({ code: -1, out, errTail: e.message });
    });
    child.on("close", (code) => {
      finish({ code: code ?? -1, out, errTail });
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

// ── 自持能力：网络抓取 / todo 进度 / 模型池自省（向 ZCode/OpenCode 看齐） ──

let sessionTodos = []; // 会话内 todo 状态（switch_model/重建会话不跨保留）

/** 删除文件：pi 只有 read/write/edit/bash，删除只能靠 shell 的 rm——于是"删了什么"
 *  在转录里没有一等信号。补一个删除工具（对齐 ZCode 把文件操作当一等公民的做法），
 *  路径与结果都会在对话行上可见。 */
const DELETE_FILE_TOOL = {
  name: "delete_file",
  description:
    "删除工作区里的一个文件。删除文件请优先用这个工具，而不是 shell 的 rm/del——它会在对话里明确显示删除了哪个文件。只删文件，不删目录、不支持通配符。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "要删除的文件路径（相对工作目录或绝对路径）" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async (_id, args) => {
    const raw = String(args?.path ?? "").trim();
    if (!raw) return { content: [{ type: "text", text: "path 不能为空" }], isError: true };
    const target = path.resolve(currentCwd ?? process.cwd(), raw);
    try {
      if ((await fs.promises.stat(target)).isDirectory()) {
        return { content: [{ type: "text", text: `拒绝删除目录：${raw}（本工具只删文件）` }], isError: true };
      }
      await fs.promises.unlink(target);
      return { content: [{ type: "text", text: `已删除 ${raw}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `删除失败：${error?.message ?? error}` }], isError: true };
    }
  },
};

const WEBFETCH_TOOL = {
  name: "webfetch",
  description:
    "抓取一个网页/接口的正文文本（自动剥离 HTML 标签，截断到 8000 字符）。用于查文档、读接口返回。不支持需要登录的页面。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "完整 URL（http/https）" },
    },
    required: ["url"],
  },
  execute: async (_id, args) => {
    const url = String(args?.url ?? "");
    if (!/^https?:\/\//.test(url)) {
      return {
        content: [{ type: "text", text: "URL 必须以 http(s):// 开头" }],
        isError: true,
      };
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "user-agent": "AgentDeck/0.1 (+webfetch)" },
        redirect: "follow",
      });
      clearTimeout(timer);
      const raw = await res.text();
      if (!res.ok) {
        return {
          content: [
            {
              type: "text",
              text: `HTTP ${res.status} ${res.statusText}\n${raw.slice(0, 500)}`,
            },
          ],
          isError: true,
        };
      }
      const isHtml = /<\/?[a-z][\s>]/i.test(raw.slice(0, 1000));
      const text = isHtml
        ? raw
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s+/g, " ")
            .trim()
        : raw;
      const cut = text.length > 8000 ? `${text.slice(0, 8000)}\n…(截断，原文 ${text.length} 字符)` : text;
      return { content: [{ type: "text", text: cut || "（空内容）" }] };
    } catch (e) {
      const reason = e?.name === "AbortError" ? "超时（15 秒）" : String(e?.message ?? e);
      return { content: [{ type: "text", text: `抓取失败：${reason}` }], isError: true };
    }
  },
};

/** 选项式提问（抄 ZCode AskUserQuestion 契约）：关键分叉点让用户选，复用审批通道 */
const ASK_USER_TOOL = {
  name: "ask_user_question",
  description:
    "向用户提出一个需要决策的澄清问题（选项式）。当任务存在多个合理方向、影响范围大的取舍、或信息不足以继续时使用；" +
    "不要用它确认显而易见的事。选项必须互斥且覆盖主要可能；用户始终可以选'其他'自由输入。" +
    "options 每项：label（1-5 词）、description（选它的后果/取舍）、preview（可选，聚焦时展示的代码片段或方案对比）。",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "完整的问题，清晰具体，以问号结尾" },
      header: { type: "string", description: "极短的标签（≤12 字符），如「认证方案」「库选择」" },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        description: "2-4 个互斥选项；不要包含「其他」，系统自动提供",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "选项显示文本（1-5 词）" },
            description: { type: "string", description: "选此项意味着什么（取舍/影响）" },
            preview: { type: "string", description: "可选：聚焦时展示的预览（代码片段/方案示意）" },
          },
          required: ["label", "description"],
        },
      },
      multiSelect: { type: "boolean", description: "true = 允许多选（选项不互斥时）", default: false },
    },
    required: ["question", "header", "options"],
  },
  execute: async (toolCallId, args, signal) => {
    const id = toolCallId || randomUUID();
    const answer = await new Promise((resolve) => {
      const onAbort = () => resolve(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingApproval = {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        info: { id, tool: "ask_user_question", args },
      };
      emit({
        type: "deck_approval_request",
        id,
        tool: "ask_user_question",
        args: {
          __question: {
            question: String(args?.question ?? ""),
            header: String(args?.header ?? "问题"),
            options: (Array.isArray(args?.options) ? args.options : []).slice(0, 4),
            multiSelect: args?.multiSelect === true,
          },
          ...(args ?? {}),
        },
      });
    });
    pendingApproval = null;
    if (answer === null || answer === false) {
      return { content: [{ type: "text", text: "用户未作选择（跳过/中止）" }], isError: true };
    }
    // 审批通道回传布尔；问题答案经 pi_command 的自定义 payload 传递（answer 字段）
    const text =
      typeof answer === "object" && answer?.choice
        ? `用户选择：${answer.choice}`
        : "用户已确认继续";
    return { content: [{ type: "text", text }] };
  },
};

const TODO_TOOL = {
  name: "todo_write",
  description:
    "维护当前任务的待办清单（整体替换式）。超过 3 步的任务应当先写计划，完成后随时更新状态。清单会展示给用户。",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "完整清单（每次整体替换）",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            priority: { type: "string", enum: ["high", "medium", "low"], description: "优先级（默认 medium）" },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  execute: async (_id, args) => {
    const list = Array.isArray(args?.todos) ? args.todos : [];
    sessionTodos = list;
    // 推给 UI（未来可渲染成任务清单组件）
    emit({ type: "deck_todo_updated", todos: sessionTodos });
    const mark = (s) =>
      s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]";
    const text = list.length
      ? list.map((t) => `${mark(t.status)} ${t.content}`).join("\n")
      : "（清单已清空）";
    return { content: [{ type: "text", text }] };
  },
};

const LIST_MODELS_TOOL = {
  name: "list_models",
  description:
    "查看你当前的模型池：有哪些已启用的模型配置、现在用的是哪个。配合 switch_model 使用。",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    const lines = modelProfiles.map((p) => {
      const mark = p.provider === currentModel ? "→" : " ";
      const head = `${mark} ${p.provider}${p.label ? `（${p.label}）` : ""}${
        p.baseUrl ? ` @ ${p.baseUrl}` : ""
      }`;
      const rows = profileModelRows(p);
      const catalog = rows.length ? `
    模型: ${rows.map((m) => m.id).join(", ")}` : "";
      return head + catalog;
    });
    return {
      content: [
        { type: "text", text: lines.length ? lines.join("\n") : "模型池为空" },
      ],
    };
  },
};

const DELEGATE_TOOLS = [
  {
    name: "delegate_to_zcode",
    label: "委派给 ZCode (GLM)",
    description:
      "把一个自包含的编码子任务委派给 ZCode（GLM）无头执行，阻塞直到完成并返回最终结论。适合把实现类子任务外包给 GLM。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "任务描述，必须自包含（对方看不到当前对话）" },
        cwd: { type: "string", description: "工作目录，默认当前项目目录" },
      },
      required: ["prompt"],
    },
    execute: async (_id, args, signal) => {
      const r = await runHeadless(
        "zcode",
        ["--json", "--mode", "yolo", "-p", String(args?.prompt ?? "")],
        args?.cwd || currentCwd,
        undefined,
        signal,
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
    execute: async (_id, args, signal) => {
      const r = await runHeadless(
        "codex",
        ["exec", "--json", "--skip-git-repo-check", String(args?.prompt ?? "")],
        args?.cwd || currentCwd,
        undefined,
        signal,
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

const PLAN_HARNESSES = ["codex", "opencode", "zcode", "deck"];

/**
 * 多模型协作规划工具：agent 出计划，用户在界面上确认，再由 Agent Deck 启动编排。
 * 真正的执行在 Rust 侧（隔离 worktree + DAG + 集成），所以这里不 spawn 任何进程 ——
 * 与 DELEGATE_TOOLS 的阻塞式单路委派是两条路。
 * 计划随 deck_approval_request 的 __plan 字段送达 UI，用户的确认/取消沿既有审批通道回来。
 */
const PROPOSE_COLLABORATION_TOOL = {
  name: "propose_collaboration",
  label: "规划多模型协作",
  description:
    "当任务确实值得拆给多个模型时，提出一份协作计划交用户确认：谁做什么、依赖关系、并发与总时限。" +
    "确认后由 Agent Deck 结束等待审批的规划轮次并交接：单个普通节点在当前目录执行，" +
    "多节点或指挥链在隔离工作树中执行并汇总成果，运行状态见任务视图。" +
    "节点可指定 supervision，由指挥方规划、独立验收并驱动返工；多个指挥执行链可以并行，" +
    "通过 dependencies 共享验收后的成果。单条指挥链也可使用。",
  parameters: {
    type: "object",
    properties: {
      why: { type: "string", description: "一句话说明为什么值得拆成多路（用户据此决定是否同意）" },
      nodes: {
        type: "array",
        minItems: 1,
        maxItems: 1024,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "短标识，如 impl / tests / review" },
            harness: { type: "string", enum: PLAN_HARNESSES, description: "执行该节点的运行时" },
            prompt: { type: "string", description: "该节点自包含的任务要求（对方看不到当前对话）" },
            dependencies: {
              type: "array",
              items: { type: "string" },
              description: "必须先完成的节点 id；留空表示可立即开始",
            },
            read_only: { type: "boolean", description: "默认 true：只产出结论，不改文件" },
            contract: {
              type: "object",
              properties: {
                workspace: { type: "string", enum: ["git", "artifacts"], description: "代码用 git；小说/文档等用 artifacts，不依赖 Git" },
                model_hint: { type: ["string", "null"], description: "用户指定模型的原文，禁止猜测替换" },
                outputs: { type: "array", items: { type: "string" }, description: "向后续节点提交的相对文件路径" },
                inputs: { type: "array", items: { type: "string" }, description: "从源工作目录读取并冻结的相对文件路径" },
                acceptance: { type: "boolean", description: "独立只读验收，结论必须绑定成果版本" },
              },
              required: ["workspace", "outputs", "acceptance"],
            },
            execution: {
              type: "object",
              description: "指定执行模型；用户要求免费或特定模型时必须填写确认过的完整模型 ID",
              properties: {
                model: { type: "string", description: "运行器的完整模型 ID" },
                effort: { type: "string", description: "原生思考强度，可省略" },
              },
            },
            supervision: {
              type: "object",
              properties: {
                commander: { type: "string", enum: PLAN_HARNESSES, description: "规划和验收方，必须与 harness 不同" },
                max_rounds: { type: "integer", minimum: 1, maximum: 3 },
                model_hint: { type: ["string", "null"] },
                execution: { type: "object", properties: {
                  model: { type: ["string", "null"] }, effort: { type: ["string", "null"] },
                } },
              },
              required: ["commander", "max_rounds"],
            },
          },
          required: ["id", "harness", "prompt"],
        },
      },
      parallel: { type: "integer", description: "并发上限，默认 2，受平台当前额度约束" },
      minutes: { type: "integer", description: "协作总时限（分钟），默认 15，受平台当前额度约束" },
    },
    required: ["why", "nodes"],
  },
  execute: async (toolCallId, args, signal) => {
    const id = toolCallId || randomUUID();
    let plan;
    try { plan = normalizeWorkflowPlan(args, PLAN_HARNESSES); }
    catch (error) { return { content: [{ type: "text", text: error.message }], isError: true }; }
    const answer = await new Promise((resolve) => {
      const onAbort = () => resolve(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingApproval = {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        info: { id, tool: "propose_collaboration", args },
      };
      emit({
        type: "deck_approval_request",
        id,
        tool: "propose_collaboration",
        args: { __plan: plan },
      });
    });
    pendingApproval = null;
    if (answer === null || answer === false) {
      return { content: [{ type: "text", text: "用户取消了这份协作计划。" }], isError: true };
    }
    const note = typeof answer === "object" && answer?.choice ? String(answer.choice) : "用户已确认";
    const shape = nodes.map((n) => `${n.id}(${n.harness})`).join("、");
    return {
      content: [
        {
          type: "text",
          text: `${note}。计划节点：${shape}。确认回复不代表任务已启动，请以任务视图中的实际运行状态为准。`,
        },
      ],
    };
  },
};

/** 模型自治工具：agent 自己切换底层模型（setModel 保留会话上下文） */
const SWITCH_MODEL_TOOL = {
  name: "switch_model",
  description:
    "切换你自己（deck 运行时）的底层模型。当前模型额度不足、任务更适合另一家时使用。切换保留当前会话上下文。",
  parameters: {
    type: "object",
    properties: {
      model: { type: "string", enum: ["glm", "gpt"], description: "目标模型" },
    },
    required: ["model"],
  },
  execute: async (_id, args) => {
    const target = String(args?.model ?? "").toLowerCase();
    const p = modelProfiles.find((x) => x.provider === target);
    if (!p) {
      return {
        content: [
          { type: "text", text: `模型池中没有启用的 ${target} 配置（设置面板可添加）` },
        ],
        isError: true,
      };
    }
    try {
      if (!session) throw new Error("会话未建立");
      const built = await createRuntimeForProfile(p);
      await session.setModel(built.model);
      currentModel = p.provider;
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

async function handle(msg) {
  switch (msg.cmd) {
    case "run": {
      abortRequested = false;
      modelProfiles = normalizeProfiles(msg.profiles);
      if (modelProfiles.length === 0) {
        deckEvent("error", {
          message: "模型池为空——请到设置面板添加并启用至少一个模型配置",
        });
        deckEvent("run_end", { ok: false, status: "failed" });
        break;
      }

      // 模型自治：按启用顺序执行，失败（额度/认证/网络）自动降级到下一个配置
      let lastErr = null;
      let succeeded = false;
      let resumeFile = msg.resumeSessionFile;
      for (let i = 0; i < modelProfiles.length && !abortRequested; i++) {
        const p = modelProfiles[i];
        try {
          const s = await ensureSessionForProfile(p, {
            cwd: msg.cwd,
            mode:
              msg.mode === "approved" ? "approved" : msg.mode === "plan" ? "plan" : "auto",
            resumeFile,
            toolsEnabled: msg.mode !== "intent",
          });
          if (i === 0 && msg.resumeSessionFile) firstRun = false; // 续接：纪律已在历史里
          // 目标模式：首轮 prompt 即会话目标，跨轮持续注入（续接同会话由历史自证）
          if (msg.mode === "goal" && i === 0) currentGoal = msg.prompt;
          deckEvent("run_start", { model: p.provider });
          // 通用级运行规范：仅会话首轮注入（纪律只说一次）
          const promptText = firstRun && msg.mode !== "intent"
            ? buildUniversalPrompt(msg.cwd, msg.memories) + "\n\n==== 任务 ====\n" + msg.prompt
            : msg.prompt;
          if (abortRequested) break;
          const { images, note: attachNote } = buildAttachments(msg);
          const goalNote =
            msg.mode === "goal" && currentGoal
              ? "\n\n==== 会话目标（持续有效，勿偏离） ====\n" + currentGoal
              : "";
          const planNote =
            msg.mode === "plan"
              ? "\n\n==== 计划模式 ====\n当前为只读规划：只允许读取与搜索，不要修改任何文件。产出一份可执行计划（步骤/风险/验证方式），等用户确认后再进入执行模式。"
              : "";
          await s.prompt(promptText + planNote + goalNote + attachNote, images.length ? { images } : undefined);
          if (s.sessionFile) {
            resumeFile = s.sessionFile;
            deckEvent("session_file", { path: s.sessionFile });
          }
          if (abortRequested) break;
          firstRun = false;
          // stopReason=error（如 401 令牌过期）：把上游错误显式上报，而不是静默收尾
          if (s.messages?.length) {
            const lastAssistant = [...s.messages].reverse().find((m) => m.role === "assistant");
            if (lastAssistant?.stopReason === "aborted") {
              abortRequested = true;
              break;
            }
            if (lastAssistant?.stopReason === "error") {
              // 上游错误体（如 429: {"error":{"message":"余额不足…"}}）提取人话再抛
              const raw = String(lastAssistant.errorMessage || "模型请求失败，未提供详细错误");
              const m = raw.match(/^\d+:\s*([\s\S]*)$/);
              const body = m ? m[1].trim() : raw;
              let friendly = body;
              try {
                const v = JSON.parse(body);
                const message = v?.error?.message ?? v?.message;
                friendly = typeof message === "string" ? message : body;
              } catch {}
              throw new Error(friendly.slice(0, 300));
            }
          }
          succeeded = true;
          deckEvent("run_end", { ok: true, status: "done" });
          break;
        } catch (err) {
          if (abortRequested) break;
          resumeFile = session?.sessionFile ?? resumeFile;
          if (resumeFile) firstRun = false;
          lastErr = err;
          const reason = String(err?.message ?? err).slice(0, 160);
          deckEvent("status", { text: `${p.provider} 执行失败：${reason}` });
          if (i < modelProfiles.length - 1) {
            deckEvent("status", {
              text: `自动切换到 ${modelProfiles[i + 1].provider} 继续`,
            });
          }
        }
      }
      if (abortRequested) {
        deckEvent("run_end", { ok: false, status: "cancelled" });
      } else if (!succeeded && lastErr) {
        deckEvent("error", {
          message: `所有已启用模型均失败：${String(lastErr?.message ?? lastErr)}`,
        });
        deckEvent("run_end", { ok: false, status: "failed" });
      }
      break;
    }
    case "summarize": {
      // 会话压缩：把交接记录压成结构化简报（AI 交接的核心步骤）
      try {
        modelProfiles = normalizeProfiles(msg.profiles);
        if (modelProfiles.length === 0) {
          throw new Error("模型池为空——请到设置面板添加并启用模型配置");
        }
        const p =
          modelProfiles.find((x) => x.provider === "glm") ?? modelProfiles[0];
        const s = await ensureSessionForProfile(p, {
          cwd: msg.cwd || process.cwd(),
          mode: "auto",
          toolsEnabled: false,
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
            "要求：只输出简报本身，不要执行任务；保留具体路径、命令、参数；总长不超过 500 字。\n\n" +
            "===== 会话记录 =====\n" +
            String(msg.text ?? ""),
        );
        active = false;
        un();
        // 上游错误（401/429/超时）在 pi 里是 stopReason=error 的空回复，必须显式失败
        const lastAssistant = [...(s.messages ?? [])].reverse().find((m) => m.role === "assistant");
        if (lastAssistant?.stopReason === "error" && lastAssistant.errorMessage) {
          throw new Error(String(lastAssistant.errorMessage).slice(0, 300));
        }
        deckEvent("summarize_result", { text: last });
      } catch (err) {
        deckEvent("summarize_error", { message: String(err?.message ?? err) });
      }
      break;
    }
    case "memorize": {
      // 记忆抽取（抄 ZCode memory/extraction）：从会话记录提取持久记忆
      try {
        let existing = "";
        if (Array.isArray(msg.existing) && msg.existing.length > 0) {
          existing =
            "\n\n## 已有记忆清单（更新已有项而非重复创建）\n" +
            msg.existing.map((m) => "- " + m).join("\n");
        }
        deckEvent("memorize_start");
        const p =
          modelProfiles.find((x) => x.provider === "glm") ?? modelProfiles[0];
        if (!p) throw new Error("模型池为空");
        const s = await ensureSessionForProfile(p, {
          cwd: msg.cwd || process.cwd(),
          mode: "auto",
          toolsEnabled: false,
        });
        await s.prompt(
          "你现在是记忆抽取子代理。分析下面的会话记录，提取值得跨任务持久保存的记忆：" +
            "项目约定、用户偏好、关键决策、环境坑位。\n" +
            "不要保存：一次性任务细节、可从代码直接看出的内容、寒暄。\n" +
            "已有记忆需更新时，输出更新后的完整条目。\n" +
            "如果没有任何值得保存的，输出 []。\n" +
            "只输出一个 JSON 字符串数组（每条为自包含的中文记忆），不要其他内容。\n\n" +
            "===== 会话记录 =====\n" +
            String(msg.text ?? "") +
            existing,
        );
        const m = lastAssistantText.match(/\[[\s\S]*?\]/);
        let memories = [];
        if (m) {
          try {
            memories = JSON.parse(m[0]).filter((x) => typeof x === "string");
          } catch {}
        }
        deckEvent("memorize_result", { memories });
      } catch (err) {
        deckEvent("memorize_error", { message: String(err?.message ?? err) });
      }
      break;
    }
    case "close": {
      process.stdout.write("", () => process.exit(0));
      break;
    }
    case "approve": {
      if (pendingApproval?.resolve && pendingApproval.info.id === msg.id) {
        deckEvent("approval_decided", { id: msg.id, approved: true });
        // 选项式提问：answer = 用户点的选项 label
        pendingApproval.resolve(msg.answer ? { choice: String(msg.answer) } : true);
      }
      break;
    }
    case "reject": {
      if (pendingApproval?.resolve && pendingApproval.info.id === msg.id) {
        deckEvent("approval_decided", { id: msg.id, approved: false });
        pendingApproval.resolve(false);
      }
      break;
    }
    case "abort": {
      abortRequested = true;
      pendingApproval?.resolve(false);
      try {
        await session?.abort?.();
      } catch {}
      break;
    }
    // 手动压缩上下文（/compact）：pi 的手动入口会先中止当前 agent 操作
    case "compact": {
      try {
        await session?.compact?.(msg.answer ? String(msg.answer) : undefined);
      } catch (error) {
        deckEvent("error", { message: `上下文压缩失败：${error?.message ?? error}` });
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
  if (["run", "summarize", "memorize"].includes(msg.cmd)) {
    if (activeRun) {
      deckEvent("status", { text: "运行中，拒绝重复启动" });
      return;
    }
    activeRun = Promise.resolve(handle(msg))
      .catch((err) => deckEvent("error", { message: String(err?.message ?? err) }))
      .finally(() => { activeRun = null; });
  } else {
    Promise.resolve(handle(msg)).catch((err) =>
      deckEvent("error", { message: String(err?.message ?? err) }),
    );
  }
});
process.stdin.on("end", async () => {
  await activeRun;
  try {
    await session?.dispose?.();
  } catch {}
  // stdout 是异步管道：等缓冲排空再退出，否则最后一条结果行会被截断丢失
  process.stdout.write("", () => process.exit(0));
});

function normalizeProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).map((p) => ({
    ...p,
    baseUrl: p.base_url ?? p.baseUrl,
  }));
}
