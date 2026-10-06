import { useEffect, useMemo } from "react";

import { IconClose } from "./icons";
import { HarnessIcon } from "./HarnessIcon";

/** 从 diff 文本统计规模：+/- 行数与涉及文件数 */
function diffStats(text: string) {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed, files };
}

/** 轻量 diff 渲染：按 +/-/@@ 行着色，不引入 Monaco 重依赖。
 *  头部标注改动归属（哪个 harness 的哪个模型改的）；
 *  running 时每 POLL_MS 触发一次 onRefresh（实时跟随 harness 改动）。 */
const POLL_MS = 2000;

export function DiffModal({
  text,
  onClose,
  onRefresh,
  running = false,
  harness,
  model,
  mode,
}: {
  text: string;
  onClose: () => void;
  /** 重新拉取当前任务 diff（running 时由弹层定时调用） */
  onRefresh?: () => void;
  /** 任务是否运行中（决定实时轮询与徽章） */
  running?: boolean;
  harness?: string;
  model?: string | null;
  mode?: string | null;
}) {
  // deck 运行时的模型选择存在 mode 字段（glm/gpt）
  const modelLabel =
    model ?? (harness === "deck" && mode ? mode.toUpperCase() : null);
  const lines = useMemo(() => text.split("\n"), [text]);
  const stats = useMemo(() => diffStats(text), [text]);

  // 实时跟随：任务运行中每 2s 重拉一次
  useEffect(() => {
    if (!running || !onRefresh) return;
    const id = setInterval(onRefresh, POLL_MS);
    return () => clearInterval(id);
  }, [running, onRefresh]);

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
          <div className="flex items-center gap-2 text-sm font-medium">
            <span>Git Diff</span>
            {harness && (
              <span className="flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-normal text-stone-600">
                <HarnessIcon harness={harness} size={13} rounded />
                {harness}
                {modelLabel && (
                  <span className="font-mono text-[10px] text-stone-400">
                    · {modelLabel}
                  </span>
                )}
                <span className="text-stone-300">改动</span>
              </span>
            )}
            {running && (
              <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">
                <span className="pulse-dot h-1.5 w-1.5 rounded-full" />
                实时
              </span>
            )}
            <span className="font-mono text-[10px] text-zinc-400">
              +{stats.added} −{stats.removed} · {stats.files} 文件
            </span>
          </div>
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
