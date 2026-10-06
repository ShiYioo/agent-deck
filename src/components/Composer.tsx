import { useState } from "react";

/** 底部输入卡（对齐 Codex 的 composer）：
 *  目录 chip + 多行输入 + 模式选择 + 圆形发送键 */
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

  const send = () => {
    if (disabled || !text.trim()) return;
    onSend(text);
    setText("");
  };

  return (
    <div className="mx-auto w-full max-w-3xl rounded-2xl border border-zinc-200 bg-white shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
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
        rows={3}
        placeholder={placeholder ?? "随心输入"}
        disabled={disabled}
        className="w-full resize-none bg-transparent px-4 pt-3 text-sm text-zinc-800 outline-none placeholder:text-zinc-400 disabled:opacity-50"
      />

      <div className="flex items-center gap-2 px-3 pb-3">
        <button
          title="附加文件（开发中）"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
        >
          ＋
        </button>

        {/* harness 选择 */}
        <select
          value={harness}
          onChange={(e) => onHarnessChange(e.target.value)}
          className="cursor-pointer appearance-none rounded-lg px-2 py-1 text-xs text-zinc-600 outline-none hover:bg-zinc-100"
        >
          <option value="zcode">ZCode · GLM</option>
          <option value="codex">Codex · GPT</option>
        </select>

        {/* 权限模式（仅 zcode 暴露） */}
        {harness === "zcode" && (
          <select
            value={mode}
            onChange={(e) => onModeChange(e.target.value)}
            className="cursor-pointer appearance-none rounded-lg px-2 py-1 text-xs text-zinc-600 outline-none hover:bg-zinc-100"
          >
            <option value="yolo">⚡ 全自动</option>
            <option value="build">🛡 编辑前确认</option>
            <option value="edit">✏️ edit</option>
            <option value="plan">📋 plan</option>
          </select>
        )}

        <span className="flex-1" />

        <button
          onClick={send}
          disabled={disabled || !text.trim()}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-white transition-opacity hover:bg-zinc-700 disabled:opacity-30"
          title="发送（Enter）"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
