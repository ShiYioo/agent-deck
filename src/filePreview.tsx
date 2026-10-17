import { createContext, useContext } from "react";

export const FilePreviewContext = createContext<((path: string) => void) | null>(null);

/** Recognize local links only; the backend validates the canonical workspace boundary. */
export function localFilePath(href: string): string | null {
  if (!href || href.startsWith("#") || /^(?:https?:|mailto:|data:|javascript:)/i.test(href)) return null;
  let path: string;
  try { path = decodeURIComponent(href); } catch { return null; }
  if (/^file:/i.test(path)) path = path.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1");
  else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return null;
  return path.replace(/#L\d+(?:C\d+)?(?:-L?\d+)?$/, "").replace(/:\d+(?::\d+)?$/, "");
}

export function FilePathLink({ path }: { path: string }) {
  const open = useContext(FilePreviewContext);
  return open
    ? <a href={path} className="file-path-link" title={`查看 ${path}`} onClick={(event) => {
        event.preventDefault(); event.stopPropagation(); open(localFilePath(path) ?? path);
      }}>{path}</a>
    : <span title={path}>{path}</span>;
}
