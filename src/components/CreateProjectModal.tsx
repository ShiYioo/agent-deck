import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useIsPresent } from "motion/react";
import { MotionLayer } from "../motion/MotionProvider";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { FolderOpen, LoaderCircle } from "lucide-react";

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
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const present = useIsPresent();
  const dialogRef = useDialogFocus(present, 'input[aria-label="项目名称"]');
  useEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [onClose, present]);

  const pickFolder = async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") setDir(picked);
    } catch (e) { setError(String(e)); }
  };

  const create = async () => {
    if (submitting.current) return;
    if (!name.trim()) {
      setError("请输入项目名称");
      return;
    }
    if (!dir.trim()) {
      setError("请选择源文件夹");
      return;
    }
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      await createProject(name.trim(), dir.trim());
      onCreated(dir.trim());
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <MotionLayer
      className="modal-backdrop"
      onClick={onClose}
    >
      <MotionLayer preset="dialog"
        ref={dialogRef}
        tabIndex={-1}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-label="创建项目"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-heading">
          <span>创建项目</span>
          <button
             onClick={onClose}
             title="关闭"
             aria-label="关闭"
            className="icon-button"
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
              className="min-w-0 flex-1 text-sm outline-none placeholder:text-stone-400"
            />
          </div>

          <span className="text-xs font-medium text-stone-600">源文件夹</span>
          <button
            onClick={pickFolder}
            className="folder-picker"
          >
            <span className="flex items-center gap-1.5">
              <FolderOpen size={16} />
              {dir ? "更改文件夹" : "选择文件夹"}
            </span>
            {dir && (
              <span className="max-w-full break-all font-mono text-xs text-stone-700">{dir}</span>
            )}
          </button>

          {error && <div className="text-xs text-red-600" role="alert">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <button
            onClick={onClose}
            className="task-action"
          >
            取消
          </button>
          <button
            onClick={create}
            disabled={saving || !name.trim() || !dir.trim()}
            className="task-action task-action-primary disabled:opacity-40"
          >
            {saving && <LoaderCircle size={13} className="animate-spin" />}
            {saving ? "正在创建…" : "创建项目"}
          </button>
        </div>
      </MotionLayer>
    </MotionLayer>
  );
}
