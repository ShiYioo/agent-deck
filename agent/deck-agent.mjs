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
  createReadTool as m_createReadTool,
  createWriteTool as m_createWriteTool,
  createEditTool as m_createEditTool,
  createBashTool as m_createBashTool,
  createGrepTool as m_createGrepTool,
  createFindTool as m_createFindTool,
  createLsTool as m_createLsTool,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

let session = null;
let currentModel = null; // 当前底层 provider（glm/gpt）
let pendingApproval = null; // { resolve, info: {id, tool, args} }
let currentCwd = null;
let firstRun = true;

// 模型自治：启用的配置档案（随 run/summarize 指令下发，按顺序降级）
let modelProfiles = [];
let lastAssistantText = ""; // 最近一条助手文本（memorize 抽取用）

/**
 * 通用级运行规范（会话首轮注入）——分区式（抄 ZCode context/sections 架构）：
 * 身份+安全 → 运行纪律 → 输出规范 → 环境注入（cwd/平台/日期，按会话实际值生成）。
 */
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

/** pi-ai 的 Model 对象最小面：provider/id/apiKey/baseURL */
function resolveFromProfile(p) {
  const glm = p.provider === "glm";
  return {
    provider: glm ? "zai" : "openai",
    id: p.model || (glm ? "glm-4.7" : "gpt-5.1"),
    apiKey: p.key,
    baseUrl:
      p.baseUrl ||
      (glm ? process.env.ZAI_BASE_URL : process.env.OPENAI_BASE_URL) ||
      (glm ? "https://api.z.ai/api/coding/paas/v4" : "https://api.openai.com/v1"),
  };
}

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
  // 委派工具：互调是 deck 运行时的一等能力；switch_model：模型自治；
  // webfetch/todo_write/list_models：向 ZCode(45 契约)/OpenCode 看齐的自持能力
  tools = [
    ...tools,
    ...DELEGATE_TOOLS,
    SWITCH_MODEL_TOOL,
    WEBFETCH_TOOL,
    TODO_TOOL,
    LIST_MODELS_TOOL,
  ];
  // 权限门：approved 模式下全部工具（含委派）执行前经 UI 审批
  return mode === "approved" ? tools.map(wrapWithGate) : tools;
}

async function ensureSessionForProfile(p, { cwd, mode }) {
  const resolved = resolveFromProfile(p);
  if (!resolved.apiKey) {
    throw new Error(`配置 ${p.provider} 缺少 API Key`);
  }
  const want = JSON.stringify([p.provider, p.key, p.baseUrl, cwd, mode]);
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
  // 上报会话 ID（持久化到任务记录，支撑续接语义）
  try {
    const sid = session.sessionId ?? session.id;
    if (sid) emit({ type: "deck_session_id", id: String(sid) });
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
    }
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

// ── 自持能力：网络抓取 / todo 进度 / 模型池自省（向 ZCode/OpenCode 看齐） ──

let sessionTodos = []; // 会话内 todo 状态（switch_model/重建会话不跨保留）

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
    const lines = modelProfiles.map(
      (p) =>
        `${p.provider === currentModel ? "→" : " "} ${p.provider}${
          p.label ? `（${p.label}）` : ""
        }${p.baseUrl ? ` @ ${p.baseUrl}` : ""}`,
    );
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
      await session.setModel(resolveFromProfile(p));
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
      modelProfiles = Array.isArray(msg.profiles) ? msg.profiles : [];
      if (modelProfiles.length === 0) {
        deckEvent("error", {
          message: "模型池为空——请到设置面板添加并启用至少一个模型配置",
        });
        break;
      }

      // 模型自治：按启用顺序执行，失败（额度/认证/网络）自动降级到下一个配置
      let lastErr = null;
      let succeeded = false;
      for (let i = 0; i < modelProfiles.length; i++) {
        const p = modelProfiles[i];
        try {
          const s = await ensureSessionForProfile(p, {
            cwd: msg.cwd,
            mode: msg.mode === "approved" ? "approved" : "auto",
          });
          deckEvent("run_start", { model: p.provider });
          // 通用级运行规范：仅会话首轮注入（纪律只说一次）
          const promptText = firstRun
            ? buildUniversalPrompt(msg.cwd, msg.memories) + "\n\n==== 任务 ====\n" + msg.prompt
            : msg.prompt;
          await s.prompt(promptText);
          firstRun = false;
          succeeded = true;
          deckEvent("run_end");
          break;
        } catch (err) {
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
      if (!succeeded && lastErr) {
        deckEvent("error", {
          message: `所有已启用模型均失败：${String(lastErr?.message ?? lastErr)}`,
        });
      }
      break;
    }
    case "summarize": {
      // 会话压缩：把交接记录压成结构化简报（AI 交接的核心步骤）
      try {
        modelProfiles = Array.isArray(msg.profiles) ? msg.profiles : [];
        if (modelProfiles.length === 0) {
          throw new Error("模型池为空——请到设置面板添加并启用模型配置");
        }
        const p =
          modelProfiles.find((x) => x.provider === "glm") ?? modelProfiles[0];
        const s = await ensureSessionForProfile(p, {
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
            "要求：只输出简报本身，不要执行任务；保留具体路径、命令、参数；总长不超过 500 字。\n\n" +
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
      process.exit(0);
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
      try {
        await session?.abort?.();
      } catch {}
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
