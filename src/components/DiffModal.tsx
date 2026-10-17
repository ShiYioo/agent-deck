import { useEffect, useMemo } from "react";
import { useIsPresent } from "motion/react";
import { MotionLayer } from "../motion/MotionProvider";
import { useDialogFocus } from "../hooks/useDialogFocus";

import { IconClose } from "./icons";
import { HarnessIcon } from "./HarnessIcon";
import { FileLines } from "./FileLines";

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

/** Virtualized workspace patch. Task metadata is context, not proof of authorship. */
export function DiffModal({
  text,
  onClose,
  running = false,
  harness,
  model,
}: {
  text: string;
  onClose: () => void;
  /** 任务是否运行中（watcher 推流时显示实时徽章） */
  running?: boolean;
  harness?: string;
  model?: string | null;
  mode?: string | null;
}) {
  const modelLabel = model ?? "模型未报告";
  const present = useIsPresent();
  const dialogRef = useDialogFocus(present);
  // Esc 关闭（标准弹层键盘预期）
  useEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, present]);

  const stats = useMemo(() => diffStats(text), [text]);

  // 实时跟随由后端 watcher 推 diff-update 事件（App 统一监听）

  return (
    <MotionLayer
      className="modal-backdrop"
      onClick={onClose}
    >
      <MotionLayer preset="dialog"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog" aria-modal="true" aria-label="Git Diff"
        className="dialog-panel diff-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 border-b border-stone-100 px-4 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
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
                <span className="text-stone-400">任务上下文</span>
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
            className="icon-button"
            title="关闭"
            aria-label="关闭"
          >
            <IconClose size={15} />
          </button>
        </div>
        <p className="file-preview-notice">当前工作区相对 Git 基线的改动。运行器与模型为任务执行信息，逐行作者尚未确认。</p>
        <FileLines text={text} diff label="工作区改动" />
      </MotionLayer>
    </MotionLayer>
  );
}
