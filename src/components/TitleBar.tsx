import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "../api";
import { PanelLeft, Minus, Square, Copy, X } from "lucide-react";

/** 自绘标题栏：拖拽区 + 最小化/最大化/关闭（原生装饰已关闭，配色随 UI 亮色主题） */
export function TitleBar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
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
        <button className="icon-button" onClick={onToggleSidebar} title="切换项目侧栏" aria-label="切换项目侧栏"><PanelLeft size={17} /></button>
        <span data-tauri-drag-region>AgentDeck</span>
      </div>

      {/* 窗控按钮（Windows 习惯：右对齐，窄描边图形） */}
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => win?.minimize()} title="最小化" aria-label="最小化">
          <Minus size={15} strokeWidth={1.5} />
        </button>
        <button
          className="titlebar-btn"
          onClick={() => win?.toggleMaximize()}
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原" : "最大化"}
        >
          {maximized ? <Copy size={13} strokeWidth={1.5} /> : <Square size={13} strokeWidth={1.5} />}
        </button>
        <button className="titlebar-btn close" onClick={() => win?.close()} title="关闭" aria-label="关闭">
          <X size={17} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}
