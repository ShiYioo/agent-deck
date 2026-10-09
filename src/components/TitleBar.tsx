import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "../api";
import { IconBrandMark } from "./icons";

/** 自绘标题栏：拖拽区 + 最小化/最大化/关闭（原生装饰已关闭，配色随 UI 亮色主题） */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  // 窗口句柄：浏览器预览或 IPC 环境不完整（如 e2e mock）时为 null，窗控点击为 no-op
  const win = useMemo(() => {
    if (!inTauri) return null;
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!win) return;
    const promise = win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    });
    win.isMaximized().then(setMaximized).catch(() => {});
    return () => {
      promise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [win]);

  return (
    <header className="titlebar" data-tauri-drag-region>
      {/* 品牌 + 拖拽区（data-tauri-drag-region 已含双击最大化） */}
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="titlebar-mark">
          <IconBrandMark size={14} />
        </span>
        <span>Agent Deck</span>
      </div>

      {/* 窗控按钮（Windows 习惯：右对齐，窄描边图形） */}
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => win?.minimize()} title="最小化" aria-label="最小化">
          <svg width="11" height="11" viewBox="0 0 11 11">
            <path d="M0 5.5h11" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          className="titlebar-btn"
          onClick={() => win?.toggleMaximize()}
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原" : "最大化"}
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
        <button className="titlebar-btn close" onClick={() => win?.close()} title="关闭" aria-label="关闭">
          <svg width="11" height="11" viewBox="0 0 11 11">
            <path d="M0.5 0.5l10 10M10.5 0.5l-10 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </header>
  );
}
