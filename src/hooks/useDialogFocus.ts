import { useLayoutEffect, useRef } from "react";

/** Keep keyboard navigation in a modal and restore its launcher's focus. */
export function useDialogFocus(active: boolean, initialSelector?: string) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));
    const initial = initialSelector ? root.querySelector<HTMLElement>(initialSelector) : controls()[0];
    (initial ?? root).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first) {
        event.preventDefault();
        root.focus();
      } else if (!root.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous.current?.isConnected && previous.current !== document.body) previous.current.focus();
    };
  }, [active, initialSelector]);
  return ref;
}
