import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";


/** 助手文本渲染：``` 代码块分块 + 深底 + 复制按钮（Codex 桌面端习惯） */
export function AssistantText({ text }: { text: string }) {
  return (
    <div className="assistant-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={{
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children, node, ...props }) => {
          const fenced = node?.position && node.position.end.line > node.position.start.line;
          return className?.startsWith("language-") || fenced
            ? <CodeBlock code={String(children).replace(/\n$/, "")} lang={className?.replace("language-", "") ?? ""} />
            : <code {...props}>{children}</code>;
        },
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
      }}>{text}</Markdown>
    </div>
  );
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
           title={copied ? "已复制" : "复制代码"}
           aria-label={copied ? "已复制" : "复制代码"}
          className="font-sans text-stone-400 transition-colors hover:text-stone-200"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre className="overflow-x-auto bg-stone-950/60 px-3 py-2 text-stone-200">
        {code}
      </pre>
    </div>
  );
}
