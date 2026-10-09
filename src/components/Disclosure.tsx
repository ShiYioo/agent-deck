import { useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { MotionLayer, useMotionPolicy } from "../motion/MotionProvider";

export function Disclosure({ title, children, className, defaultOpen = false }: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [keepOpen, setKeepOpen] = useState(defaultOpen);
  const current = useRef(expanded);
  current.current = expanded;
  const id = useId();
  const { enabled } = useMotionPolicy();
  return (
    <details className={className} open={expanded || keepOpen}>
      <summary aria-expanded={expanded} aria-controls={id} onClick={(event) => {
        event.preventDefault();
        setKeepOpen(true);
        setExpanded((value) => !value);
      }}>{title}</summary>
      <AnimatePresence initial={false} onExitComplete={() => { if (!current.current) setKeepOpen(false); }}>
        {expanded && <MotionLayer key="content" id={id} className="disclosure-content"
          initial={enabled ? { height: 0, opacity: 0 } : false} animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}>
          {children}
        </MotionLayer>}
      </AnimatePresence>
    </details>
  );
}
