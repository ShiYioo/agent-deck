import { useMemo } from "react";

import { IconClose } from "./icons";

/** 轻量 diff 渲染：按 +/-/@@ 行着色，不引入 Monaco 重依赖 */
export function DiffModal({ text, onClose }: { text: string; onClose: () => void }) {
  const lines = useMemo(() => text.split("\n"), [text]);

  return (
    <div
      className="anim-backdrop fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 p-6"
      onClick={onClose}
    >
      <div
        className="anim-pop flex h-full w-full max-w-4xl flex-col rounded-xl border border-stone-200 bg-white shadow-[var(--shadow-2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2">
          <span className="text-sm font-medium">Git Diff</span>
          <button
            onClick={onClose}
            className="hover-lift rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            title="关闭"
          >
            <IconClose size={15} />
          </button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
          {lines.map((line, i) => {
            let cls = "text-stone-700";
            if (line.startsWith("+") && !line.startsWith("+++")) cls = "bg-emerald-50 text-emerald-700";
            else if (line.startsWith("-") && !line.startsWith("---")) cls = "bg-red-50 text-red-700";
            else if (line.startsWith("@@")) cls = "text-blue-600";
            else if (line.startsWith("diff ") || line.startsWith("index ")) cls = "text-stone-400";
            return (
              <div key={i} className={`px-2 ${cls}`}>
                {line || " "}
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}
