/** 最左侧窄图标栏（对齐 Codex 客户端的 rail），全部使用内联 SVG 线条图标 */
export function Rail({ onNew }: { onNew: () => void }) {
  return (
    <nav className="flex h-full w-14 shrink-0 flex-col items-center border-r border-zinc-100 bg-zinc-50 py-4">
      {/* 应用标识 */}
      <div className="mb-6 flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-900 text-sm font-bold text-white">
        ⌘
      </div>
      <button
        onClick={onNew}
        title="新任务"
        className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <button
        title="历史任务（见侧栏）"
        className="mt-2 flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-200/70 hover:text-zinc-700"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
      </button>
      <div className="mt-auto">
        <button
          title="设置（开发中）"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-300 hover:bg-zinc-200/70 hover:text-zinc-600"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
