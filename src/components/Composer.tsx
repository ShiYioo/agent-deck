import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { HARNESS_ACCENT } from "./Sidebar";
import { inTauri } from "../api";
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

        {harness === "zcode" && (
          <Dropdown
            value={mode}
            onChange={onModeChange}
            options={[
              { value: "yolo", label: "全自动" },
              { value: "build", label: "编辑前确认" },
              { value: "edit", label: "edit" },
              { value: "plan", label: "只读规划" },
            ]}
            title="权限模式"
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
