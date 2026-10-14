import { useState } from "react";
import { GitMerge } from "lucide-react";
import { startGraphRun, type GraphNodeSpec } from "../api";

export type CollaborationPlan = {
  why: string;
  nodes: { id: string; harness: string; prompt: string; dependencies: string[]; read_only: boolean }[];
  parallel: number;
  minutes: number;
};

/**
 * agent 用自然语言规划出来的多模型协作计划，交用户过目后才启动。
 *
 * 与 CollaborationBoard 的区别：那边是用户自己搭 DAG（节点、依赖、逐节点模型都手填），
 * 这里是 agent 出方案、用户只判断「要不要这么做」。计划的执行仍走 Rust 侧既有的
 * `start_graph_run`（隔离 worktree + DAG + 集成），所以两种入口共用同一套执行与安全边界。
 */
export default function CollaborationPlanCard({
  taskId,
  plan,
  onSettled,
  onCancel,
}: {
  taskId: string;
  plan: CollaborationPlan;
  onSettled: (summary: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = plan.nodes.length;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const nodes: GraphNodeSpec[] = plan.nodes.map((n) => ({
        id: n.id,
        harness: n.harness,
        prompt: n.prompt,
        dependencies: n.dependencies,
        read_only: n.read_only,
      }));
      await startGraphRun(taskId, nodes, plan.parallel, plan.minutes * 60);
      onSettled(`已确认并启动：${nodes.map((n) => n.id).join("、")}`);
    } catch (e) {
      // 启动失败要让用户看见原因，并且不要把审批通道关掉 —— 他还能取消
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-800">
        <GitMerge size={14} />
        建议这样拆给多个模型
      </div>
      {plan.why && <div className="text-[11px] leading-relaxed text-stone-600">{plan.why}</div>}

      <ol className="space-y-1">
        {plan.nodes.map((n) => (
          <li key={n.id} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600">{n.id}</span>
              <span className="font-medium text-stone-700">{n.harness}</span>
              {n.read_only && <span className="text-[10px] text-stone-400">只读</span>}
              {n.dependencies.length > 0 && (
                <span className="ml-auto text-[10px] text-stone-400">等 {n.dependencies.join("、")} 先完成</span>
              )}
            </div>
            <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-stone-500">{n.prompt}</div>
          </li>
        ))}
      </ol>

      <div className="text-[11px] text-stone-500">
        最多 {plan.parallel} 路并行，总时限 {plan.minutes} 分钟，共 {total} 个节点。
        执行在隔离工作树中进行，共享范围与额度沿用「上下文与协作设置」里的当前策略。
      </div>

      {error && <div className="context-error">{error}</div>}

      <div className="flex items-center gap-2">
        <button onClick={confirm} disabled={busy} className="task-action task-action-primary">
          {busy ? "正在启动…" : "确认并启动"}
        </button>
        <button onClick={onCancel} disabled={busy} className="task-action">
          取消
        </button>
        <span className="text-[11px] text-stone-400">也可以直接在输入框说明想怎么改</span>
      </div>
    </div>
  );
}
