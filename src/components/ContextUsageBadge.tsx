import { memo } from "react";

/** 上下文用量徽章（ZCode ChatContextUsage 同款语义）：
 *  「上下文已用 {used}/{total} ({percent})」；cache 命中率仅 ≥78% 才露出——
 *  低命中不值得分散对上下文容量的注意力（源码 CACHE_HIT_RATE_DISPLAY_THRESHOLD）。 */
const CACHE_HIT_RATE_DISPLAY_THRESHOLD = 0.78;

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`;
  }
  const m = value / 1_000_000;
  return `${Math.round(m * 10) / 10}M`;
}

export const ContextUsageBadge = memo(function ContextUsageBadge({
  used,
  window: total,
  cacheRate,
}: {
  used: number;
  /** 上下文窗口（token）；未知时不渲染整条——不编造数据 */
  window: number | null;
  cacheRate?: number | null;
}) {
  if (!Number.isFinite(used) || used <= 0) return null;
  const hasWindow = total !== null && Number.isFinite(total) && total > 0;
  const percent = hasWindow ? Math.min(100, Math.round((used / (total as number)) * 100)) : null;
  const cacheLabel =
    cacheRate !== null && cacheRate !== undefined && Number.isFinite(cacheRate) && cacheRate >= CACHE_HIT_RATE_DISPLAY_THRESHOLD
      ? ` · 缓存 ${(Math.round(cacheRate * 1000) / 10).toFixed(1)}%`
      : "";
  const summary = hasWindow
    ? `上下文已用 ${formatTokens(used)} / ${formatTokens(total as number)}（${percent}%）${cacheLabel}`
    : `上下文已用 ${formatTokens(used)} tokens${cacheLabel}`;
  return (
    <span
      className="context-usage-badge"
      title={`${summary} tokens`}
      aria-label={summary}
    >
      上下文已用 {formatTokens(used)}
      {hasWindow ? ` / ${formatTokens(total as number)}（${percent}%）` : ""}
      {cacheLabel}
    </span>
  );
});
