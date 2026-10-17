import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw, ChevronsDownUp } from "lucide-react";
import { listTaskDirectory, type DirectoryPage, type ProjectEntry, type TurnFileChange } from "../api";

export default function ProjectTree({ taskId, root, active, changes, onOpen }: {
  taskId: string; root: string; active: string; changes: TurnFileChange[];
  onOpen: (path: string, permanent?: boolean) => void;
}) {
  const [directories, setDirectories] = useState<Record<string, DirectoryPage>>({});
  const [expanded, setExpanded] = useState(new Set([""]));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(new Set<string>());
  const [filter, setFilter] = useState("");
  const [top, setTop] = useState(0);
  const [focused, setFocused] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async (path: string, offset = 0) => {
    if (pending.current.has(path)) return;
    pending.current.add(path); setBusy((old) => new Set(old).add(path));
    try {
      const data = await listTaskDirectory(taskId, path, offset);
      if (mounted.current) {
        setDirectories((old) => ({ ...old, [path]: { ...data, entries: offset ? [...(old[path]?.entries ?? []), ...data.entries] : data.entries } }));
        setErrors((old) => ({ ...old, [path]: "" }));
      }
    } catch (e) { if (mounted.current) setErrors((old) => ({ ...old, [path]: String(e) })); }
    finally {
      pending.current.delete(path);
      if (mounted.current) setBusy((old) => { const next = new Set(old); next.delete(path); return next; });
    }
  }, [taskId]);
  useEffect(() => { void load(""); }, [load]);
  const relative = useMemo(() => {
    const clean = active.replace(/\\/g, "/");
    const base = root.replace(/\\/g, "/").replace(/\/$/, "");
    return clean.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? clean.slice(base.length + 1) : clean;
  }, [active, root]);
  useEffect(() => {
    if (!relative) return;
    const parents = relative.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    setExpanded((old) => new Set([...old, ...parents]));
    for (const path of parents) void load(path);
    setFocused(relative);
  }, [relative, load]);
  const rows = useMemo(() => {
    const output: { entry: ProjectEntry; depth: number; more?: number; error?: string }[] = [];
    const visit = (path: string, depth: number) => {
      for (const entry of directories[path]?.entries ?? []) {
        if (!filter || entry.directory || entry.name.toLowerCase().includes(filter.toLowerCase())) output.push({ entry, depth });
        if (entry.directory && expanded.has(entry.path)) visit(entry.path, depth + 1);
      }
      const next = directories[path]?.next;
      if (next != null || errors[path]) output.push({
        entry: { name: errors[path] ? "读取失败，点击重试" : "加载更多条目…", path, directory: false, symlink: false },
        depth, more: next ?? 0, error: errors[path],
      });
    };
    visit("", 0);
    return output;
  }, [directories, expanded, errors, filter]);
  useEffect(() => {
    const index = rows.findIndex((row) => row.more === undefined && row.entry.path === relative);
    if (index >= 0 && viewport.current) {
      const y = index * 28;
      if (y < viewport.current.scrollTop || y > viewport.current.scrollTop + viewport.current.clientHeight - 28) viewport.current.scrollTop = y;
    }
  }, [relative, rows.length]);
  const statuses = useMemo(() => new Map(changes.map((file) => [file.path.replace(/\\/g, "/"), file.status])), [changes]);
  const toggle = (entry: ProjectEntry) => {
    setExpanded((old) => { const next = new Set(old); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
    if (!directories[entry.path]) void load(entry.path);
  };
  const activate = (row: typeof rows[number], permanent = false) => {
    setFocused(row.entry.path);
    if (row.more !== undefined) { void load(row.entry.path, row.more); return; }
    if (row.entry.directory) toggle(row.entry); else onOpen(row.entry.path, permanent);
  };
  const first = Math.max(0, Math.floor(top / 28) - 8);
  return <section className="project-tree-panel" aria-label="项目目录">
    <header className="project-tree-heading"><strong title={root}>{root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "项目"}</strong>
      <button className="icon-button" aria-label="折叠所有目录" onClick={() => setExpanded(new Set([""]))}><ChevronsDownUp size={14} /></button>
      <button className="icon-button" aria-label="刷新目录" onClick={() => { for (const path of expanded) void load(path); }}><RefreshCw size={14} /></button>
    </header>
    <input className="project-tree-filter" aria-label="筛选已展开目录" placeholder="筛选已展开目录…" value={filter} onChange={(e) => setFilter(e.target.value)} />
    <div ref={viewport} className="project-tree-viewport" role="tree" aria-label="项目文件树" tabIndex={0}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      onKeyDown={(event) => {
        const index = rows.findIndex((row) => row.entry.path === focused);
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          const next = Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
          if (rows[next]) { setFocused(rows[next].entry.path); viewport.current?.scrollTo({ top: Math.max(0, next * 28 - 100) }); }
        } else if ((event.key === "Enter" || event.key === " ") && rows[index]) { event.preventDefault(); activate(rows[index], event.key === "Enter"); }
        else if (event.key === "ArrowRight" && rows[index]?.entry.directory && !expanded.has(focused)) { event.preventDefault(); toggle(rows[index].entry); }
        else if (event.key === "ArrowLeft" && rows[index]) {
          event.preventDefault();
          if (expanded.has(focused)) toggle(rows[index].entry);
          else setFocused(focused.split("/").slice(0, -1).join("/"));
        }
      }}>
      <div style={{ height: rows.length * 28, position: "relative" }}>
        {rows.slice(first, first + 100).map((row, i) => {
          const { entry, depth } = row;
          const status = statuses.get(entry.path);
          return <div key={`${entry.path}:${row.more ?? "entry"}`} role="treeitem" aria-level={depth + 1}
            aria-selected={relative === entry.path && row.more === undefined}
            aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
            aria-label={entry.name} title={row.error || entry.path}
            className={`project-tree-row ${relative === entry.path ? "is-active" : ""} ${focused === entry.path ? "is-focused" : ""}`}
            style={{ top: (first + i) * 28, paddingLeft: 10 + depth * 14 }}
            onClick={() => { viewport.current?.focus(); activate(row); }} onDoubleClick={() => { if (!entry.directory && row.more === undefined) onOpen(entry.path, true); }}>
            {entry.directory ? <>{expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{expanded.has(entry.path) ? <FolderOpen size={14} /> : <Folder size={14} />}</> : <><span style={{ width: 12 }} /><File size={14} /></>}
            <span className="project-tree-name">{entry.name}{entry.symlink ? " ↗" : ""}</span>
            {busy.has(entry.path) && <span>…</span>}
            {status && <span className={`project-tree-status ${status}`}>{status === "added" ? "A" : status === "deleted" ? "D" : "M"}</span>}
          </div>;
        })}
      </div>
      {busy.has("") && !directories[""] && <p className="file-preview-notice" role="status">正在读取目录…</p>}
      {directories[""]?.entries.length === 0 && <p className="file-preview-notice">目录为空</p>}
    </div>
  </section>;
}
