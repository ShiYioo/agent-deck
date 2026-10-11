import { useLayoutEffect, type RefObject } from "react";

function resizeTextarea(element: HTMLTextAreaElement) {
  const style = getComputedStyle(element);
  const min = Number.parseFloat(style.minHeight) || 64;
  const max = Number.parseFloat(style.maxHeight) || 220;
  element.style.height = "auto";
  element.style.height = `${Math.min(Math.max(element.scrollHeight, min), max)}px`;
}

export function useTextareaAutosize(ref: RefObject<HTMLTextAreaElement>, value: string) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    resizeTextarea(element);
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
        resizeTextarea(element);
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ref]);
}
