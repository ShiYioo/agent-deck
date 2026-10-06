import { useState } from "react";

import { HARNESS_ACCENT } from "./Sidebar";
import {
  IconFolder,
  IconSend,
  IconPlus,
  IconChevronDown,
} from "./icons";

/** 底部输入卡：目录 chip + 多行输入 + harness/模式选择 + 圆形发送键。
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
      {/* 目录 chip */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <IconFolder size={15} className="shrink-0 text-stone-400" />
        <input
          value={cwd}
          onChange={(e) => onCwdChange(e.target.value)}
          placeholder="工作目录"
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

        {/* harness 选择：身份色信号点 + 自绘 chevron */}
        <SelectChip
          value={harness}
          onChange={onHarnessChange}
          dotColor={accent}
          options={[
            { value: "zcode", label: "ZCode · GLM" },
            { value: "codex", label: "Codex · GPT" },
          ]}
        />

        {harness === "zcode" && (
          <SelectChip
            value={mode}
            onChange={onModeChange}
            options={[
              { value: "yolo", label: "全自动" },
              { value: "build", label: "编辑前确认" },
              { value: "edit", label: "edit" },
              { value: "plan", label: "只读规划" },
            ]}
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

/** 极简 select：无边框、身份色信号点（可选）、自绘 chevron */
function SelectChip({
  value,
  onChange,
  options,
  dotColor,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  dotColor?: string;
}) {
  return (
    <label className="hover-lift relative flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-100">
      {dotColor && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer appearance-none bg-transparent pr-4 outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <IconChevronDown size={12} className="pointer-events-none absolute right-1.5 text-stone-400" />
    </label>
  );
}
