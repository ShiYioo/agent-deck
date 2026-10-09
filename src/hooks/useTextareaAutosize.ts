import { useLayoutEffect, type RefObject } from "react";

export function useTextareaAutosize(ref: RefObject<HTMLTextAreaElement>, value: string) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 82), 220)}px`;
  }, [ref, value]);

  useLayoutEffect(() => {
    const element = ref.current;
    const container = element?.parentElement;
    if (!element || !container) return;
    let width = container.clientWidth;
    let frame: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || Math.abs(entry.contentRect.width - width) < 1) return;
      width = entry.contentRect.width;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        element.style.height = "auto";
        element.style.height = `${Math.min(Math.max(element.scrollHeight, 82), 220)}px`;
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ref]);
}
