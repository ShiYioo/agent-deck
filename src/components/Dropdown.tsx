import { useEffect, useRef, useState } from "react";

import { IconCheck, IconChevronDown } from "./icons";

export type DropdownOption = {
  value: string;
  label: string;
};

/** 自绘下拉框：药丸触发器 + 向上弹出的菜单（composer 贴近视口底部）。
 *  支持点击外部关闭、Escape、选中勾标与弹性入场。 */
export function Dropdown({
  value,
  onChange,
  options,
  dotColor,
  disabled,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  dotColor?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.value === value);

  // 点击外部关闭 + Escape
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
        <span className="font-medium">{current?.label ?? value}</span>
        <IconChevronDown
          size={12}
          className={`text-stone-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="anim-pop absolute bottom-full left-0 z-20 mb-1.5 min-w-[9rem] origin-bottom-left rounded-xl border border-stone-200 bg-white py-1 shadow-[var(--shadow-2)]"
        >
          {options.map((o) => {
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
                {selected && (
                  <IconCheck
                    size={13}
                    className="shrink-0 text-emerald-600"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
