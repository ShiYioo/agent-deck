import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff, FileImage, FileArchive, FileSpreadsheet, FileText, FolderOpen, Undo2, LoaderCircle, Package } from "lucide-react";
import { getTaskFilePatch, type TurnArtifacts as TurnArtifactsData, type TurnFileChange } from "../api";
import { HarnessIcon } from "./HarnessIcon";

const FileLines = lazy(() => import("./FileLines").then((module) => ({ default: module.FileLines })));
const ARTIFACT_ICON = { image: FileImage, archive: FileArchive, sheet: FileSpreadsheet, doc: FileText, pdf: FileText, other: Package } as const;
const PAGE = 60;

export function generatedFile(path: string): boolean {
  return /(?:^|\/)(?:dist|build|target|coverage|out|\.next|\.nuxt|__pycache__)(?:\/|$)/i.test(path.replace(/\\/g, "/"))
    || /(?:\.min\.(?:js|css)|\.map)$/i.test(path);
}

function fmtSize(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

type Props = {
  taskId: string;
  harness?: string;
  model?: string | null;
  running?: boolean;
  data: TurnArtifactsData | null;
  loading: boolean;
  onViewDiff: (file: TurnFileChange) => void;
  onUndo: (file: TurnFileChange) => Promise<string>;
  onOpen: (path: string, reveal: boolean) => void;
};

function FileRow({ file, taskId, harness, model, running, onViewDiff, onUndo, onOpen }: Omit<Props, "data" | "loading"> & { file: TurnFileChange }) {
  const [expanded, setExpanded] = useState(false);
  const [patch, setPatch] = useState<{ text: string; truncated: boolean }>();
  const [readError, setReadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState("");
  const [backup, setBackup] = useState("");
  useEffect(() => {
    if (!expanded) return;
    let disposed = false;
    setPatch(undefined); setReadError("");
    getTaskFilePatch(taskId, file.path).then((value) => {
      if (!disposed) setPatch(value);
    }).catch((error) => { if (!disposed) setReadError(String(error)); });
    return () => { disposed = true; };
  }, [expanded, taskId, file.path, retry]);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 8000);
    return () => clearTimeout(timer);
  }, [confirming]);
  const undo = async () => {
    if (!confirming) { setConfirming(true); return; }
    setConfirming(false); setUndoing(true); setUndoError("");
    try { setBackup(await onUndo(file)); setRetry((value) => value + 1); }
    catch (error) { setUndoError(String(error)); }
    finally { setUndoing(false); }
  };
  const status = { added: "新增", deleted: "删除", modified: "修改" }[file.status];
  return <div className="turn-change-file">
    <div className="turn-change-row">
      <button className="turn-change-toggle" aria-expanded={expanded} aria-label={`审查 ${file.path}`} onClick={() => setExpanded(!expanded)}>
        <FileDiff size={14} /><span className="turn-change-path" title={file.path}>{file.path}</span>
        <span className="turn-change-status">{status}</span>
        <span className="turn-change-counts">
          {file.added !== null && <span className="text-diff-added">+{file.added}</span>}
          {file.removed !== null && <span className="text-diff-removed">−{file.removed}</span>}
          {file.added === null && file.removed === null && <span>—</span>}
        </span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      <button className="turn-change-open" aria-label={file.path} title={`打开 ${file.path}`}
        onClick={() => file.status === "deleted" ? onViewDiff(file) : onOpen(file.path, false)}><FolderOpen size={14} /></button>
    </div>
    {expanded && <div className="turn-change-review">
      <div className="turn-change-context">
        {harness && <span><HarnessIcon harness={harness} size={13} />{harness} · 配置模型：{model || "默认模型"}</span>}
        <span>工作区与 Git 基线比较 · 非逐行作者归属</span>
      </div>
      {readError ? <div className="turn-change-error" role="alert">{readError}<button onClick={() => setRetry((value) => value + 1)}>重试</button></div>
        : !patch ? <div className="turn-change-loading" role="status"><LoaderCircle size={14} className="animate-spin" />正在加载改动…</div>
        : patch.text ? <Suspense fallback={<div role="status">正在加载审阅视图…</div>}>
          <FileLines text={patch.text} diff label={`${file.path} 的改动`} />
        </Suspense> : <p className="file-preview-notice">{file.binary ? "二进制文件，请打开文件预览。" : "当前没有可显示的 Git 文本差异；文件可能已再次修改或还原。"}</p>}
      {patch?.truncated && <p className="file-preview-notice">补丁预览达到大小上限，可打开完整文件继续查看。</p>}
      <div className="turn-change-actions">
        <button onClick={() => setRetry((value) => value + 1)}>刷新差异</button>
        {file.status !== "deleted" && <button onClick={() => onOpen(file.path, false)}>打开文件</button>}
        <button onClick={() => onViewDiff(file)}>在文件工作区审查</button>
        <button disabled={running || undoing || !!backup} title={running ? "执行结束后才能安全撤销" : "核验成果版本后恢复起始基线"}
          onClick={() => void undo()}>{undoing ? <LoaderCircle size={13} className="animate-spin" /> : <Undo2 size={13} />}{confirming ? "确认撤销此文件" : "撤销"}</button>
        {confirming && <button onClick={() => setConfirming(false)}>取消</button>}
      </div>
      {undoError && <div className="turn-change-error" role="alert">{undoError}<button onClick={() => onViewDiff(file)}>查看当前差异</button></div>}
      {backup && <p className="turn-change-note" role="status">已撤销，原内容已备份。<button onClick={() => onOpen(backup, true)}>查看恢复备份</button></p>}
    </div>}
  </div>;
}

export function TurnArtifactsPanel(props: Props) {
  const { data, loading, onOpen } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [generatedOpen, setGeneratedOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [generatedLimit, setGeneratedLimit] = useState(PAGE);
  const files = data?.files;
  const groups = useMemo(() => {
    const regular: TurnFileChange[] = [], generated: TurnFileChange[] = [];
    let added = 0, removed = 0, unknown = 0;
    for (const file of files ?? []) {
      (generatedFile(file.path) ? generated : regular).push(file);
      added += file.added ?? 0; removed += file.removed ?? 0;
      if (file.added === null || file.removed === null) unknown++;
    }
    return { regular, generated, added, removed, unknown };
  }, [files]);
  if (loading && !data) return <div className="turn-artifacts turn-change-loading" role="status"><LoaderCircle size={13} className="animate-spin" />正在收集本轮产出…</div>;
  if (!data || (!data.files.length && !data.artifacts.length)) return null;
  const render = (file: TurnFileChange) => <FileRow key={file.path} {...props} file={file} />;
  return <section className="turn-artifacts artifact-panel turn-changes" aria-label="本轮变更">
    <div className="artifact-heading">
      <button className="turn-change-heading" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        <span>{data.files.length ? `更改了 ${data.files.length} 个文件` : `本轮产出 · ${data.artifacts.length} 个工件`}</span>
        {!!data.files.length && <span className="turn-change-counts"><span className="text-diff-added">+{groups.added}</span><span className="text-diff-removed">−{groups.removed}</span></span>}
      </button>
      <button className="turn-change-directory" onClick={() => onOpen(data.base_dir, true)} title="在文件夹中显示"><FolderOpen size={13} />打开目录</button>
    </div>
    {!collapsed && <>
      {groups.unknown > 0 && <p className="turn-change-note">{groups.unknown} 个文件无可用行数，汇总仅含已知统计。</p>}
      {groups.regular.slice(0, limit).map(render)}
      {groups.regular.length > limit && <button className="turn-change-more" onClick={() => setLimit(limit + PAGE)}>再显示 {Math.min(PAGE, groups.regular.length - limit)} 个文件（剩余 {groups.regular.length - limit} 个）</button>}
      {groups.generated.length > 0 && <div className="turn-generated">
        <button className="turn-change-heading" aria-expanded={generatedOpen} onClick={() => setGeneratedOpen(!generatedOpen)}>
          {generatedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}构建与生成文件 · {groups.generated.length}
        </button>
        {generatedOpen && <>{groups.generated.slice(0, generatedLimit).map(render)}
          {groups.generated.length > generatedLimit && <button className="turn-change-more" onClick={() => setGeneratedLimit(generatedLimit + PAGE)}>显示更多生成文件</button>}</>}
      </div>}
      {data.artifacts.length > 0 && <div className="artifact-deliverables">
        {data.artifacts.map((artifact) => {
          const Icon = ARTIFACT_ICON[artifact.kind] ?? Package;
          return <button key={artifact.path} onClick={() => onOpen(artifact.path, false)} className="artifact-card" title={artifact.path}>
            <Icon size={16} /><span><span className="artifact-name">{artifact.path.split(/[\\/]/).pop()}</span><span className="artifact-meta">{fmtSize(artifact.size)}</span></span>
          </button>;
        })}
      </div>}
    </>}
  </section>;
}
