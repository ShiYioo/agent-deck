import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const readingPositions = new Map<string, { top: number; follow: boolean }>();

export function useAutoScroll(revision: number, positionKey = "") {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const saved = readingPositions.get(positionKey);
  const following = useRef(saved?.follow ?? true);
  const restored = useRef(false);
  const userScrollUntil = useRef(0);
  const frame = useRef<number | null>(null);
  const smoothScroll = useRef(false);
  const smoothTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [follow, setFollow] = useState(saved?.follow ?? true);
  const [hasOverflow, setHasOverflow] = useState(false);
  /** 离底判定阈值（ZCode ConversationTimeline 同款 48px） */
  const DETACH_THRESHOLD_PX = 48;

  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const schedule = useCallback(() => {
    if (!following.current || smoothScroll.current || frame.current !== null || document.hidden) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const viewport = viewportRef.current;
      if (viewport) {
        setHasOverflow(viewport.scrollHeight > viewport.clientHeight + 4);
        if (following.current) viewport.scrollTop = viewport.scrollHeight;
      }
    });
  }, []);
  const onScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setHasOverflow(viewport.scrollHeight > viewport.clientHeight + 4);
    const nearBottom = distance < DETACH_THRESHOLD_PX;
    // Resize/folding/programmatic scroll updates geometry, never the user's reading intent.
    if (performance.now() > userScrollUntil.current) return;
    if (smoothScroll.current && !nearBottom) return;
    if (nearBottom) smoothScroll.current = false;
    if (following.current !== nearBottom) {
      following.current = nearBottom;
      setFollow(nearBottom);
    }
  }, []);
  const pause = useCallback(() => {
    restored.current = true;
    following.current = false;
    setFollow(false);
    cancel();
    smoothScroll.current = false;
    if (smoothTimer.current !== null) clearTimeout(smoothTimer.current);
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTo({ top: viewport.scrollTop, behavior: "auto" });
  }, [cancel]);
  const scrollToBottom = useCallback(() => {
    restored.current = true;
    cancel();
    const viewport = viewportRef.current;
    if (!viewport) return;
    following.current = true;
    setFollow(true);
    if (smoothTimer.current !== null) clearTimeout(smoothTimer.current);
    smoothScroll.current = false;
    // 贴底必须 instant（scrollTop 赋值）：smooth 的中间帧会被 scroll 判定
    // 误读为「离底」，把用户刚点的回底又变成 detached（ZCode ConversationTimeline）。
    viewport.scrollTop = viewport.scrollHeight;
  }, [cancel, schedule]);

  const restorePosition = useCallback(() => {
    const viewport = viewportRef.current;
    if (!restored.current && saved && !saved.follow && viewport) {
      viewport.scrollTop = saved.top;
      // Lazy content may still be mounting; retry after its height becomes available.
      if (viewport.scrollHeight - viewport.clientHeight >= saved.top) restored.current = true;
    }
  }, [saved]);
  useLayoutEffect(() => {
    if (revision > 0) restorePosition();
    schedule();
  }, [revision, schedule, restorePosition]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    return () => {
      if (viewport && positionKey) {
        readingPositions.set(positionKey, { top: viewport.scrollTop, follow: following.current });
        if (readingPositions.size > 100) readingPositions.delete(readingPositions.keys().next().value!);
      }
    };
  }, [positionKey]);
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      restorePosition();
      setHasOverflow(viewport.scrollHeight > viewport.clientHeight + 4);
      schedule();
    });
    observer.observe(viewport);
    observer.observe(content);
    const userScroll = () => { restored.current = true; userScrollUntil.current = performance.now() + 600; };
    let draggingScrollbar = false;
    const pointerDown = (event: PointerEvent) => {
      const rect = viewport.getBoundingClientRect();
      draggingScrollbar = event.pointerType === "mouse" && event.clientX >= rect.right - 16;
      if (draggingScrollbar) userScroll();
    };
    const pointerMove = () => { if (draggingScrollbar) userScroll(); };
    const pointerUp = () => { draggingScrollbar = false; };
    const wheel = (event: WheelEvent) => { userScroll(); if (event.deltaY < 0) pause(); };
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable=true]")) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) userScroll();
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pause();
    };
    let touchY = 0;
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; };
    const touchMove = (event: TouchEvent) => {
      userScroll();
      const y = event.touches[0]?.clientY ?? touchY;
      if (y > touchY) pause();
      touchY = y;
    };
    const visibility = () => { if (document.hidden) cancel(); else schedule(); };
    viewport.addEventListener("wheel", wheel, { passive: true });
    viewport.addEventListener("keydown", key);
    viewport.addEventListener("touchstart", touchStart, { passive: true });
    viewport.addEventListener("touchmove", touchMove, { passive: true });
    viewport.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    document.addEventListener("visibilitychange", visibility);
    setHasOverflow(viewport.scrollHeight > viewport.clientHeight + 4);
    return () => {
      cancel();
      if (smoothTimer.current !== null) clearTimeout(smoothTimer.current);
      observer.disconnect();
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("keydown", key);
      viewport.removeEventListener("touchstart", touchStart);
      viewport.removeEventListener("touchmove", touchMove);
      viewport.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [cancel, pause, schedule, restorePosition]);

  return { viewportRef, contentRef, follow, hasOverflow, onScroll, scrollToBottom };
}
