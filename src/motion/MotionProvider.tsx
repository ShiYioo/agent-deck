import { createContext, forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { LazyMotion, MotionConfig, m, useIsPresent, type HTMLMotionProps } from "motion/react";

const loadFeatures = () => import("./features").then((module) => module.default);
const preference = () => window.matchMedia("(prefers-reduced-motion: reduce)");
const snapshot = () => `${preference().matches}:${document.hidden}`;
const subscribe = (update: () => void) => {
  const media = preference();
  media.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    media.removeEventListener("change", update);
    document.removeEventListener("visibilitychange", update);
  };
};

const MotionContext = createContext({ enabled: false, reduced: true });
const easing = [0.22, 1, 0.36, 1] as const;
const presets = {
  fade: { duration: 0.12, offset: { opacity: 0 } },
  menu: { duration: 0.14, offset: { opacity: 0, y: 4 } },
  dialog: { duration: 0.18, offset: { opacity: 0, y: 6 } },
  sidebar: { duration: 0.18, offset: { opacity: 0, x: -12 } },
  scene: { duration: 0.14, offset: { opacity: 0 } },
};
export type MotionPreset = keyof typeof presets;

export function MotionProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribe, snapshot, () => "true:false");
  const [reduced, hidden] = state.split(":").map((value) => value === "true");
  const enabled = !reduced && !hidden;
  useEffect(() => {
    document.documentElement.dataset.motion = hidden ? "paused" : reduced ? "reduced" : "full";
    return () => { delete document.documentElement.dataset.motion; };
  }, [reduced, hidden]);
  return (
    <MotionContext.Provider value={{ enabled, reduced }}>
      <LazyMotion features={loadFeatures} strict>
        <MotionConfig reducedMotion={enabled ? "never" : "always"} transition={{ duration: enabled ? 0.14 : 0, ease: easing }}>
          {children}
        </MotionConfig>
      </LazyMotion>
    </MotionContext.Provider>
  );
}

export const useMotionPolicy = () => useContext(MotionContext);

type LayerProps = HTMLMotionProps<"div"> & { preset?: MotionPreset };

export const MotionLayer = forwardRef<HTMLDivElement, LayerProps>(function MotionLayer({
  preset = "fade", style, children, ...props
}, forwardedRef) {
  const { enabled } = useMotionPolicy();
  const present = useIsPresent();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const assignRef = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
    if (typeof forwardedRef === "function") forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }, [forwardedRef]);
  useLayoutEffect(() => {
    elementRef.current?.toggleAttribute("inert", !present);
  }, [present]);
  const { duration, offset } = presets[preset];
  return (
    <m.div ref={assignRef} initial={enabled ? offset : false} animate={{ opacity: 1, x: 0, y: 0 }}
      exit={enabled ? offset : { opacity: 1, x: 0, y: 0 }}
      transition={{ duration: enabled ? duration : 0, ease: easing }}
      data-motion-layer={preset} data-motion-state={present ? "present" : "exiting"}
      aria-hidden={present ? undefined : true}
      style={{ ...style, pointerEvents: present ? style?.pointerEvents : "none" }} {...props}>
      {children}
    </m.div>
  );
});
