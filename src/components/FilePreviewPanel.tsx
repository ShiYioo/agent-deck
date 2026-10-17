import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { X, Maximize2, Minimize2, ExternalLink, FolderOpen, RefreshCw, Copy } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getTaskFilePatch, openArtifact, previewTaskFile, type FilePreviewData, type TurnFileChange } from "../api";
import { type TaskRow } from "../types";
import { FileLines } from "./FileLines";
import { HarnessIcon } from "./HarnessIcon";

export type FileSelection = { task: TaskRow; path: string; tab: "content" | "diff"; change?: TurnFileChange };
const PdfPreview = lazy(() => import("./PdfPreview"));
const SourceDocument = lazy(() => import("./SourceDocument"));
const LargeTextDocument = lazy(() => import("./LargeTextDocument"));

export function FilePreviewPanel({ selection, onClose, embedded = false }: {
  selection: FileSelection;
  files: TurnFileChange[];
  onSelect: (path: string, tab?: "content" | "diff") => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  const { task, path, change } = selection;
  const [tab, setTab] = useState(selection.tab);
  const [data, setData] = useState<FilePreviewData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [patch, setPatch] = useState<{ text: string; truncated: boolean } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (embedded) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [embedded]);
  useEffect(() => {
    if (tab !== "diff") return;
    let alive = true;
    setBusy(true); setError(""); setPatch(null);
    getTaskFilePatch(task.id, path).then((result) => { if (alive) setPatch(result); })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [task.id, path, tab, refresh]);
  useEffect(() => {
    if (embedded) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose, embedded]);
  useEffect(() => {
    if (tab !== "content" || change?.status === "deleted") return;
    let alive = true;
    setBusy(true); setError(""); setData(null);
    previewTaskFile(task.id, path).then((result) => {
      if (alive) setData(result);
    }).catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [task.id, path, refresh, tab, change?.status]);
  const model = task.execution_config?.resolved.model;
  const modelLabel = model ? `${model}（执行配置）` : task.model ? `${task.model}（请求配置）` : "模型未报告";
  const mediaUrl = useMemo(() => data && ["image", "pdf", "audio", "video"].includes(data.kind) ? convertFileSrc(data.path) : "", [data]);
  const canReadMarkdown = data?.kind === "markdown" && data.next_offset === null && data.content.length < 64000;
  const open = (reveal: boolean) => {
    const root = task.worktree_dir || task.cwd;
    const full = data?.path ?? (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path) ? path : `${root}/${path}`);
    openArtifact(full, reveal).catch((e) => setError(String(e)));
  };
  return <aside className={`file-preview-panel ${embedded ? "is-embedded" : ""} ${expanded ? "is-expanded" : ""}`} role="region" aria-label="文件查看与改动审阅">
    {!embedded && <header className="file-preview-header">
      <div className="file-preview-title" title={path}>{path}</div>
      <button className="icon-button" title="刷新文件" aria-label="刷新文件" onClick={() => setRefresh((x) => x + 1)}><RefreshCw size={15} /></button>
      <button className="icon-button" title={expanded ? "收起阅读区" : "展开阅读区"} aria-label={expanded ? "收起阅读区" : "展开阅读区"} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      <button ref={closeRef} className="icon-button" aria-label="关闭文件预览" onClick={onClose}><X size={17} /></button>
    </header>}
    <nav className="file-preview-tabs" aria-label="文件视图">
      <button aria-pressed={tab === "content"} onClick={() => setTab("content")}>内容</button>
      <button aria-pressed={tab === "diff"} onClick={() => setTab("diff")}>改动 {change && `+${change.added ?? "?"} −${change.removed ?? "?"}`}</button>
      <span className="file-preview-spacer" />
      {embedded && <button title="刷新文件" aria-label="刷新文件" onClick={() => setRefresh((x) => x + 1)}><RefreshCw size={13} /></button>}
      <button title="使用系统应用打开" onClick={() => open(false)}><ExternalLink size={13} /> 外部打开</button>
      <button title="在文件夹中显示" aria-label="在文件夹中显示" onClick={() => open(true)}><FolderOpen size={15} /></button>
    </nav>
    {error && <div className="file-preview-notice" role="alert">{error}</div>}
    {tab === "diff" ? <>
      <div className="file-preview-provenance"><HarnessIcon harness={task.harness} size={14} /> {task.harness} · {modelLabel}
        <span>任务 {task.id.slice(0, 8)}</span>
      </div>
      <p className="file-preview-notice">当前工作区相对 Git 基线的改动。以上为任务执行信息，逐行作者尚未确认；后续修改可能影响此视图。</p>
      {patch?.truncated && <p className="file-preview-notice">补丁超过 256 KiB，当前展示部分改动。</p>}
      {busy ? <div className="file-preview-empty" role="status">正在读取改动…</div> : patch?.text
        ? <FileLines key={`${path}-diff`} text={patch.text} diff label="文件改动" />
        : <div className="file-preview-empty">{change?.binary ? "二进制文件不提供逐行 Diff，可切换内容查看。" : "没有可用的文本补丁。此文件可能未纳入 Git，或未记录改动。"}</div>}
    </> : change?.status === "deleted" ? <div className="file-preview-empty">文件已删除。切换“改动”查看删除内容。</div>
      : busy ? <div className="file-preview-empty" role="status">正在读取文件…</div>
      : data && <>
        <div className="file-preview-toolbar">
          <span>{formatSize(data.size)}{data.encoding && ` · ${data.encoding}`}</span>
          {data.kind === "markdown" && (canReadMarkdown
            ? <button aria-pressed={source} onClick={() => setSource(!source)}>{source ? "阅读模式" : "查看源码"}</button>
            : <span>源码视图</span>)}
          {["text", "markdown", "document", "archive", "binary"].includes(data.kind) && !data.next_offset && <>
            {["document", "archive", "binary"].includes(data.kind) && <input aria-label="搜索已加载内容" placeholder="查找…" value={query} onChange={(e) => setQuery(e.target.value)} />}
            <button title="复制内容" aria-label="复制内容" onClick={() => { navigator.clipboard?.writeText(data.content).catch((e) => setError(String(e))); }}><Copy size={14} /></button>
          </>}
        </div>
        {data.notice && <p className="file-preview-notice">{data.notice}</p>}
        {data.kind === "image" ? <div className="file-preview-media"><img src={mediaUrl} alt={path} loading="lazy" onError={() => setError("无法解码此图片，请使用外部应用打开")} /></div>
        : data.kind === "pdf" ? <Suspense fallback={<div className="file-preview-empty" role="status">正在加载 PDF 阅读器…</div>}><PdfPreview url={mediaUrl} /></Suspense>
        : data.kind === "audio" || data.kind === "video" ? <div className="file-preview-media">
            {data.kind === "audio" ? <audio controls preload="metadata" src={mediaUrl} onError={() => setError("系统不支持该音频编码，请使用外部应用打开")} />
              : <video controls preload="metadata" src={mediaUrl} onError={() => setError("系统不支持该视频编码，请使用外部应用打开")} />}
          </div>
        : data.kind === "unsupported" ? <div className="file-preview-empty">此格式请使用外部应用打开。</div>
        : canReadMarkdown && !source && !query
          ? <div className="file-preview-markdown assistant-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
              img: ({ alt }) => <span className="file-preview-notice">［图片：{alt || "未加载"}］</span>,
              a: ({ children, href }) => /^https?:\/\//i.test(href ?? "")
                ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
                : <span>{children}</span>,
            }}>{data.content}</Markdown></div>
          : ["text", "markdown"].includes(data.kind)
            ? <Suspense fallback={<div className="file-preview-empty" role="status">正在打开文档…</div>}>
                {data.next_offset !== null
                  ? <LargeTextDocument key={`${path}:${refresh}`} taskId={task.id} path={path} />
                  : <SourceDocument text={data.content} path={`${task.id}/${path}`} />}
              </Suspense>
            : <FileLines key={`${path}:${query}`} text={data.content} query={query} />}
      </>}
  </aside>;
}

function formatSize(size: number) {
  return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MiB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${size} B`;
}
