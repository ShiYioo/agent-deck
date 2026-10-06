import { useState } from "react";

import { HARNESS_ACCENT } from "./Sidebar";

/** 底部输入卡（对齐 Codex 的 composer）：
 *  目录 chip + 多行输入 + harness/模式选择 + 圆形发送键。
 *  带聚焦抬升阴影与发送键微动效。 */
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
    <div className="composer-card mx-auto w-full max-w-3xl rounded-2xl border border-zinc-200 bg-white shadow-[var(--shadow-1)] focus-within:border-zinc-300">
      {/* 目录 chip：新任务时可直接编辑 */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className="text-zinc-400">📁</span>
        <input
          value={cwd}
          onChange={(e) => onCwdChange(e.target.value)}
          placeholder="工作目录"
          className="min-w-0 flex-1 rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-600 outline-none placeholder:text-zinc-400 focus:bg-zinc-100 focus:ring-1 focus:ring-zinc-300"
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
        className="w-full resize-none bg-transparent px-4 pt-3 text-sm text-zinc-800 outline-none placeholder:text-zinc-400 disabled:opacity-50"
      />

      <div className="flex items-center gap-1.5 px-3 pb-3">
        <button
          title="附加文件（开发中）"
          className="hover-lift flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>

        {/* harness 选择：文字前带身份色信号点 */}
        <select
          value={harness}
          onChange={(e) => onHarnessChange(e.target.value)}
          className="hover-lift cursor-pointer appearance-none rounded-lg px-2 py-1 text-xs text-zinc-600 outline-none hover:bg-zinc-100"
        >
          <option value="zcode">● ZCode · GLM</option>
          <option value="codex">● Codex · GPT</option>
        </select>

        {/* 权限模式（仅 zcode 暴露） */}
        {harness === "zcode" && (
          <select
            value={mode}
            onChange={(e) => onModeChange(e.target.value)}
            className="hover-lift cursor-pointer appearance-none rounded-lg px-2 py-1 text-xs text-zinc-600 outline-none hover:bg-zinc-100"
          >
            <option value="yolo">⚡ 全自动</option>
            <option value="build">🛡 编辑前确认</option>
            <option value="edit">✏️ edit</option>
            <option value="plan">📋 plan</option>
          </select>
        )}

        <span className="flex-1" />

        {/* 运行中显示三点打字指示 */}
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
          style={{ backgroundColor: text.trim() && !disabled ? accent : "#a1a1aa" }}
          title="发送（Enter）"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>

      {/* 聚焦时顶部细线渐显（品牌信号色），加强聚焦反馈 */}
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
