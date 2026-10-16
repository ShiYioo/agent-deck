import { useState } from "react";
import {
  FileDiff,
  FileImage,
  FileArchive,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Undo2,
  LoaderCircle,
  Package,
} from "lucide-react";
import type { TurnArtifacts as TurnArtifactsData, TurnFileChange } from "../api";

const ARTIFACT_ICON = {
  image: FileImage,
  archive: FileArchive,
  sheet: FileSpreadsheet,
  doc: FileText,
  pdf: FileText,
  other: Package,
} as const;

function fmtSize(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function FileRow({
  file,
  onViewDiff,
  onUndo,
}: {
  file: TurnFileChange;
  onViewDiff: (f: TurnFileChange) => void;
  onUndo: (f: TurnFileChange) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const undo = () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    onUndo(file);
  };
  const statusLabel =
    file.status === "added" ? "新增" : file.status === "deleted" ? "删除" : "修改";
  const reviewable = file.status !== "deleted";
  return (
    <div className="flex items-center gap-2 py-1 text-xs">
      <span className="min-w-0 flex-1 truncate font-mono text-stone-700" title={file.path}>
        {baseName(file.path)}
      </span>
      <span className="shrink-0 text-stone-400">{statusLabel}</span>
      {file.added !== null && file.added > 0 && (
        <span className="shrink-0 font-mono text-diff-added">+{file.added}</span>
      )}
      {file.removed !== null && file.removed > 0 && (
        <span className="shrink-0 font-mono text-diff-removed">-{file.removed}</span>
      )}
      {reviewable && (
        <button
          onClick={() => onViewDiff(file)}
          className="flex shrink-0 items-center gap-1 rounded border border-stone-200 px-1.5 py-0.5 text-stone-600 hover:bg-stone-100"
          title={`审查 ${baseName(file.path)} 的改动`}
        >
          <FileDiff size={12} />
          审查
        </button>
      )}
      {file.status !== "deleted" && (
        <button
          onClick={undo}
          className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 transition-colors ${
            confirming
              ? "border-red-300 bg-red-50 text-red-600"
              : "border-stone-200 text-stone-500 hover:bg-stone-100"
          }`}
          title={confirming ? "再次点击确认撤销（不可恢复）" : "撤销该文件的修改"}
        >
          <Undo2 size={12} />
          {confirming ? "确认？" : "撤销"}
        </button>
      )}
    </div>
  );
}

export function TurnArtifactsPanel({
  data,
  loading,
  onViewDiff,
  onUndo,
  onOpen,
}: {
  data: TurnArtifactsData | null;
  loading: boolean;
  onViewDiff: (f: TurnFileChange) => void;
  onUndo: (f: TurnFileChange) => void;
  onOpen: (path: string, reveal: boolean) => void;
}) {
  if (loading) {
    return (
      <div className="turn-artifacts flex items-center gap-2 text-xs text-stone-400">
        <LoaderCircle size={13} className="animate-spin" />
        正在收集本轮产出…
      </div>
    );
  }
  if (!data || (data.files.length === 0 && data.artifacts.length === 0)) return null;

  return (
    <div className="turn-artifacts space-y-2 rounded-xl border border-stone-200 bg-stone-50/60 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-stone-500">
          {data.files.length > 0
            ? `${data.files.length} 个文件已更改`
            : `本轮产出 · ${data.artifacts.length} 个工件`}
        </span>
        <button
          onClick={() => onOpen(data.base_dir, true)}
          className="flex items-center gap-1 rounded border border-stone-200 px-1.5 py-0.5 text-stone-500 hover:bg-stone-100"
          title="在文件夹中显示"
        >
          <FolderOpen size={12} />
          打开目录
        </button>
      </div>

      {data.files.length > 0 && (
        <div className="space-y-0.5">
          {data.files.map((f) => (
            <FileRow key={f.path} file={f} onViewDiff={onViewDiff} onUndo={onUndo} />
          ))}
        </div>
      )}

      {data.artifacts.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {data.artifacts.map((a) => {
            const Icon = ARTIFACT_ICON[a.kind] ?? Package;
            const label = baseName(a.path);
            return (
              <button
                key={a.path}
                onClick={() => onOpen(a.path, false)}
                className="flex w-44 items-center gap-2 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-left hover:border-stone-400"
                title={`${a.path}\n${a.kind} · ${fmtSize(a.size)}\n点击打开`}
              >
                <Icon size={16} className="shrink-0 text-stone-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-stone-700">{label}</span>
                  <span className="block text-[10px] text-stone-400">
                    {a.kind === "image" ? "图片" : a.kind === "archive" ? "压缩包" : a.kind === "sheet" ? "表格" : a.kind === "doc" ? "文档" : a.kind === "pdf" ? "PDF" : "文件"} · {fmtSize(a.size)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
