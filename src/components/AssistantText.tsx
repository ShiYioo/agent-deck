import { useState } from "react";


/** 助手文本渲染：``` 代码块分块 + 深底 + 复制按钮（Codex 桌面端习惯） */
export function AssistantText({ text }: { text: string }) {
  return (
    <div className="space-y-1.5">
      {splitCodeBlocks(text).map((seg, i) =>
        seg.kind === "code" ? (
          <CodeBlock key={i} code={seg.text} lang={seg.lang} />
        ) : (
          <span key={i} className="whitespace-pre-wrap">
            {seg.text}
          </span>
        ),
      )}
    </div>
  );
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; lang: string };

/** 按 ``` 围栏切分：返回文本段与代码段交错序列 */
function splitCodeBlocks(text: string): Segment[] {
  const segs: Segment[] = [];
  const re = /```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segs.push({ kind: "text", text: text.slice(last, m.index) });
    }
    segs.push({ kind: "code", text: m[2], lang: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segs.push({ kind: "text", text: text.slice(last) });
  }
  if (segs.length === 0) segs.push({ kind: "text", text });
  return segs;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <div className="group relative my-1 overflow-hidden rounded-lg border border-stone-200 bg-stone-900">
      <div className="flex items-center justify-between px-2.5 py-1 text-[10px] text-stone-400">
        <span className="font-sans">{lang || "code"}</span>
        <button
          onClick={copy}
          className="font-sans text-stone-400 transition-colors hover:text-stone-200"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="overflow-x-auto bg-stone-950/60 px-3 py-2 text-stone-200">
        {code}
      </pre>
    </div>
  );
}
