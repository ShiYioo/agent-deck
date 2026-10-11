import { memo } from "react";
import { Home, Clock3, Search, FolderPlus, Settings2 } from "lucide-react";

export const NavigationRail = memo(function NavigationRail({
  view, settingsOpen, onProjects, onRecent, onSearch, onCreateProject, onSettings,
}: {
  view: "projects" | "recent";
  settingsOpen: boolean;
  onProjects: () => void;
  onRecent: () => void;
  onSearch: () => void;
  onCreateProject: () => void;
  onSettings: () => void;
}) {
  return (
    <nav className="navigation-rail" aria-label="工作台导航">
      <button className={`rail-button ${!settingsOpen && view === "projects" ? "is-active" : ""}`}
        title="项目工作台" aria-label="项目工作台" aria-current={!settingsOpen && view === "projects" ? "page" : undefined}
        onClick={onProjects}><Home size={20} /></button>
      <button className={`rail-button ${!settingsOpen && view === "recent" ? "is-active" : ""}`}
        title="最近聊天" aria-label="最近聊天" aria-current={!settingsOpen && view === "recent" ? "page" : undefined}
        onClick={onRecent}><Clock3 size={20} /></button>
      <button className="rail-button" title="查找聊天" aria-label="查找聊天" onClick={onSearch}><Search size={20} /></button>
      <button className="rail-button" title="创建项目" aria-label="创建项目" onClick={onCreateProject}><FolderPlus size={20} /></button>
      <div className="rail-spacer" />
      <button className={`rail-button ${settingsOpen ? "is-active" : ""}`} title="打开设置" aria-label="打开设置"
        aria-current={settingsOpen ? "page" : undefined} onClick={onSettings}><Settings2 size={20} /></button>
    </nav>
  );
});
