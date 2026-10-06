import { useEffect, useMemo, useRef, useState } from "react";

import { IconCheck, IconChevronDown, IconSearch } from "./icons";

export type DropdownOption = {
  value: string;
  label: string;
};

/** 自绘下拉框：药丸触发器 + 向上弹出的菜单（composer 贴近视口底部）。
 *  长列表：max-h 滚动 + 搜索框过滤 + 按 groupBy 分组渲染。
 *  支持点击外部关闭、Escape、选中勾标与弹性入场。 */
export function Dropdown({
  value,
  onChange,
  options,
  dotColor,
  disabled,
  title,
  searchable = false,
  groupBy,
}: {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  dotColor?: string;
  disabled?: boolean;
  title?: string;
  /** 显示搜索框（长列表建议开启） */
  searchable?: boolean;
  /** 分组函数：返回该选项的组名（如 provider 名），按出现顺序分组 */
  groupBy?: (value: string, label: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.value === value);

  // 打开时清空过滤；点击外部/Escape 关闭
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  // 分组（保持出现顺序）
  const groups = useMemo(() => {
    if (!groupBy) return null;
    const map = new Map<string, DropdownOption[]>();
    for (const o of filtered) {
      const g = groupBy(o.value, o.label) || "其他";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(o);
    }
    return [...map.entries()];
  }, [filtered, groupBy]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
          open
            ? "border-stone-300 bg-stone-50 text-stone-800"
            : "border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50"
        } disabled:pointer-events-none disabled:opacity-50`}
      >
        {dotColor && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
        )}
        <span className="max-w-40 truncate font-medium">
          {current?.label ?? value}
        </span>
        <IconChevronDown
          size={12}
          className={`text-stone-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="anim-pop absolute bottom-full left-0 z-20 mb-1.5 w-72 origin-bottom-left overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[var(--shadow-2)]">
          {searchable && (
            <div className="border-b border-stone-100 p-2">
              <div className="flex items-center gap-2 rounded-lg bg-stone-100 px-2 py-1.5">
                <IconSearch size={13} className="shrink-0 text-stone-400" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索模型…"
                  className="min-w-0 flex-1 bg-transparent text-xs text-stone-700 outline-none placeholder:text-stone-400"
                />
              </div>
            </div>
          )}

          <div className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-stone-400">
                无匹配项
              </div>
            )}
            {groups
              ? groups.map(([group, opts]) => (
                  <div key={group}>
                    <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
                      {group}
                    </div>
                    {opts.map(renderOption)}
                  </div>
                ))
              : filtered.map(renderOption)}
          </div>
        </div>
      )}
    </div>
  );

  function renderOption(o: DropdownOption) {
    const selected = o.value === value;
    return (
      <button
        key={o.value}
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => {
          onChange(o.value);
          setOpen(false);
        }}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
          selected
            ? "font-medium text-stone-900"
            : "text-stone-600 hover:bg-stone-100"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{o.label}</span>
        {selected && <IconCheck size={13} className="shrink-0 text-emerald-600" />}
      </button>
    );
  }
}
