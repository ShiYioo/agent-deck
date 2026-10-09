import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useIsPresent } from "motion/react";
import { MotionLayer } from "../motion/MotionProvider";

import { createProject } from "../api";
import { IconClose, IconFolder } from "./icons";

/** 创建项目弹窗（对齐 Codex）：名称 + 源文件夹选择 */
export function CreateProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** 创建成功，返回新项目目录 */
  onCreated: (dir: string) => void;
}) {
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const present = useIsPresent();
  useEffect(() => {
    if (!present) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [onClose, present]);

  const pickFolder = async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") setDir(picked);
    } catch (e) { setError(String(e)); }
  };

  const create = async () => {
    if (!name.trim()) {
      setError("请输入项目名称");
      return;
    }
    if (!dir.trim()) {
      setError("请选择源文件夹");
      return;
    }
    try {
      await createProject(name.trim(), dir.trim());
      onCreated(dir.trim());
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <MotionLayer
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 p-6"
      onClick={onClose}
    >
      <MotionLayer preset="dialog"
        className="w-full max-w-md rounded-xl border border-stone-200 bg-white shadow-[var(--shadow-2)]"
        role="dialog"
        aria-modal="true"
        aria-label="创建项目"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-sm font-semibold">创建项目</span>
          <button
             onClick={onClose}
             title="关闭"
             aria-label="关闭"
            className="hover-lift rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          >
            <IconClose size={15} />
          </button>
        </div>

        <div className="space-y-3 px-5">
          <div className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-2 focus-within:border-stone-400">
            <IconFolder size={15} className="shrink-0 text-stone-400" />
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="项目名称"
              aria-label="项目名称"
              autoFocus
              className="min-w-0 flex-1 text-sm outline-none placeholder:text-stone-400"
            />
          </div>

          <span className="text-xs font-medium text-stone-600">源文件夹</span>
          <button
            onClick={pickFolder}
            className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 px-4 py-6 text-sm text-stone-500 transition-colors hover:bg-stone-100"
          >
            <span className="flex items-center gap-1.5">
              在此电脑上添加文件夹
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
            {dir && (
              <span className="font-mono text-xs text-stone-700">{dir}</span>
            )}
          </button>

          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-full px-4 py-1.5 text-sm text-stone-600 hover:bg-stone-100"
          >
            取消
          </button>
          <button
            onClick={create}
            disabled={!name.trim() || !dir.trim()}
            className="rounded-full bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-40"
          >
            创建项目
          </button>
        </div>
      </MotionLayer>
    </MotionLayer>
  );
}
