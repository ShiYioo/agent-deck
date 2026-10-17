import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderOpen, FolderPlus, Search, Settings, SquarePen, PanelLeftClose, X, CircleAlert, LoaderCircle, Trash2 } from "lucide-react";
import type { ProjectRow, TaskRow } from "../types";
import { groupSessions, type SessionGroup } from "../sessions";
import { AnimatePresence } from "motion/react";
import { MotionLayer, useMotionPolicy } from "../motion/MotionProvider";

/** 取路径末段作为项目名（与 Codex 的项目分组一致） */
export function projectName(cwd: string): string {
  const norm = cwd.replace(/[\\/]+$/, "");
  const seg = norm.split(/[\\/]/).filter(Boolean).pop();
  return seg || norm || "选择项目";
}

/** harness 身份色：贯穿侧栏、任务头部、发送键 */
export const HARNESS_ACCENT: Record<string, string> = {
  zcode: "var(--harness-zcode)",
  codex: "var(--harness-codex)",
  deck: "#737373",
  opencode: "#737373",
};

export function directoryKey(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export const Sidebar = memo(function Sidebar({
  tasks, projects, selectedId, onSelect, onDelete, onNew, onSettings, onCreateProject, onCollapse, view, searchRequest,
}: {
  tasks: TaskRow[];
  projects: ProjectRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: (project?: ProjectRow) => void;
  onSettings: () => void;
  onCreateProject: () => void;
  onCollapse: () => void;
  view: "projects" | "recent";
  searchRequest: number;
}) {
  const { enabled } = useMotionPolicy();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!searchRequest) return;
    setSearchOpen(true);
  }, [searchRequest]);
  useLayoutEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen, searchRequest]);
  const sessions = useMemo(() => groupSessions(tasks), [tasks]);
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; dir: string; project?: ProjectRow; rows: SessionGroup[] }>();
    for (const p of projects) map.set(directoryKey(p.dir), { name: p.name, dir: p.dir, project: p, rows: [] });
    for (const session of sessions) {
      const task = session.turns[0];
      const project = projects.find((p) => p.id === task.project_id);
      const key = directoryKey(project?.dir ?? task.cwd);
      if (!map.has(key)) map.set(key, { name: projectName(task.cwd), dir: task.cwd, rows: [] });
      map.get(key)!.rows.push(session);
    }
    const q = query.trim().toLowerCase();
    return [...map.entries()].map(([key, group]) => ({
      key, ...group,
      rows: q && !`${group.name} ${group.dir}`.toLowerCase().includes(q)
        ? group.rows.filter((s) => s.turns.some((t) => `${t.prompt} ${t.harness}`.toLowerCase().includes(q)))
        : group.rows,
    })).filter((g) => !q || g.rows.length || `${g.name} ${g.dir}`.toLowerCase().includes(q));
  }, [sessions, projects, query]);
  const recent = useMemo(() => sessions.filter((session) => !query.trim() || session.turns.some((task) =>
    `${task.prompt} ${task.harness} ${task.cwd}`.toLowerCase().includes(query.trim().toLowerCase()))), [sessions, query]);

  return (
    <aside className="app-sidebar" aria-label="项目和聊天">
      <div className="sidebar-heading">
        <span className="sidebar-brand">AgentDeck</span>
        <div className="sidebar-heading-actions">
          <button className="icon-button" title="搜索聊天" aria-label="搜索聊天"
            onClick={() => { setSearchOpen(true); searchRef.current?.focus(); }}><Search size={17} /></button>
          <button className="icon-button" onClick={onCollapse} title="收起侧栏" aria-label="收起侧栏"><PanelLeftClose size={17} /></button>
        </div>
      </div>
      <nav className="sidebar-nav">
        <button className="nav-action sidebar-primary-action" aria-label="新聊天" onClick={() => onNew()}><SquarePen size={17} />新聊天<kbd aria-hidden="true">Ctrl N</kbd></button>
      </nav>
      {searchOpen && (
        <div className="sidebar-search">
          <Search size={14} />
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索" aria-label="搜索聊天"
            onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); setSearchOpen(false); } }} />
          <button className="icon-button" title="关闭搜索" aria-label="关闭搜索" onClick={() => { setQuery(""); setSearchOpen(false); }}><X size={14} /></button>
        </div>
      )}
      <div className="sidebar-section-heading">
        <span>{view === "recent" ? "最近" : "项目"}</span>
        <button className="icon-button" onClick={onCreateProject} title="添加项目" aria-label="添加项目"><FolderPlus size={16} /></button>
      </div>
      <div className="sidebar-projects">
        {(view === "recent" ? recent.length === 0 : groups.length === 0) && <div className="sidebar-empty">{query ? "没有匹配的聊天" : view === "recent" ? "暂无聊天" : "暂无项目"}</div>}
        {view === "recent" && recent.map(renderSession)}
        {view === "projects" && groups.map((g) => (
          <section key={g.key} className="project-group">
            <div className="project-heading">
              <button className="project-toggle" title={g.dir} aria-expanded={!collapsed.has(g.key) || !!query}
                onClick={() => setCollapsed((prev) => { const next = new Set(prev); next.has(g.key) ? next.delete(g.key) : next.add(g.key); return next; })}>
                <ChevronDown size={12} className={`project-chevron ${collapsed.has(g.key) && !query ? "-rotate-90" : ""}`} />
                <FolderOpen size={17} /><span>{g.name}</span>
              </button>
              <button className="icon-button project-new" title={`在 ${g.name} 中新建聊天`} aria-label={`在 ${g.name} 中新建聊天`}
                onClick={() => onNew(g.project ?? { id: "", name: g.name, dir: g.dir, created_at: 0 })}><SquarePen size={14} /></button>
            </div>
            <AnimatePresence initial={false}>
            {(!collapsed.has(g.key) || query) && <MotionLayer key="threads" className="project-threads"
              initial={enabled && g.rows.length <= 40 ? { height: 0, opacity: 0 } : false} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              transition={{ duration: enabled && g.rows.length <= 40 ? 0.14 : 0 }}>
            {g.rows.map(renderSession)}
            </MotionLayer>}
            </AnimatePresence>
          </section>
        ))}
      </div>
      <div className="sidebar-footer"><button className="nav-action" onClick={onSettings}><Settings size={17} />设置</button></div>
    </aside>
  );

  function renderSession(session: SessionGroup) {
              const first = session.turns[0];
              const latest = session.turns[session.turns.length - 1];
              const active = session.turns.some((t) => t.id === selectedId);
              const running = session.turns.some((t) => t.status === "running");
              return (
                <div key={session.key} className="session-group">
                  <div className="thread-row session-row">
                    <button className={`thread-item session-item ${active ? "is-active" : ""}`}
                      aria-current={active ? "page" : undefined}
                      aria-label={first.prompt}
                      title={first.prompt} onClick={() => onSelect(latest.id)}>
                      <span className="thread-title">{first.prompt}</span>
                      {running && <LoaderCircle size={13} className="animate-spin shrink-0" aria-label="运行中" />}
                      {!running && latest.status === "failed" && <CircleAlert size={13} className="shrink-0 text-red-600" aria-label="失败" />}
                    </button>
                    <button className="thread-delete" title="删除会话" aria-label={`删除会话 ${first.prompt}`}
                      onClick={() => onDelete(latest.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
  }
});
