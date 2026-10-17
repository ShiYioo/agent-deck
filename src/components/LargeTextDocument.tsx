import { useEffect, useRef, useState } from "react";
import { readTaskTextWindow, type TextWindow } from "../api";

/** Sparse backend index + bounded viewport. Scroll position addresses the entire file. */
export default function LargeTextDocument({ taskId, path }: { taskId: string; path: string }) {
  const [window, setWindow] = useState<TextWindow | null>(null);
  const [top, setTop] = useState(0);
  const [error, setError] = useState("");
  const [line, setLine] = useState("");
  const [viewportHeight, setViewportHeight] = useState(600);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const total = window?.total ?? 1;
  const height = Math.min(total * 24, 8_000_000);
  const visibleCount = Math.ceil(viewportHeight / 24);
  const maxAnchor = Math.max(0, total - visibleCount);
  const anchor = Math.min(maxAnchor, Math.floor(top / Math.max(1, height - viewportHeight) * maxAnchor));
  const start = Math.max(0, anchor - 12);
  const requested = Math.floor(start / 64) * 64;
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      readTaskTextWindow(taskId, path, requested).then((data) => { if (alive) { setWindow(data); setError(""); } })
        .catch((e) => { if (alive) setError(String(e)); });
    }, 35);
    return () => { alive = false; clearTimeout(timer); };
  }, [taskId, path, requested]);
  const visible = window?.lines.flatMap((text, i) => {
    const number = window.start + i;
    const y = top + (number - anchor) * 24;
    return y >= top - 300 && y <= top + 2500 ? [{ text, number, y }] : [];
  }) ?? [];
  return <div className="large-text-document">
    <div className="file-preview-toolbar">
      <span>{window ? `${total.toLocaleString()} 行 · 按需读取` : "正在建立行索引…"}</span>
      <form onSubmit={(event) => {
        event.preventDefault();
        const number = Math.max(1, Math.min(total, Number(line) || 1));
        if (viewport.current) viewport.current.scrollTop = (number - 1) / Math.max(1, maxAnchor) * Math.max(0, height - viewportHeight);
      }}><input aria-label="跳转到行" inputMode="numeric" placeholder="跳转到行…" value={line} onChange={(e) => setLine(e.target.value)} /><button>跳转</button></form>
    </div>
    {error && <p className="file-preview-notice" role="alert">{error}</p>}
    <div className="file-lines" ref={viewport} aria-label="完整大文件" onScroll={(event) => setTop(event.currentTarget.scrollTop)}>
      <div className="file-lines-spacer" style={{ height }}>
        {visible.map(({ number, text, y }) => <div key={number} className="file-line" data-line={number + 1} style={{ top: y }}>
          <span className="file-line-number">{number + 1}</span><span className="file-line-content">{text || " "}</span>
        </div>)}
      </div>
    </div>
  </div>;
}
