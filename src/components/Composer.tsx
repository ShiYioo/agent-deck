import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { Play, Square, Plus, ShieldAlert, ShieldCheck, Paperclip, FileText, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { MotionLayer } from "../motion/MotionProvider";
import { useTextareaAutosize } from "../hooks/useTextareaAutosize";

import { HARNESS_ACCENT, projectName } from "./Sidebar";
import { discoverModels, inTauri, listModelProfiles, listProfileModels } from "../api";
import { IconFolder } from "./icons";
import { HarnessIcon } from "./HarnessIcon";
import { Dropdown } from "./Dropdown";

/** Shared composer; draft state survives chat switches and failed dispatches. */
export const Composer = memo(function Composer({
  cwd,
  onCwdChange,
  harness,
  onHarnessChange,
  mode,
  onModeChange,
  model,
  onModelChange,
  permission,
  onPermissionChange,
  projects,
  selectedProjectId,
  onProjectSelect,
  attachments,
  onAttach,
  onRemoveAttachment,
  onSend,
  running,
  recentModels = [],
  placeholder,
  draftKey,
  onStop,
  catalogVersion,
}: {
  cwd: string;
  onCwdChange: (v: string) => void;
  harness: string;
  onHarnessChange: (v: string) => void;
  mode: string;
  onModeChange: (v: string) => void;
  model: string;
  onModelChange: (v: string) => void;
  permission: string;
  onPermissionChange: (v: string) => void;
  projects: { id: string; name: string; dir: string }[];
  selectedProjectId: string | null;
  onProjectSelect: (id: string | null, dir: string) => void;
  attachments: string[];
  onAttach: (paths: string[]) => void;
  onRemoveAttachment: (path: string) => void;
  onSend: (text: string) => Promise<boolean>;
  draftKey: string;
  onStop: () => void;
  catalogVersion: boolean;
  /** 任务运行中：发送将入队而非直接派发 */
  running?: boolean;
  /** 历史常用模型（按频次），动态列表按此置顶排序 */
  recentModels?: string[];
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const drafts = useRef(new Map<string, string>());
  // 附件：附加按钮选入，chips 展示可移除；发送后清空由父级负责
  const pickAttachments = async () => {
    const picked = await open({ multiple: true, title: "选择附件（图片/文件）" });
    if (Array.isArray(picked) && picked.length) onAttach(picked);
    else if (typeof picked === "string") onAttach([picked]);
  };
  const currentDraftKey = useRef(draftKey);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectPopupRef = useRef<HTMLDivElement>(null);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const [projectPosition, setProjectPosition] = useState({ left: 12, top: 12, width: 360, maxHeight: 320 });
  useEffect(() => {
    currentDraftKey.current = draftKey;
    setText(drafts.current.get(draftKey) ?? "");
    setMention(null);
    setProjMenuOpen(false);
  }, [draftKey]);
  // 项目菜单开关 + 当前生效项目（cwd 匹配或显式选择）
  const [projMenuOpen, setProjMenuOpen] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  useEffect(() => {
    if (!projMenuOpen) return;
    const dismiss = (e: PointerEvent) => {
      if (!projectMenuRef.current?.contains(e.target as Node) && !projectPopupRef.current?.contains(e.target as Node)) setProjMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setProjMenuOpen(false);
        projectTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [projMenuOpen]);
  useLayoutEffect(() => {
    if (!projMenuOpen) return;
    const position = () => {
      const rect = projectTriggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const minTop = (document.querySelector(".titlebar")?.getBoundingClientRect().bottom ?? 0) + 12;
      const width = Math.min(360, window.innerWidth - 24);
      const above = Math.max(0, rect.top - minTop - 6);
      const below = Math.max(0, window.innerHeight - rect.bottom - 18);
      const useAbove = above >= below;
      const maxHeight = Math.min(320, useAbove ? above : below);
      const height = Math.min(projectPopupRef.current?.scrollHeight ?? 320, maxHeight);
      setProjectPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: useAbove ? Math.max(minTop, rect.top - height - 6) : rect.bottom + 6,
        width, maxHeight,
      });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [projMenuOpen, projects.length]);
  const activeProject = useMemo(() => {
    if (selectedProjectId) {
      return projects.find((x) => x.id === selectedProjectId) ?? null;
    }
    if (cwd) {
      const norm = (s: string) => s.split("\\").join("/").replace(/\/$/, "").toLowerCase();
      return projects.find((x) => norm(x.dir) === norm(cwd)) ?? null;
    }
    return null;
  }, [projects, selectedProjectId, cwd]);

  // @ 提及补全（两段式）：输入 @ 选智能体 → 自动补 ":" 进入模型段选具体模型
  const [mention, setMention] = useState<
    | { kind: "agent"; start: number; query: string }
    | { kind: "model"; start: number; agent: string; query: string }
    | null
  >(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useTextareaAutosize(textareaRef, text);

  const MENTION_AGENTS = [
    { name: "deck", label: "AgentDeck Agent", desc: "自有运行时 · 可接 :模型池模型" },
    { name: "zcode", label: "ZCode · GLM", desc: "可接 :provider/model（切换默认模型）" },
    { name: "codex", label: "Codex · GPT", desc: "可接 :模型名" },
    { name: "opencode", label: "OpenCode", desc: "可接 :provider/model" },
  ];

  const modelOptionsFor = (agent: string): string[] => {
    if (agent === "deck") return deckOptions.map((o) => o.value);
    if (agent === "zcode") return modelOptionsBy.zcode ?? [];
    const discoveredModels = modelOptionsBy[agent] ?? [];
    if (discoveredModels.length) return discoveredModels;
    return (MODEL_CATALOG[agent] ?? []).map((o) => o.value).filter(Boolean);
  };

  const refreshMention = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? 0;
    const before = el.value.slice(0, pos);
    const m = /@([a-z0-9_-]*)(?::([^@\s]*))?$/i.exec(before);
    if (!m) {
      setMention(null);
      return;
    }
    const agent = m[1].toLowerCase();
    if (m[2] !== undefined) {
      // ":后缀" 阶段：必须是已知智能体才有模型列表
      if (!MENTION_AGENTS.some((a) => a.name === agent)) {
        setMention(null);
        return;
      }
      setMention({
        kind: "model",
        start: pos - m[0].length,
        agent,
        query: m[2],
      });
    } else if (agent === "") {
      // 刚输入 @：agent 阶段，列出全部
      setMention({ kind: "agent", start: pos - m[0].length, query: "" });
    } else if (MENTION_AGENTS.some((a) => a.name.startsWith(agent))) {
      setMention({ kind: "agent", start: pos - m[0].length, query: agent });
    } else {
      setMention(null);
    }
    setMentionIdx(0);
  };

  const applyAgent = (name: string) => {
    const el = textareaRef.current;
    if (!el || !mention || mention.kind !== "agent") return;
    const pos = el.selectionStart ?? el.value.length;
    const insert = `@${name}:`;
    const next = el.value.slice(0, mention.start) + insert + el.value.slice(pos);
    setText(next);
    drafts.current.set(draftKey, next);
    setMention({ kind: "model", start: mention.start, agent: name, query: "" });
    requestAnimationFrame(() => {
      el.focus();
      const caret = mention.start + insert.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const applyModel = (model: string) => {
    const el = textareaRef.current;
    if (!el || !mention || mention.kind !== "model") return;
    const pos = el.selectionStart ?? el.value.length;
    const insert = model ? `@${mention.agent}:${model} ` : `@${mention.agent} `;
    const next = el.value.slice(0, mention.start) + insert + el.value.slice(pos);
    setText(next);
    drafts.current.set(draftKey, next);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      const caret = mention.start + insert.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const send = async () => {
    if (!text.trim() || sending) return;
    const key = draftKey;
    const submitted = text;
    setSending(true);
    try {
      if (await onSend(submitted)) {
        if (drafts.current.get(key) === submitted) drafts.current.delete(key);
        if (currentDraftKey.current === key) setText((value) => value === submitted ? "" : value);
        setMention(null);
      }
    } finally {
      setSending(false);
    }
  };

  const accent = HARNESS_ACCENT[harness] ?? "var(--text-3)";

  // 动态发现真实模型列表（codex 读 desktop 状态文件、opencode 调 CLI）；
  // 失败或为空则回退静态目录
  const [modelOptionsBy, setModelOptionsBy] = useState<Record<string, string[]>>({});
  const requestedHarness = mention?.kind === "model" ? mention.agent : harness;
  const discovered = modelOptionsBy[harness] ?? [];
  useEffect(() => {
    if (requestedHarness !== "codex" && requestedHarness !== "opencode" && requestedHarness !== "zcode") return;
    let alive = true;
    discoverModels(requestedHarness)
      .then((list) => {
        if (alive) setModelOptionsBy((prev) => ({ ...prev, [requestedHarness]: list }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [requestedHarness]);

  // deck 模型目录：模型池里启用档案的模型列表（value = "<profileId>:<modelId>"，
  // 无目录的档案暴露其默认模型），下拉与 @deck: 提及共用
  const [deckOptions, setDeckOptions] = useState<{ value: string; label: string; group: string }[]>([]);
  useEffect(() => {
    if (!inTauri || requestedHarness !== "deck" || catalogVersion) return;
    let alive = true;
    (async () => {
      try {
        const profiles = await listModelProfiles();
        const out: { value: string; label: string; group: string }[] = [];
        const enabled = profiles.filter((x) => x.enabled);
        const catalogs = await Promise.all(enabled.map((p) => listProfileModels(p.id).catch(() => [])));
        for (const [index, p] of enabled.entries()) {
          const group = p.label || p.provider;
          const rows = catalogs[index];
          if (rows.length > 0) {
            for (const r of rows) {
              out.push({ value: `${p.id}:${r.model}`, label: r.model, group });
            }
          } else {
            const fallback = p.model ?? (p.provider === "glm" ? "glm-4.7" : "gpt-5.1");
            out.push({ value: `${p.id}:${fallback}`, label: fallback, group });
          }
        }
        if (alive) setDeckOptions(out);
      } catch {
        /* 模型池不可用：保持空目录（deck 走全链自治） */
      }
    })();
    return () => {
      alive = false;
    };
  }, [requestedHarness, catalogVersion]);

  /** 各 harness 的权限模式目录（mode 字段按 harness 有不同取值） */
  const MODE_CATALOG: Record<string, { value: string; label: string }[]> = {
    zcode: [
      { value: "yolo", label: "完全访问" },
      { value: "build", label: "编辑前确认" },
      { value: "edit", label: "允许编辑" },
      { value: "plan", label: "只读规划" },
    ],
    codex: [
      { value: "full", label: "完全访问" },
      { value: "write", label: "沙箱内写入" },
      { value: "readonly", label: "只读" },
    ],
    opencode: [
      { value: "default", label: "完全访问" },
      { value: "plan", label: "只读规划（plan）" },
    ],
  };

  /** 各 harness 的模型目录（"" = 走 CLI 账号默认模型） */
  const MODEL_CATALOG: Record<string, { value: string; label: string }[]> = {
    codex: [
      { value: "", label: "默认模型" },
      { value: "gpt-5.1-codex", label: "gpt-5.1-codex" },
      { value: "gpt-5.1", label: "gpt-5.1" },
      { value: "o4-mini", label: "o4-mini" },
    ],
    opencode: [
      { value: "", label: "默认模型" },
      { value: "anthropic/claude-sonnet-4-5", label: "claude-sonnet-4.5" },
      { value: "openai/gpt-5.1", label: "gpt-5.1" },
      { value: "zai-coding-plan/glm-4.6", label: "glm-4.6" },
    ],
  };

  return (
    <div className="composer-card">
      {attachments.length > 0 && (
        <div className="composer-attachments" role="list" aria-label="附件">
          {attachments.map((a) => (
            <span key={a} className="composer-attachment-chip" role="listitem" title={a}>
              <FileText size={12} className="shrink-0 text-stone-400" />
              <span className="min-w-0 max-w-48 truncate">{a.split(/[\/]/).pop()}</span>
              <button
                onClick={() => onRemoveAttachment(a)}
                aria-label={`移除附件 ${a.split(/[\/]/).pop()}`}
                className="shrink-0 text-stone-400 hover:text-red-500"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* 项目/目录行：未选 → 整行安静「选择项目」；已选 → chip 显示名称 */}
      <div ref={projectMenuRef} className="composer-project-row">
        <button
          ref={projectTriggerRef}
          onClick={() => setProjMenuOpen((v) => !v)}
          className="composer-project-button"
          title={cwd || "选择项目"}
          aria-expanded={projMenuOpen}
          aria-haspopup="dialog"
          aria-label="选择项目"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setProjMenuOpen(true);
              requestAnimationFrame(() => projectPopupRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
            }
          }}
        >
          <Plus size={20} />
          <span className="sr-only">{activeProject?.name ?? projectName(cwd)}</span>
        </button>
        <button
          onClick={pickAttachments}
          className="composer-attach-button"
          title="附加文件/图片"
          aria-label="附加文件"
        >
          <Paperclip size={17} />
        </button>

        {createPortal(<AnimatePresence>
        {projMenuOpen && (
          <MotionLayer ref={projectPopupRef} preset="menu" role="dialog" aria-label="选择项目" className="project-menu" style={projectPosition}
            onKeyDown={(e) => {
              if (e.target instanceof HTMLInputElement || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
              const buttons = Array.from(projectPopupRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
              if (!buttons.length) return;
              e.preventDefault();
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next].focus();
            }}>
            <div className="border-b border-stone-100 px-3 py-1.5 text-[10px] text-stone-400">
              项目
            </div>
            {projects.map((pj) => (
              <button
                key={pj.id}
                onClick={() => {
                  onProjectSelect(pj.id, pj.dir);
                  onCwdChange(pj.dir);
                   setProjMenuOpen(false);
                   projectTriggerRef.current?.focus();
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                  activeProject?.id === pj.id
                    ? "bg-stone-100 font-medium text-stone-900"
                    : "text-stone-600 hover:bg-stone-50"
                }`}
              >
                <IconFolder size={13} className="shrink-0 text-stone-400" />
                <span className="min-w-0 flex-1 truncate">{pj.name}</span>
                <span className="max-w-40 truncate font-mono text-[10px] text-stone-400" title={pj.dir}>
                  {pj.dir}
                </span>
              </button>
            ))}
            <label className="directory-field">
              <span>工作目录</span>
              <input aria-label="工作目录" value={cwd} placeholder="输入文件夹路径"
                onChange={(e) => { onProjectSelect(null, ""); onCwdChange(e.target.value); }} />
            </label>
            <button
              disabled={!inTauri}
              onClick={async () => {
                if (!inTauri) {
                  setProjMenuOpen(false);
                  return;
                }
                try {
                  const picked = await open({ directory: true, multiple: false });
                  if (typeof picked === "string") {
                    onCwdChange(picked);
                    onProjectSelect(null, "");
                  }
                  setProjectError(null);
                  setProjMenuOpen(false);
                  projectTriggerRef.current?.focus();
                } catch (error) {
                  setProjectError(String(error));
                }
              }}
              className="flex w-full items-center gap-2 border-t border-stone-100 px-3 py-2 text-left text-xs text-stone-500 transition-colors hover:bg-stone-50 disabled:opacity-40"
            >
              <IconFolder size={13} className="shrink-0 text-stone-400" />
              浏览文件夹…
            </button>
            {projectError && <div className="px-3 py-2 text-xs text-red-600" role="alert">{projectError}</div>}
          </MotionLayer>
        )}
        </AnimatePresence>, document.body)}
      </div>

      <div className="relative">
        {/* @ 智能体补全（两段式）：@ 选智能体 → : 选模型 */}
        <AnimatePresence>
        {mention && (
          <MotionLayer preset="menu" className="mention-menu absolute bottom-full left-4 right-4 z-20 mb-1 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[var(--shadow-2)]">
            <div className="border-b border-stone-100 px-3 py-1.5 text-[10px] text-stone-400">
              {mention.kind === "model"
                 ? `${mention.agent} 的模型`
                 : "智能体"}
            </div>
            {mention.kind === "agent" &&
              MENTION_AGENTS.filter(
                (a) =>
                  a.name.includes(mention.query.toLowerCase()) ||
                  a.label.toLowerCase().includes(mention.query.toLowerCase()),
              )
                .map((a, i) => (
                  <button
                    key={a.name}
                    onClick={() => applyAgent(a.name)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                      i === mentionIdx
                        ? "bg-stone-100 text-stone-900"
                        : "text-stone-600 hover:bg-stone-50"
                    }`}
                  >
                    <HarnessIcon harness={a.name} size={13} rounded />
                    <span className="font-medium">@{a.name}</span>
                    <span className="text-stone-400">{a.label}</span>
                    <span className="ml-auto text-[10px] text-stone-400">{a.desc}</span>
                  </button>
                ))}
            {mention.kind === "model" && (
              <>
                {modelOptionsFor(mention.agent).length === 0 && (
                  <div className="px-3 py-2 text-xs text-stone-400">
                    {mention.agent === "zcode"
                      ? "ZCode 走账号默认模型，无需指定"
                      : "暂无模型列表"}
                  </div>
                )}
                 {modelOptionsFor(mention.agent).filter((m) => m.toLowerCase().includes(mention.query.toLowerCase())).map((m, i) => (
                  <button
                    key={m}
                    onClick={() => applyModel(m)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs transition-colors ${
                      i === mentionIdx
                        ? "bg-stone-100 text-stone-900"
                        : "text-stone-600 hover:bg-stone-50"
                    }`}
                  >
                    {m || "（默认模型）"}
                  </button>
                ))}
              </>
            )}
          </MotionLayer>
        )}
        </AnimatePresence>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            drafts.current.set(draftKey, e.target.value);
            refreshMention(e.target);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (mention) {
              const stageOptions =
                mention.kind === "agent"
                   ? MENTION_AGENTS.filter((a) => a.name.includes(mention.query.toLowerCase()) || a.label.toLowerCase().includes(mention.query.toLowerCase()))
                  : modelOptionsFor(mention.agent).map((m) => ({ name: m, label: m }));
              const visible = mention.kind === "model"
                ? stageOptions.filter((o) =>
                    o.name
                      .toLowerCase()
                      .includes(mention.query.toLowerCase()),
                  )
                : stageOptions;
              if (e.key === "ArrowDown" || e.key === "Tab") {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % Math.max(visible.length, 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx(
                  (i) => (i - 1 + visible.length) % Math.max(visible.length, 1),
                );
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const pick = visible[mentionIdx % Math.max(visible.length, 1)];
                if (pick) {
                  if (mention.kind === "agent") applyAgent(pick.name);
                  else applyModel(pick.name);
                }
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
           rows={1}
           aria-label="消息"
          placeholder={placeholder ?? "随心输入"}
           className="composer-input"
        />
      </div>

       <div className="composer-toolbar">
        {/* harness 下拉：身份色信号点 */}
        <div className="composer-agent-control">
        <Dropdown
          value={harness}
          onChange={onHarnessChange}
          dotColor={accent}
          options={[
            { value: "deck", label: "AgentDeck Agent" },
            { value: "zcode", label: "ZCode · GLM" },
            { value: "codex", label: "Codex · GPT" },
            { value: "opencode", label: "OpenCode" },
          ]}
          title="选择 harness"
          displayLabel={harness === "deck" ? "AgentDeck" : harness === "codex" ? "Codex" : harness === "zcode" ? "ZCode" : "OpenCode"}
        />
        </div>

        {/* codex/opencode/deck：模型选择（zcode CLI 未暴露模型旗标，走账号默认） */}
        {(MODEL_CATALOG[harness] || harness === "deck" || (harness === "zcode" && (modelOptionsBy.zcode?.length ?? 0) > 0)) && (
          <div className="composer-model-control"><Dropdown
            value={model}
            onChange={onModelChange}
            options={[
              { value: "", label: harness === "deck" ? "模型池默认（自动降级）" : "默认模型" },
              ...(harness === "deck"
                ? deckOptions.map((o) => ({
                    value: o.value,
                    label: `${o.group} · ${o.label}`,
                    group: o.group,
                  }))
                : discovered.length
                  ? discovered
                      .map((m) => ({
                        value: m,
                        label: m,
                        // opencode 的 free 模型（如 -free 后缀）标注免费徽章
                        tag: /free/i.test(m) ? "免费" : undefined,
                      }))
                      // 常用置顶（按历史使用频次）
                      .sort(
                        (a, b) =>
                           (recentModels.indexOf(a.value) < 0 ? 999 : recentModels.indexOf(a.value)) -
                           (recentModels.indexOf(b.value) < 0 ? 999 : recentModels.indexOf(b.value)),
                      )
                  : MODEL_CATALOG[harness].filter((o) => o.value !== "")),
            ]}
            searchable
            groupBy={
              harness === "deck"
                ? (value) => deckOptions.find((o) => o.value === value)?.group ?? "其他"
                : harness === "opencode"
                  ? (value) => (value.includes("/") ? value.split("/")[0] : "默认")
                  : undefined
            }
            title="模型"
          /></div>
        )}

        {/* 权限模式：zcode/codex/opencode 各自目录 */}
        {MODE_CATALOG[harness] && (
          <div className={`composer-permission-control ${["yolo", "full", "default"].includes(mode) ? "is-elevated" : ""}`}><Dropdown
            value={mode}
            onChange={onModeChange}
            options={MODE_CATALOG[harness]}
            title="权限模式"
            icon={["yolo", "full", "default"].includes(mode) ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
          /></div>
        )}

        {/* deck 运行时：工具审批开关（approved = 执行前经 UI 审批） */}
        {harness === "deck" && (
          <div className={`composer-permission-control ${permission === "auto" ? "is-elevated" : ""}`}><Dropdown
            value={permission}
            onChange={onPermissionChange}
            options={[
              { value: "auto", label: "工具免审批" },
              { value: "approved", label: "工具需审批" },
            ]}
            title="工具审批"
            icon={permission === "auto" ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
          /></div>
        )}

        {running && (
          <span className="typing-dots mr-1 flex items-center" aria-label="运行中">
            <span />
            <span />
            <span />
          </span>
        )}

        <button
           onClick={() => running && !text.trim() ? onStop() : void send()}
           disabled={sending || (!running && !text.trim())}
           className="send-button"
           title={running && !text.trim() ? "停止" : running ? "加入队列" : "发送"}
           aria-label={running && !text.trim() ? "停止" : running ? "加入队列" : "发送"}
         >
           {running && !text.trim() ? <Square size={12} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        </button>
      </div>

    </div>
  );
});
