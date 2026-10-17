import { useMemo, useState, type ReactNode } from "react";

export type DisplayLine = { text: string; old?: number; current?: number; kind?: "added" | "removed" | "hunk" | "meta" };

export function parseDiff(text: string): DisplayLine[] {
  let old = 0, current = 0, inHunk = false;
  return text.split("\n").map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match) {
      old = Number(match[1]); current = Number(match[2]); inHunk = true;
      return { text: line, kind: "hunk" };
    }
    if (line.startsWith("diff --git")) inHunk = false;
    if (!inHunk || line.startsWith("\\")) return { text: line, kind: "meta" };
    if (line.startsWith("+")) return { text: line.slice(1), current: current++, kind: "added" };
    if (line.startsWith("-")) return { text: line.slice(1), old: old++, kind: "removed" };
    if (line.startsWith(" ")) return { text: line.slice(1), old: old++, current: current++ };
    return { text: line, kind: "meta" };
  });
}

/** Keep document text intact; translate only Git's structural records. */
function reviewDiff(text: string): DisplayLine[] {
  const result: DisplayLine[] = [];
  let file: DisplayLine | undefined;
  let previousPath = "";
  let hunks = 0;
  for (const line of parseDiff(text)) {
    if (line.kind === "meta") {
      if (line.text.startsWith("diff --git ")) {
        file = { text: line.text.match(/ b\/(.+)$/)?.[1] ?? "文件改动", kind: "meta" };
        result.push(file);
        hunks = 0;
      } else if (line.text.startsWith("--- ")) {
        previousPath = line.text.slice(4).replace(/^a\//, "");
      } else if (line.text.startsWith("+++ ") && file) {
        const path = line.text.slice(4);
        file.text = path === "/dev/null" ? previousPath : path.replace(/^b\//, "");
      } else if (line.text.startsWith("\\ No newline")) {
        result.push({ text: "文件末尾没有换行", kind: "meta" });
      } else if (/^(Binary files |GIT binary patch)/.test(line.text)) {
        result.push({ text: "二进制内容已更改，请切换内容查看", kind: "meta" });
      } else if (line.text.startsWith("rename from ")) {
        result.push({ text: `原文件：${line.text.slice(12)}`, kind: "meta" });
      } else if (line.text.startsWith("rename to ")) {
        result.push({ text: `重命名为：${line.text.slice(10)}`, kind: "meta" });
      } else if (/^(old|new) mode /.test(line.text)) {
        result.push({ text: `${line.text.startsWith("old") ? "原" : "新"}文件权限：${line.text.slice(9)}`, kind: "meta" });
      }
      continue;
    }
    if (line.kind === "hunk") {
      const match = / \+(\d+)/.exec(line.text);
      if (hunks++ > 0) result.push({ text: `⋯ 第 ${match?.[1] ?? "…"} 行附近 ⋯`, kind: "hunk" });
      continue;
    }
    result.push(line);
  }
  return result;
}

/** Fixed-height virtual rows keep both large files and large patches out of the DOM. */
export function FileLines({ text, diff = false, query = "", label = "文件文本", source }: {
  text: string; diff?: boolean; query?: string; label?: string; source?: ReactNode;
}) {
  const [raw, setRaw] = useState(false);
  const lines = useMemo(() => diff && !raw ? reviewDiff(text) : text.split("\n").map((text, i) => ({ text, current: i + 1 } as DisplayLine)), [text, diff, raw]);
  return <div className="file-lines-container">
    {diff && <div className="file-diff-toolbar">
      <span>{raw ? "原始 Git 补丁" : "文件改动"}</span>
      <button aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? "返回改动视图" : "查看原始 Diff"}</button>
    </div>}
    <LineViewport key={raw ? "raw" : "review"} lines={lines} diff={diff && !raw} query={query} label={label} source={source} />
  </div>;
}

function LineViewport({ lines, diff, query, label, source }: {
  lines: DisplayLine[]; diff: boolean; query: string; label: string; source?: ReactNode;
}) {
  const [top, setTop] = useState(0);
  const matches = useMemo(() => {
    const q = query.toLocaleLowerCase();
    return q ? lines.flatMap((line, i) => line.text.toLocaleLowerCase().includes(q) ? [i] : []) : null;
  }, [lines, query]);
  const count = matches?.length ?? lines.length;
  const height = 24;
  const start = Math.max(0, Math.floor(top / height) - 10);
  // At most 100 rows mounted, independent of file length.
  const visible = Array.from({ length: Math.max(0, Math.min(100, count - start)) }, (_, i) => start + i);
  return <div className="file-lines" aria-label={label} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
    {source && <div className="file-diff-source">{source}</div>}
    {matches && <div className="file-search-result">{count} 行匹配 · 当前加载片段</div>}
    <div className="file-lines-spacer" style={{ height: count * height }}>
      {visible.map((index) => {
        const original = matches?.[index] ?? index;
        const line = lines[original];
        const structural = diff && (line.kind === "meta" || line.kind === "hunk");
        return <div key={original} className={`file-line ${line.kind ?? ""}`} style={{ top: index * height }} data-line={line.current ?? line.old}>
          {!structural && <>
            {diff && <span className="file-line-number">{line.old ?? ""}</span>}
            <span className="file-line-number">{line.current ?? ""}</span>
            {diff && <span className="file-line-sign">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</span>}
          </>}
          <span className="file-line-content">{line.text.slice(0, 16000) || " "}{line.text.length > 16000 ? " …［该行过长，预览已截断］" : ""}</span>
        </div>;
      })}
    </div>
  </div>;
}
