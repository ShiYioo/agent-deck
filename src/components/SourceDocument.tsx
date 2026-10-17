import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLineGutter, keymap, drawSelection } from "@codemirror/view";
import { search, searchKeymap, openSearchPanel, gotoLine } from "@codemirror/search";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";

async function language(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext ?? "")) return (await import("@codemirror/lang-javascript")).javascript({ typescript: ext === "ts" || ext === "tsx", jsx: ext === "jsx" || ext === "tsx" });
  if (ext === "json") return (await import("@codemirror/lang-json")).json();
  if (ext === "css") return (await import("@codemirror/lang-css")).css();
  if (ext === "html" || ext === "htm") return (await import("@codemirror/lang-html")).html();
  if (ext === "py") return (await import("@codemirror/lang-python")).python();
  if (ext === "rs") return (await import("@codemirror/lang-rust")).rust();
  if (ext === "md" || ext === "markdown") return (await import("@codemirror/lang-markdown")).markdown();
  return [];
}

const readingPositions = new Map<string, { top: number; left: number; anchor: number; head: number }>();

/** One immutable document, viewport rendering, native selection and full-document search. */
export default function SourceDocument({ text, path }: { text: string; path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>();
  const [position, setPosition] = useState("Ln 1, Col 1");
  const count = useMemo(() => {
    let count = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
    return count;
  }, [text]);
  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    const saved = readingPositions.get(path);
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: text, selection: saved ? { anchor: Math.min(saved.anchor, text.length), head: Math.min(saved.head, text.length) } : undefined, extensions: [
        EditorState.readOnly.of(true), EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-label": "文件源码", tabindex: "0" }),
        lineNumbers(), highlightActiveLineGutter(), drawSelection(), bracketMatching(),
        search({ top: true }), keymap.of([...searchKeymap, { key: "Mod-g", run: gotoLine }]),
        syntaxHighlighting(defaultHighlightStyle),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            setPosition(`Ln ${line.number}, Col ${head - line.from + 1}`);
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px" },
          ".cm-scroller": { overflow: "auto", fontFamily: "Consolas, 'Microsoft YaHei UI', monospace", lineHeight: "1.75" },
          ".cm-content": { padding: "12px 0" },
          ".cm-gutters": { backgroundColor: "var(--bg-subtle)", color: "var(--text-3)", border: "none", paddingRight: "8px" },
          ".cm-activeLineGutter": { backgroundColor: "var(--chrome)" },
          "&.cm-focused": { outline: "none" },
          ".cm-search": { fontSize: "12px" },
        }),
      ] }),
    });
    if (saved) {
      view.scrollDOM.scrollTop = saved.top;
      view.scrollDOM.scrollLeft = saved.left;
    }
    if (text.length < 1024 * 1024) void language(path).then((extension) => {
      if (alive) view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
    }).catch(() => {});
    editor.current = view;
    return () => {
      alive = false;
      const selection = view.state.selection.main;
      if (readingPositions.size >= 100) readingPositions.delete(readingPositions.keys().next().value!);
      readingPositions.set(path, { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft, anchor: selection.anchor, head: selection.head });
      editor.current = undefined; view.destroy();
    };
  }, [text, path]);
  return <div className="source-document">
    <div ref={host} className="source-document-editor" />
    <footer className="source-document-status">
      <span>{position}</span><span>{count.toLocaleString()} 行 · 只读</span>
      <button onClick={() => { if (editor.current) openSearchPanel(editor.current); }}>查找 Ctrl+F</button>
      <button onClick={() => { if (editor.current) gotoLine(editor.current); }}>跳转 Ctrl+G</button>
    </footer>
  </div>;
}
