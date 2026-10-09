import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "../api";
import { IconBrandMark } from "./icons";

/** 自绘标题栏：拖拽区 + 最小化/最大化/关闭（原生装饰已关闭） */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const win = inTauri ? getCurrentWindow() : null;

  useEffect(() => {
    if (!win) return;
    let unlisten: (() => void) | undefined;
    win.onResized(({ payload: _size }) => {
      // 尺寸变化时同步最大化态（宽高等于屏幕工作区即视为最大化）
      getCurrentWindow()
        .isMaximized()
        .then(setMaximized)
        .catch(() => {});
    });
    getCurrentWindow()
      .isMaximized()
      .then(setMaximized)
      .catch(() => {});
    return () => unlisten?.();
  }, [win]);

  if (!inTauri || !win) return null; // 纯浏览器预览：无窗口系统

  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 select-none items-center justify-between border-b border-stone-800/60 bg-stone-950 pl-3"
    >
      {/* 品牌 + 拖拽区（data-tauri-drag-region 已含双击最大化） */}
      <div className="flex items-center gap-2" data-tauri-drag-region>
        <span className="text-emerald-400">
          <IconBrandMark size={16} />
        </span>
        <span className="text-xs font-medium text-stone-300">Agent Deck</span>
      </div>

      {/* 窗控按钮（Windows 习惯：右对齐，窄描边图形） */}
      <div className="flex items-center">
        <button
          onClick={() => win.minimize()}
          title="最小化"
          className="flex h-10 w-11 items-center justify-center text-stone-300 transition-colors hover:bg-stone-800"
        >
          <svg width="11" height="11" viewBox="0 0 11 11">
            <path d="M0 5.5h11" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          onClick={() => win.toggleMaximize()}
          title={maximized ? "还原" : "最大化"}
          className="flex h-10 w-11 items-center justify-center text-stone-300 transition-colors hover:bg-stone-800"
        >
          {maximized ? (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor">
              <path d="M2.5 0.5h6v2M8.5 2.5h2v6M8.5 8.5v2h-6M2.5 8.5v-2h-2v-6h2" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor">
              <rect x="0.5" y="0.5" width="10" height="10" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          onClick={() => win.close()}
          title="关闭"
          className="flex h-10 w-11 items-center justify-center text-stone-300 transition-colors hover:bg-red-600 hover:text-white"
        >
          <svg width="11" height="11" viewBox="0 0 11 11">
            <path d="M0.5 0.5l10 10M10.5 0.5l-10 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </header>
  );
}

