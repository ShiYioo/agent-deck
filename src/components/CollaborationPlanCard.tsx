import { useState } from "react";
import { GitMerge } from "lucide-react";
import { inheritedExecution, type GraphNodeSpec } from "../api";
import { RelationshipGraph } from "./RelationshipGraph";
import { ExecutionPicker } from "./ExecutionPicker";

export type CollaborationPlan = {
  why: string;
  nodes: GraphNodeSpec[];
  parallel: number;
  minutes: number;
};

/**
 * agent 用自然语言规划出来的多模型协作计划，交用户过目后才启动。
 *
 * 与 CollaborationBoard 的区别：那边是用户自己搭 DAG（节点、依赖、逐节点模型都手填），
 * 单节点在当前目录交接执行；多节点或指导链进入隔离任务图。
 */
export default function CollaborationPlanCard({
  taskId,
  plan,
  issues = [],
  onConfirm,
  onError,
  onCancel,
}: {
  taskId: string;
  plan: CollaborationPlan;
  issues?: string[];
  onConfirm: (nodes: GraphNodeSpec[]) => Promise<void>;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState(plan.nodes);

  const total = plan.nodes.length;
  const artifacts = nodes[0]?.contract?.workspace === "artifacts";
  const direct = total === 1 && !nodes[0]?.supervision && !artifacts && !nodes[0]?.contract?.acceptance;
  const unresolved = nodes.some((node) =>
    (node.contract?.model_hint && !node.execution?.model)
    || (node.supervision?.model_hint && !node.supervision.execution?.model));
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(nodes);
    } catch (e) {
      // Also surface failures outside this card if planner exit already unmounted it.
      setError(String(e));
      onError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
       <div className="flex items-center gap-2 text-xs font-medium text-stone-700">
        <GitMerge size={14} />
        {direct ? "交给指定运行器" : "执行分工"}
      </div>
      {plan.why && <div className="text-[11px] leading-relaxed text-stone-600">{plan.why}</div>}
      {issues.length > 0 && <div className="context-error" role="status">
        {issues.map((issue, i) => <div key={i}>{issue}</div>)}
        {unresolved && <div>请选择实际模型；选择其他型号会替换这次任务的原模型要求。</div>}
      </div>}
      {!issues.length && <p className="text-xs text-stone-500">执行安排已就绪，确认后开始。</p>}
      <RelationshipGraph nodes={nodes.map((spec) => ({ spec, status: "pending" }))} />

      <ol className="space-y-1">
        {nodes.map((n, index) => (
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
            {n.contract?.model_hint && <div className="text-xs text-stone-500">要求的模型：{n.contract.model_hint}</div>}
            {!!n.contract?.outputs.length && <div className="text-xs text-stone-500">输出：{n.contract.outputs.join("、")}</div>}
            {n.contract?.acceptance && <div className="text-xs text-stone-500">独立验收 · 结论绑定成果版本</div>}
            <ExecutionPicker harness={n.harness} taskId={taskId} value={n.execution ?? inheritedExecution()}
              label={`${n.id} 执行 `} disabled={busy} onChange={(execution) =>
                setNodes((previous) => previous.map((node, i) => i === index ? { ...node, execution } : node))} />
            {n.supervision && <ExecutionPicker harness={n.supervision.commander} taskId={taskId}
              value={n.supervision.execution ?? inheritedExecution()} label={`${n.id} 指挥 `} disabled={busy}
              onChange={(execution) => setNodes((previous) => previous.map((node, i) =>
                i === index ? { ...node, supervision: { ...node.supervision!, execution } } : node))} />}
          </li>
        ))}
      </ol>

      <div className="text-[11px] text-stone-500">
        {direct ? "在当前工作目录执行。" :
          `最多 ${plan.parallel} 路并行，总时限 ${plan.minutes} 分钟，共 ${total} 个节点。${artifacts ? "成果按文件版本在独立目录交接。" : "执行在隔离工作树中进行。"}`}
      </div>

      {error && <div className="context-error">{error}</div>}

      <div className="flex items-center gap-2">
        <button onClick={confirm} disabled={busy || unresolved} className="task-action task-action-primary">
          {busy ? "正在交接并启动…" : "确认并启动"}
        </button>
        <button onClick={onCancel} disabled={busy} className="task-action">
          取消
        </button>
        <span className="text-[11px] text-stone-400">也可以直接在输入框说明想怎么改</span>
      </div>
    </div>
  );
}
