import { useMemo } from "react";

/** 轻量 diff 渲染：按 +/-/@@ 行着色，不引入 Monaco 重依赖 */
export function DiffModal({ text, onClose }: { text: string; onClose: () => void }) {
  const lines = useMemo(() => text.split("\n"), [text]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-4xl flex-col rounded-lg border border-zinc-700 bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-2">
          <span className="text-sm font-medium">Git Diff</span>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            关闭 ✕
          </button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
          {lines.map((line, i) => {
            let cls = "text-zinc-300";
            if (line.startsWith("+") && !line.startsWith("+++")) cls = "bg-emerald-950/60 text-emerald-300";
            else if (line.startsWith("-") && !line.startsWith("---")) cls = "bg-red-950/60 text-red-300";
            else if (line.startsWith("@@")) cls = "text-sky-400";
            else if (line.startsWith("diff ") || line.startsWith("index ")) cls = "text-zinc-500";
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
