import { useEffect, useRef, useState } from "react";
import { Files, Maximize2, Minimize2, PanelLeftClose, X } from "lucide-react";
import { FilePreviewPanel, type FileSelection } from "./FilePreviewPanel";
import ProjectTree from "./ProjectTree";
import type { TurnFileChange } from "../api";

type Tab = { path: string; permanent: boolean; tab: "content" | "diff" };
export default function FileWorkspace({ selection, files, onSelect, onClose }: {
  selection: FileSelection; files: TurnFileChange[];
  onSelect: (path: string, tab?: "content" | "diff") => void; onClose: () => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tree, setTree] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(62);
  const tabBar = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if ((event.target as HTMLElement | null)?.closest(".cm-panel")) return;
        onClose();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [onClose]);
  const normalize = (path: string) => {
    const root = (selection.task.worktree_dir || selection.task.cwd).replace(/\\/g, "/").replace(/\/$/, "");
    path = path.replace(/\\/g, "/");
    return path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : path;
  };
  const active = normalize(selection.path);
  useEffect(() => {
    if (!active) return;
    setTabs((old) => {
      const found = old.find((tab) => tab.path === active);
      if (found) return old.map((tab) => tab === found ? { ...tab, tab: selection.tab } : tab);
      return [...old.filter((tab) => tab.permanent), { path: active, permanent: false, tab: selection.tab }];
    });
  }, [active, selection.tab]);
  const open = (path: string, permanent = false) => {
    if (permanent) setTabs((old) => {
      const found = old.find((tab) => tab.path === path);
      return found ? old.map((tab) => tab === found ? { ...tab, permanent: true } : tab)
        : [...old, { path, permanent: true, tab: "content" }];
    });
    onSelect(path);
  };
  const closeTab = (path: string) => {
    const next = tabs.filter((tab) => tab.path !== path);
    setTabs(next);
    if (active === path) {
      const neighbor = next[Math.max(0, tabs.findIndex((tab) => tab.path === path) - 1)];
      onSelect(neighbor?.path ?? "", neighbor?.tab);
    }
  };
  useEffect(() => { tabBar.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [active]);
  return <section className={`file-workspace ${expanded ? "is-expanded" : ""}`} style={{ flexBasis: `calc((100% - var(--file-sidebar-width, 0px)) * ${width / 100})` }} aria-label="项目文件工作区">
    <div className="workspace-resizer" role="separator" aria-label="调整文件工作区宽度" aria-orientation="vertical" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWidth((old) => Math.max(35, Math.min(80, old + (e.key === "ArrowLeft" ? 2 : -2)))); } }}
      onPointerDown={(e) => {
        const element = e.currentTarget; const parent = element.parentElement?.parentElement;
        if (!parent) return;
        element.setPointerCapture(e.pointerId);
        const move = (event: PointerEvent) => {
          const rect = parent.getBoundingClientRect();
          const left = parent.querySelector(".workspace-main")?.getBoundingClientRect().left ?? rect.left;
          setWidth(Math.max(35, Math.min(80, (rect.right - event.clientX) / Math.max(1, rect.right - left) * 100)));
        };
        const stop = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", stop); element.removeEventListener("pointercancel", stop); };
        element.addEventListener("pointermove", move); element.addEventListener("pointerup", stop); element.addEventListener("pointercancel", stop);
      }} />
    <header className="file-workspace-heading">
      <button className="icon-button" aria-label={tree ? "隐藏项目目录" : "显示项目目录"} onClick={() => setTree(!tree)}>{tree ? <PanelLeftClose size={16} /> : <Files size={16} />}</button>
      <span>项目文件</span><span className="file-preview-spacer" />
      <button className="icon-button" aria-label={expanded ? "收起阅读区" : "展开阅读区"} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      <button ref={closeButton} className="icon-button" aria-label="关闭文件预览" onClick={onClose}><X size={17} /></button>
    </header>
    <div className="file-workspace-body">
      {tree && <ProjectTree taskId={selection.task.id} root={selection.task.worktree_dir || selection.task.cwd} active={active} changes={files} onOpen={open} />}
      <div className="file-workspace-center">
        <div className="file-tab-bar" role="tablist" aria-label="已打开文件" ref={tabBar} onKeyDown={(event) => {
          const current = tabs.findIndex((tab) => tab.path === active);
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const next = tabs[(current + tabs.length + (event.key === "ArrowLeft" ? -1 : 1)) % tabs.length];
            if (next) onSelect(next.path, next.tab);
          } else if (event.key === "Delete" && active) { event.preventDefault(); closeTab(active); }
        }}>
          {tabs.map((tab) => <div className={`file-tab ${!tab.permanent ? "is-preview" : ""}`} key={tab.path}>
            <button role="tab" tabIndex={active === tab.path ? 0 : -1} aria-selected={active === tab.path} title={tab.path} onClick={() => onSelect(tab.path, tab.tab)} onDoubleClick={() => open(tab.path, true)}>{tab.path.split("/").pop()}</button>
            <button className="file-tab-close" aria-label={`关闭 ${tab.path}`} onClick={() => closeTab(tab.path)}><X size={12} /></button>
          </div>)}
        </div>
        {active ? <>
          <div className="file-breadcrumbs" title={active}>{active.split("/").map((part, index) => <span key={index}>{index > 0 && <span className="file-breadcrumb-separator">/</span>}{part}</span>)}<button onClick={() => open(active, true)} title="保留此标签">保留标签</button></div>
          <FilePreviewPanel key={`${active}:${selection.tab}`} selection={{ ...selection, path: active, change: files.find((file) => normalize(file.path) === active) }} files={files} onSelect={onSelect} onClose={onClose} embedded />
        </> : <div className="file-workspace-empty"><Files size={28} strokeWidth={1} /><p>从项目目录打开文件</p><span>单击预览 · 双击保留标签</span></div>}
      </div>
    </div>
  </section>;
}
