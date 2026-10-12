import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { MotionLayer } from "../motion/MotionProvider";

import { Check, ChevronDown, Search } from "lucide-react";

export type DropdownOption = {
  value: string;
  label: string;
  /** 小徽章（如「免费」），渲染在标签右侧 */
  tag?: string;
  /** 显式分组名（优先于 groupBy 回调推导） */
  group?: string;
};

/** Portaled menu with viewport-aware positioning and interruptible presence. */
export function Dropdown({
  value,
  onChange,
  options,
  dotColor,
  disabled,
  title,
  searchable = false,
  ghost = false,
  groupBy,
  icon,
  iconOnly = false,
  displayLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  dotColor?: string;
  disabled?: boolean;
  title?: string;
  /** 显示搜索框（长列表建议开启） */
  searchable?: boolean;
  /** ghost 触发器：无边框、灰字（未选择时的安静占位） */
  ghost?: boolean;
  /** 分组函数：返回该选项的组名（如 provider 名），按出现顺序分组 */
  groupBy?: (value: string, label: string) => string;
  icon?: ReactNode;
  iconOnly?: boolean;
  displayLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusOnOpen = useRef(false);
  const menuId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 320 });
  const current = options.find((o) => o.value === value);

  // 打开时清空过滤；点击外部/Escape 关闭
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const minTop = (document.querySelector(".titlebar")?.getBoundingClientRect().bottom ?? 0) + 12;
      const width = Math.min(280, window.innerWidth - 24);
      const height = Math.min(menuRef.current?.scrollHeight ?? 320, 320);
      const above = Math.max(0, rect.top - minTop - 6);
      const below = Math.max(0, window.innerHeight - rect.bottom - 18);
      const useAbove = above >= height || above >= below;
      const available = useAbove ? above : below;
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: useAbove ? Math.max(minTop, rect.top - Math.min(height, available) - 6) : rect.bottom + 6,
        width,
        maxHeight: Math.min(320, available),
      });
    };
    update();
    if (focusOnOpen.current) {
      const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      (selected ?? menuRef.current?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus();
      focusOnOpen.current = false;
    }
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, query, options.length]);

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
      const g = o.group || groupBy(o.value, o.label) || "其他";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(o);
    }
    return [...map.entries()];
  }, [filtered, groupBy]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => { focusOnOpen.current = false; setOpen((v) => !v); }}
        className={`dropdown-trigger ${iconOnly ? "icon-button dropdown-icon-trigger" : ""} ${ghost ? "text-stone-400" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            focusOnOpen.current = true;
            setOpen(true);
          }
        }}
      >
        {dotColor && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
        )}
        {icon}
        {!iconOnly && <span className="max-w-40 truncate">
          {displayLabel ?? current?.label ?? value}
        </span>}
        {!iconOnly && <ChevronDown
          size={12}
          className={`text-stone-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />}
      </button>

      {createPortal(<AnimatePresence>
        {open && <MotionLayer preset="menu" key={menuId} ref={menuRef} id={menuId} className="dropdown-menu" style={position}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
            if (!buttons.length) return;
            e.preventDefault();
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next].focus();
          }}>
          {searchable && (
            <div className="border-b border-stone-100 p-2">
              <div className="flex items-center gap-2 rounded-lg bg-stone-100 px-2 py-1.5">
                <Search size={13} className="shrink-0 text-stone-400" />
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

          <div role="listbox" aria-label={title} className="overflow-y-auto py-1" style={{ maxHeight: position.maxHeight - (searchable ? 50 : 0) }}>
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
        </MotionLayer>}
        </AnimatePresence>, document.body
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
          triggerRef.current?.focus();
        }}
        className={`dropdown-option flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
          selected
            ? "font-medium text-stone-900"
            : "text-stone-600 hover:bg-stone-100"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{o.label}</span>
        {o.tag && (
          <span className="shrink-0 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-medium text-emerald-700">
            {o.tag}
          </span>
        )}
         {selected && <Check size={13} className="shrink-0 text-stone-600" />}
      </button>
    );
  }
}
