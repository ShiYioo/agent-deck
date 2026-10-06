import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { HARNESS_ACCENT } from "./Sidebar";
import { discoverModels, inTauri } from "../api";
import { IconFolder, IconSend, IconPlus } from "./icons";
import { Dropdown } from "./Dropdown";

/** 底部输入卡：目录 chip + 多行输入 + harness/模式下拉 + 圆形发送键。
 *  聚焦时边框深化、阴影抬升、底部品牌色细线渐显。 */
export function Composer({
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
  disabled,
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
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);

  const send = () => {
    if (disabled || !text.trim()) return;
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

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        rows={3}
        placeholder={placeholder ?? "随心输入"}
        disabled={disabled}
        className="w-full resize-none bg-transparent px-4 pt-3 text-sm text-stone-800 outline-none placeholder:text-stone-400 disabled:opacity-50"
      />

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

        {/* deck 执行器：选底层模型（GLM/GPT 经 pi 运行时） */}
        {harness === "deck" && (
          <Dropdown
            value={mode === "gpt" ? "gpt" : "glm"}
            onChange={onModeChange}
            options={[
              { value: "glm", label: "GLM" },
              { value: "gpt", label: "GPT" },
            ]}
            title="底层模型"
          />
        )}

        {/* codex/opencode：模型选择（zcode CLI 未暴露模型旗标，走账号默认） */}
        {MODEL_CATALOG[harness] && (
          <Dropdown
            value={model}
            onChange={onModelChange}
            options={[
              { value: "", label: "默认模型" },
              ...(discovered.length
                ? discovered.map((m) => ({ value: m, label: m }))
                : MODEL_CATALOG[harness]),
            ]}
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

        {disabled && (
          <span className="typing-dots mr-1 flex items-center" aria-label="运行中">
            <span />
            <span />
            <span />
          </span>
        )}

        <button
          onClick={send}
          disabled={disabled || !text.trim()}
          className="hover-lift flex h-9 w-9 items-center justify-center rounded-full text-white disabled:opacity-30"
          style={{ backgroundColor: text.trim() && !disabled ? accent : "#a8a29e" }}
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
}
