import { useContext, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { FilePreviewContext, localFilePath } from "../filePreview";


/** 助手文本渲染：Markdown 正文、独立代码块与复制操作。 */
export function AssistantText({ text }: { text: string }) {
  const openFile = useContext(FilePreviewContext);
  return (
    <div className="assistant-markdown">
      <Markdown remarkPlugins={[remarkGfm]} urlTransform={(url) => localFilePath(url) !== null ? url : defaultUrlTransform(url)} components={{
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children, node, ...props }) => {
          const fenced = node?.position && node.position.end.line > node.position.start.line;
          return className?.startsWith("language-") || fenced
            ? <CodeBlock code={String(children).replace(/\n$/, "")} lang={className?.replace("language-", "") ?? ""} />
            : <code {...props}>{children}</code>;
        },
        a: ({ children, href, ...props }) => {
          const local = localFilePath(href ?? "");
          return local && openFile
            ? <a {...props} href={href} onClick={(event) => { event.preventDefault(); openFile(local); }}>{children}</a>
            : <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
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
    <div className="code-block">
      <div className="code-block-heading">
        <span className="font-sans">{lang || "code"}</span>
        <button
           onClick={copy}
           title={copied ? "已复制" : "复制代码"}
           aria-label={copied ? "已复制" : "复制代码"}
          className="code-copy-button"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>
        {code}
      </pre>
    </div>
  );
}
