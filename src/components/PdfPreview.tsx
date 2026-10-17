import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Load byte ranges and render one page; never mount a canvas per PDF page. */
export default function PdfPreview({ url }: { url: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    setError(""); setBusy(true); setDocument(null); setPage(1);
    const task = getDocument({
      url, rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true,
      maxImageSize: 16_000_000,
    });
    task.promise.then((doc) => { if (alive) setDocument(doc); })
      .catch((e) => { if (alive) { setError(`PDF 无法读取：${String(e)}`); setBusy(false); } });
    return () => { alive = false; void task.destroy(); };
  }, [url]);
  useEffect(() => {
    if (!document) return;
    let alive = true;
    let render: { cancel: () => void } | undefined;
    setBusy(true); setError("");
    document.getPage(page).then(async (pdfPage) => {
      if (!alive || !canvas.current) return;
      const viewport = pdfPage.getViewport({ scale });
      // Bound both canvas dimensions and total pixels even for unusual page sizes.
      const factor = Math.min(2, window.devicePixelRatio || 1, 4096 / Math.max(viewport.width, viewport.height), Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      const actual = pdfPage.getViewport({ scale: scale * factor });
      const element = canvas.current;
      element.width = Math.ceil(actual.width); element.height = Math.ceil(actual.height);
      element.style.width = `${actual.width / Math.max(factor, 0.01)}px`;
      element.style.height = `${actual.height / Math.max(factor, 0.01)}px`;
      const context = element.getContext("2d");
      if (!context) throw new Error("无法创建绘图区域");
      const task = pdfPage.render({ canvas: element, canvasContext: context, viewport: actual });
      render = task;
      await task.promise;
      pdfPage.cleanup();
      if (alive) setBusy(false);
    }).catch((e) => { if (alive) { setError(String(e)); setBusy(false); } });
    return () => { alive = false; render?.cancel(); };
  }, [document, page, scale]);
  return <div className="pdf-reader" aria-label="PDF 阅读器">
    <div className="file-preview-toolbar">
      <button disabled={!document || page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
      <span>第 {page} / {document?.numPages ?? "…"} 页</span>
      <button disabled={!document || page >= document.numPages} onClick={() => setPage(page + 1)}>下一页</button>
      <select aria-label="PDF 缩放" value={scale} onChange={(e) => setScale(Number(e.target.value))}>
        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value * 100}%</option>)}
      </select>
    </div>
    {error && <p className="file-preview-notice" role="alert">{error}。可使用外部应用打开。</p>}
    {busy && <div className="file-preview-notice" role="status">正在读取 PDF 页面…</div>}
    <div className="pdf-reader-page"><canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} /></div>
  </div>;
}
