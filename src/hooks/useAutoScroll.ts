import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export function useAutoScroll(revision: number) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const frame = useRef<number | null>(null);
  const smoothScroll = useRef(false);
  const smoothTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [follow, setFollow] = useState(true);
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
      if (viewport && following.current) viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);
  const onScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setHasOverflow(viewport.scrollHeight > viewport.clientHeight + 4);
    const nearBottom = distance < DETACH_THRESHOLD_PX;
    if (smoothScroll.current && !nearBottom) return;
    if (nearBottom) smoothScroll.current = false;
    if (following.current !== nearBottom) {
      following.current = nearBottom;
      setFollow(nearBottom);
    }
  }, []);
  const pause = useCallback(() => {
    following.current = false;
    setFollow(false);
    cancel();
    smoothScroll.current = false;
    if (smoothTimer.current !== null) clearTimeout(smoothTimer.current);
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTo({ top: viewport.scrollTop, behavior: "auto" });
  }, [cancel]);
  const scrollToBottom = useCallback(() => {
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

  useLayoutEffect(schedule, [revision, schedule]);
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    observer.observe(content);
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) pause(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pause();
    };
    let touchY = 0;
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (y > touchY) pause();
      touchY = y;
    };
    const visibility = () => { if (document.hidden) cancel(); else schedule(); };
    viewport.addEventListener("wheel", wheel, { passive: true });
    viewport.addEventListener("keydown", key);
    viewport.addEventListener("touchstart", touchStart, { passive: true });
    viewport.addEventListener("touchmove", touchMove, { passive: true });
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
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [cancel, pause, schedule]);

  return { viewportRef, contentRef, follow, hasOverflow, onScroll, scrollToBottom };
}
