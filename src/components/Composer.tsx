import { memo, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { HARNESS_ACCENT } from "./Sidebar";
import { discoverModels, inTauri } from "../api";
import { IconFolder, IconSend, IconPlus } from "./icons";
import { HarnessIcon } from "./HarnessIcon";
import { Dropdown } from "./Dropdown";

/** 底部输入卡：目录 chip + 多行输入 + harness/模式下拉 + 圆形发送键。
 *  聚焦时边框深化、阴影抬升、底部品牌色细线渐显。 */
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
  onSend,
  running,
  recentModels = [],
  placeholder,
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
  onSend: (text: string) => void;
  /** 任务运行中：发送将入队而非直接派发 */
  running?: boolean;
  /** 历史常用模型（按频次），动态列表按此置顶排序 */
  recentModels?: string[];
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  // @ 提及补全：光标前 @xxx 模式即弹出（mention.query 为 @ 后已输入部分）
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const MENTION_AGENTS = [
    { name: "deck", label: "AgentDeck Agent", desc: "自有运行时" },
    { name: "zcode", label: "ZCode · GLM", desc: "模型走账号默认" },
    { name: "codex", label: "Codex · GPT", desc: "可接 :模型名" },
    { name: "opencode", label: "OpenCode", desc: "可接 :provider/model" },
  ];

  const refreshMention = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? 0;
    const before = el.value.slice(0, pos);
    const m = /@([a-z0-9:_-]*)$/i.exec(before);
    if (m) {
      setMention({ start: pos - m[0].length, query: m[1] });
      setMentionIdx(0);
    } else {
      setMention(null);
    }
  };

  const applyMention = (name: string) => {
    const el = textareaRef.current;
    if (!el || !mention) return;
    const pos = el.selectionStart ?? el.value.length;
    const insert = `@${name} `;
    const next = el.value.slice(0, mention.start) + insert + el.value.slice(pos);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      const caret = mention.start + insert.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const send = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  };

  const accent = HARNESS_ACCENT[harness] ?? "var(--text-3)";

  // 动态发现真实模型列表（codex 读 desktop 状态文件、opencode 调 CLI）；
  // 失败或为空则回退静态目录
  const [discovered, setDiscovered] = useState<string[]>([]);
  useEffect(() => {
    if (!MODEL_CATALOG[harness]) {
      setDiscovered([]);
      return;
    }
    let alive = true;
    discoverModels(harness)
      .then((models) => alive && setDiscovered(models))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [harness]);

  /** 各 harness 的权限模式目录（mode 字段按 harness 有不同取值） */
  const MODE_CATALOG: Record<string, { value: string; label: string }[]> = {
    zcode: [
      { value: "yolo", label: "全自动" },
      { value: "build", label: "编辑前确认" },
      { value: "edit", label: "edit" },
      { value: "plan", label: "只读规划" },
    ],
    codex: [
      { value: "full", label: "全自动（无沙箱）" },
      { value: "write", label: "沙箱内写入" },
      { value: "readonly", label: "只读" },
    ],
    opencode: [
      { value: "default", label: "全部权限（build）" },
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
    <div className="composer-card mx-auto w-full max-w-3xl rounded-2xl border border-stone-200 bg-white shadow-[var(--shadow-1)] focus-within:border-stone-300">
      {/* 目录 chip：点击文件夹图标弹出系统选择器，也可直接手输 */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <button
          onClick={async () => {
            if (!inTauri) {
              onCwdChange("（桌面应用内可选择文件夹）");
              return;
            }
            const picked = await open({ directory: true, multiple: false });
            if (typeof picked === "string") onCwdChange(picked);
          }}
          title="选择文件夹"
          className="hover-lift shrink-0 rounded p-0.5 text-stone-400 hover:text-stone-700"
        >
          <IconFolder size={15} />
        </button>
        <input
          value={cwd}
          onChange={(e) => onCwdChange(e.target.value)}
          placeholder="工作目录（点击左侧文件夹选择，或留空使用默认目录）"
          className="min-w-0 flex-1 rounded-md bg-stone-100 px-2 py-1 text-xs text-stone-600 outline-none placeholder:text-stone-400 focus:ring-1 focus:ring-stone-300"
        />
      </div>

      <div className="relative">
        {/* @ 智能体补全：输入 @ 时向上弹出的提及菜单 */}
        {mention && (
          <div className="absolute bottom-full left-4 right-4 z-20 mb-1 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[var(--shadow-2)]">
            <div className="border-b border-stone-100 px-3 py-1.5 text-[10px] text-stone-400">
              唤醒智能体 · @codex:模型名 可指定模型
            </div>
            {MENTION_AGENTS.filter(
                (a) =>
                  a.name.includes(mention.query.toLowerCase()) ||
                  a.label.toLowerCase().includes(mention.query.toLowerCase()),
              )
              .map((a, i) => (
                <button
                  key={a.name}
                  onClick={() => applyMention(a.name)}
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
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            refreshMention(e.target);
          }}
          onKeyDown={(e) => {
            if (mention) {
              if (e.key === "ArrowDown" || e.key === "Tab") {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % MENTION_AGENTS.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx(
                  (i) => (i - 1 + MENTION_AGENTS.length) % MENTION_AGENTS.length,
                );
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const hit = MENTION_AGENTS.filter(
                  (a) =>
                    a.name.includes(mention.query.toLowerCase()) ||
                    a.label.toLowerCase().includes(mention.query.toLowerCase()),
                );
                const pick = hit[mentionIdx % Math.max(hit.length, 1)] ?? hit[0];
                if (pick) applyMention(pick.name);
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
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={3}
          placeholder={placeholder ?? "随心输入"}
          className="w-full resize-none bg-transparent px-4 pt-3 text-sm text-stone-800 outline-none placeholder:text-stone-400 disabled:opacity-50"
        />
      </div>

      <div className="flex items-center gap-1.5 px-3 pb-3">
        <button
          title="附加文件（开发中）"
          className="hover-lift flex h-8 w-8 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600"
        >
          <IconPlus size={15} />
        </button>

        {/* harness 下拉：身份色信号点 */}
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
        />

        {/* codex/opencode：模型选择（zcode CLI 未暴露模型旗标，走账号默认） */}
        {MODEL_CATALOG[harness] && (
          <Dropdown
            value={model}
            onChange={onModelChange}
            options={[
              { value: "", label: "默认模型" },
              ...(discovered.length
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
                        (recentModels.indexOf(b.value) + 1 || 999) -
                        (recentModels.indexOf(a.value) + 1 || 999),
                    )
                : MODEL_CATALOG[harness].filter((o) => o.value !== "")),
            ]}
            searchable
            groupBy={
              harness === "opencode"
                ? (value) => (value.includes("/") ? value.split("/")[0] : "默认")
                : undefined
            }
            title="模型"
          />
        )}

        {/* 权限模式：zcode/codex/opencode 各自目录 */}
        {MODE_CATALOG[harness] && (
          <Dropdown
            value={mode}
            onChange={onModeChange}
            options={MODE_CATALOG[harness]}
            title="权限模式"
          />
        )}

        {/* deck 运行时：工具审批开关（approved = 执行前经 UI 审批） */}
        {harness === "deck" && (
          <Dropdown
            value={permission}
            onChange={onPermissionChange}
            options={[
              { value: "auto", label: "工具免审批" },
              { value: "approved", label: "工具需审批" },
            ]}
            title="工具审批"
          />
        )}

        <span className="flex-1" />

        {running && (
          <span className="typing-dots mr-1 flex items-center" aria-label="运行中">
            <span />
            <span />
            <span />
          </span>
        )}

        <button
          onClick={send}
          disabled={!text.trim()}
          className="hover-lift flex h-9 w-9 items-center justify-center rounded-full text-white disabled:opacity-30"
          style={{ backgroundColor: text.trim() ? accent : "#a8a29e" }}
          title="发送（Enter）"
        >
          <IconSend size={16} />
        </button>
      </div>

      {/* 聚焦时底部品牌色细线渐显 */}
      <div
        className="pointer-events-none mx-4 h-px transition-opacity duration-200"
        style={{
          background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          opacity: focused ? 1 : 0,
        }}
      />
    </div>
  );
});
