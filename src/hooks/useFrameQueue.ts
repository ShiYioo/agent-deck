import { useCallback, useEffect, useRef } from "react";

/** Coalesce IPC bursts, with a bounded timer when the webview stops painting. */
export function useFrameQueue<T>(onFlush: (items: T[]) => void) {
  const callback = useRef(onFlush);
  callback.current = onFlush;
  const items = useRef<T[]>([]);
  const frame = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(true);

  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (timer.current !== null) clearTimeout(timer.current);
    frame.current = null;
    timer.current = null;
  }, []);
  const flush = useCallback(() => {
    cancel();
    if (!active.current || !items.current.length) return;
    const batch = items.current;
    items.current = [];
    callback.current(batch);
  }, [cancel]);
  const enqueue = useCallback((item: T) => {
    if (!active.current) return;
    items.current.push(item);
    if (timer.current !== null) return;
    timer.current = setTimeout(flush, 64);
    if (!document.hidden) frame.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => {
    active.current = true;
    document.addEventListener("visibilitychange", flush);
    return () => {
      active.current = false;
      cancel();
      items.current = [];
      document.removeEventListener("visibilitychange", flush);
    };
  }, [cancel, flush]);

  return { enqueue, flush };
}
