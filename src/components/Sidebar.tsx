import type { TaskRow } from "../types";

/** 取路径末段作为项目名（与 Codex 的项目分组一致） */
export function projectName(cwd: string): string {
  const norm = cwd.replace(/[\\/]+$/, "");
  const seg = norm.split(/[\\/]/).filter(Boolean).pop();
  return seg || norm || "未设置目录";
}

/** harness 身份色：贯穿侧栏、任务头部、空态 */
export const HARNESS_ACCENT: Record<string, string> = {
  zcode: "var(--harness-zcode)",
  codex: "var(--harness-codex)",
};

/** 左侧边栏：按项目（工作目录）分组的任务列表，带选中信号条与运行脉冲点 */
export function Sidebar({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: TaskRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // 按项目分组，保持后端返回的时间倒序
  const groups: { name: string; rows: TaskRow[] }[] = [];
  for (const t of tasks) {
    const name = projectName(t.cwd);
    const last = groups[groups.length - 1];
    if (last && last.name === name) {
      last.rows.push(t);
    } else {
      groups.push({ name, rows: [t] });
    }
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-zinc-100 bg-zinc-50/80">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-lg font-semibold tracking-tight">AgentDeck</span>
        <span className="text-xs text-zinc-300">⌄</span>
      </div>

      <div className="flex items-center gap-2 px-4 pb-3 text-zinc-400">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="ml-auto">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="px-4 pb-1 text-xs font-medium text-zinc-400">项目</div>
        {groups.length === 0 && (
          <div className="px-4 py-6 text-xs text-zinc-400">还没有任务</div>
        )}
        {groups.map((g) => {
          const hasRunning = g.rows.some((r) => r.status === "running");
          return (
            <div key={g.name + g.rows[0]?.id} className="mb-2">
              <div className="mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700">
                <span className="text-zinc-400">📁</span>
                <span className="truncate">{g.name}</span>
                {hasRunning && (
                  <span className="pulse-dot ml-auto h-2 w-2 rounded-full" />
                )}
              </div>
              {g.rows.map((t) => {
                const active = selectedId === t.id;
                return (
                  <button
                    key={t.id}
                    data-active={active}
                    onClick={() => onSelect(t.id)}
                    style={{ ["--harness-accent" as string]: HARNESS_ACCENT[t.harness] }}
                    className={`side-item group mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg py-1.5 pl-6 pr-2 text-left text-sm ${
                      active
                        ? "bg-zinc-200/70 text-zinc-900"
                        : "text-zinc-600 hover:bg-zinc-200/50"
                    }`}
                  >
                    <span className="truncate">{t.prompt}</span>
                    {t.status === "running" && (
                      <span className="pulse-dot ml-auto h-2 w-2 shrink-0 rounded-full" />
                    )}
                    {t.status === "failed" && (
                      <span className="ml-auto shrink-0 text-xs text-red-500">✗</span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
