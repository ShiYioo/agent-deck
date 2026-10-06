import type { TaskRow } from "../types";

const STATUS_DOT: Record<string, string> = {
  running: "bg-amber-400 animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-zinc-500",
};

function fmtTime(millis: number): string {
  const d = new Date(millis);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 左侧任务栏：新任务入口 + 历史/并行任务列表 */
export function Sidebar({
  tasks,
  selectedId,
  onSelect,
  onNew,
}: {
  tasks: TaskRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/60">
      <div className="p-3">
        <button
          onClick={onNew}
          className="w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          ＋ 新任务
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {tasks.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-zinc-600">暂无任务</div>
        )}
        {tasks.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`mb-1 w-full rounded-md px-3 py-2 text-left transition-colors ${
              selectedId === t.id ? "bg-zinc-800" : "hover:bg-zinc-900"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[t.status] ?? "bg-zinc-500"}`} />
              <span className="font-mono text-xs text-emerald-400">{t.harness}</span>
              <span className="ml-auto text-[10px] text-zinc-600">{fmtTime(t.created_at)}</span>
            </div>
            <div className="mt-0.5 truncate text-xs text-zinc-300">{t.prompt}</div>
          </button>
        ))}
      </div>
    </aside>
  );
}
