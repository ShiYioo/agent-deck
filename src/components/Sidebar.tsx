import type { TaskRow } from "../types";
import { IconBell, IconSearch, IconFolder, IconXCircle } from "./icons";

/** 取路径末段作为项目名（与 Codex 的项目分组一致） */
export function projectName(cwd: string): string {
  const norm = cwd.replace(/[\\/]+$/, "");
  const seg = norm.split(/[\\/]/).filter(Boolean).pop();
  return seg || norm || "未设置目录";
}

/** harness 身份色：贯穿侧栏、任务头部、发送键 */
export const HARNESS_ACCENT: Record<string, string> = {
  zcode: "var(--harness-zcode)",
  codex: "var(--harness-codex)",
  deck: "#8b5cf6", // AgentDeck 自有运行时：紫
  opencode: "#ea580c", // OpenCode：橙
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
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-stone-200/70 bg-stone-100/60">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-lg font-semibold tracking-tight">AgentDeck</span>
        <IconChevronTiny />
      </div>

      <div className="flex items-center gap-2 px-4 pb-3 text-stone-400">
        <IconBell size={15} />
        <IconSearch size={15} className="ml-auto" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="px-4 pb-1 text-xs font-medium text-stone-400">项目</div>
        {groups.length === 0 && (
          <div className="px-4 py-6 text-xs text-stone-400">还没有任务</div>
        )}
        {groups.map((g) => {
          const hasRunning = g.rows.some((r) => r.status === "running");
          return (
            <div key={g.name + g.rows[0]?.id} className="mb-2">
              <div className="mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-stone-700">
                <IconFolder size={15} className="shrink-0 text-stone-400" />
                <span className="truncate">{g.name}</span>
                {hasRunning && (
                  <span className="pulse-dot ml-auto h-2 w-2 shrink-0 rounded-full" />
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
                        ? "bg-stone-200/80 text-stone-900"
                        : "text-stone-600 hover:bg-stone-200/50"
                    }`}
                  >
                    <span className="truncate">{t.prompt}</span>
                    {t.status === "running" && (
                      <span className="pulse-dot ml-auto h-2 w-2 shrink-0 rounded-full" />
                    )}
                    {t.status === "failed" && (
                      <IconXCircle size={14} className="ml-auto shrink-0 text-red-500" />
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

function IconChevronTiny() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-stone-300">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
