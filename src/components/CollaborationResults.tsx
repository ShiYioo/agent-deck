import { useEffect, useRef, useState } from "react";
import { GitMerge, RefreshCw, Square, Trash2 } from "lucide-react";
import {
  cancelGraphNode, cancelGraphRun, discardGraphRun, integrateGraphRun, listGraphRuns, type GraphRun,
} from "../api";
import { inheritedExecution } from "../api";
import { DelegationExecution } from "./DelegationExecution";
import { effortLabel } from "./ExecutionPicker";
import { RelationshipGraph, phaseLabels } from "./RelationshipGraph";

/**
 * 多模型协作的产出卡：与消息、文件产出共用对话滚动区。
 *
 * 此前这部分渲染在「上下文与协作设置 → 多模型并行」里，要展开三层才看得到 ——
 * 产出被放在了设置区，这是位置错了，不是文案问题。所以：
 *   - 只在真的有协作记录时出现，平时不占位置；
 *   - 每行先说「这个模型被派去做什么」（节点任务），再说结果，最后才是 harness 与状态；
 *   - 基线提交、补丁哈希这类内部标识不再作为正文，收进展开详情；
 *   - 动作按用户意图命名：停止 / 采纳改动 / 丢弃。
 *
 * 类名沿用 .graph-run / .graph-run-heading / .graph-node-result，因为节点级执行配置
 * （DelegationExecution）也在这里，测试与样式都按这些钩子定位。
 */

const STATUS_LABEL: Record<string, string> = {
  pending: "等待开始", running: "进行中", done: "已完成", failed: "失败",
  blocked: "依赖失败", cancelled: "已停止", interrupted: "已中断",
  needs_attention: "需要处理", discarded: "已移除",
};

/** 节点任务的一行摘要：用户靠它认出这一行是谁在做什么，而不是靠 task-1 这种内部编号。 */
function taskLine(prompt: string) {
  const first = prompt.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return first.length > 46 ? `${first.slice(0, 46)}…` : first || "（未填写任务要求）";
}

/** 只信任结构完整的节点：后端可能返回历史或残缺记录，界面不该因此整块崩掉。 */
const nodesOf = (run: GraphRun) => (run.nodes ?? []).filter((node) => Boolean(node?.spec));
const activeExecution = (node: GraphRun["nodes"][number]) =>
  node.spec.supervision && ["planning", "reviewing"].includes(node.phase ?? "")
    ? node.spec.supervision.execution : node.spec.execution;

function headline(run: GraphRun, nodes: GraphRun["nodes"]) {
  const total = nodes.length;
  const finished = nodes.filter((node) => node.status === "done").length;
  // run.status 是 done 也可能有节点失败，绝不能因此谎报「都完成了」
  const failed = nodes.filter((node) => ["failed", "blocked", "interrupted", "needs_attention"].includes(node.status)).length;
  const writes = nodes.some((node) => !node.spec.read_only);
  const artifacts = nodes.some((node) => node.spec.contract?.workspace === "artifacts");
  if (nodes.some((node) => node.spec.supervision)) {
    if (run.status === "running") return `并行指挥与协作 · ${finished}/${total} 条任务链已完成`;
    if (run.status === "done") return `${total} 条任务链已完成${writes && !run.integrated && !artifacts ? " · 等待采纳改动" : ""}`;
    return `${finished}/${total} 条任务链已完成 · ${STATUS_LABEL[run.status] ?? run.status}`;
  }
  if (run.status === "running") {
    return failed
      ? `工作流进行中 · ${finished}/${total} 阶段完成，${failed} 个需要处理`
      : `工作流进行中 · ${finished}/${total} 阶段完成`;
  }
  if (run.status === "done") {
    if (failed) return `${finished}/${total} 个模型完成了，${failed} 个没成`;
    return writes ? `${total} 个模型都完成了` : `${total} 个模型的结论都出来了`;
  }
  if (run.status === "failed") return "没能完成";
  if (run.status === "cancelled") return "已停止";
  if (run.status === "discarded") return "成果已移除";
  return `${total} 个模型 · ${STATUS_LABEL[run.status] ?? run.status}`;
}

export default function CollaborationResults({ taskId, refreshKey = 0, onViewTask, onOpenFile, onRuns }: {
  taskId: string; refreshKey?: number; onViewTask?: (taskId: string) => void;
  onRuns?: (taskId: string, runs: GraphRun[]) => void;
  onOpenFile?: (taskId: string, path: string) => void;
}) {
  const [runs, setRuns] = useState<GraphRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const details = useRef(new Map<string, HTMLDetailsElement>());

  useEffect(() => {
    ++epoch.current;
    const current = epoch.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const rows = await listGraphRuns(taskId);
        if (disposed || current !== epoch.current) return;
        setRuns(rows ?? []);
        onRuns?.(taskId, rows ?? []);
        setError(null);
        if (rows?.some((run) => run.status === "running")) timer = setTimeout(refresh, 1000);
      } catch {
        // 短暂断连不能抹去已知的运行状态；继续同步，避免永久停在旧状态。
        if (!disposed && current === epoch.current) timer = setTimeout(refresh, 3000);
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [taskId, refreshKey, onRuns]);

  const action = async (fn: () => Promise<void>) => {
    if (busy) return;
    const current = epoch.current;
    setBusy(true); setError(null);
    try { await fn(); }
    catch (reason) { if (current === epoch.current) setError(String(reason)); }
    finally { if (current === epoch.current) setBusy(false); }
  };

  // 动作之后一律回读服务端状态：只改本地副本会让「丢弃/采纳/停止」看起来没生效
  const reload = async () => {
    const rows = (await listGraphRuns(taskId)) ?? [];
    setRuns(rows);
    onRuns?.(taskId, rows);
  };

  if (!runs.length) return null;

  return <div className="collaboration-results anim-pop mt-2 space-y-2">
    {runs.map((run) => {
      const nodes = nodesOf(run);
      const writes = nodes.some((node) => !node.spec.read_only);
      const artifacts = nodes.some((node) => node.spec.contract?.workspace === "artifacts");
      return <div className="graph-run" key={run.id}>
        {error && <div className="context-error" role="alert">{error}</div>}
        <div className="graph-run-heading">
          <GitMerge size={14} />
          <span title={run.base_commit}>{headline(run, nodes)}</span>
          {run.status === "running" && <button className="icon-button" title="停止这次协作" aria-label="停止任务图" disabled={busy}
            onClick={() => void action(async () => { await cancelGraphRun(run.id); await reload(); })}><Square size={14} /></button>}
          {run.status === "done" && !run.integrated && writes && !artifacts && <button className="context-command" disabled={busy}
            onClick={() => {
              if (!window.confirm("把各模型的改动合并到当前项目目录？请先确认源目录没有未提交的改动。")) return;
              void action(async () => { await integrateGraphRun(run.id, true); await reload(); });
            }}><GitMerge size={14} />采纳改动</button>}
          {run.integrated && <span>已采纳</span>}
          {!["running", "discarded"].includes(run.status) && <button className="icon-button" aria-label="移除隔离成果" title="丢弃这些产出（不改动项目文件）" disabled={busy}
            onClick={() => {
              if (!window.confirm("丢弃本次协作的所有产出？已经采纳到项目里的改动会保留。")) return;
              void action(async () => { await discardGraphRun(run.id, true); await reload(); });
            }}><Trash2 size={14} /></button>}
          <button className="icon-button" aria-label="刷新协作成果" title="刷新协作成果" disabled={busy}
            onClick={() => void action(reload)}><RefreshCw size={14} /></button>
        </div>
        {run.error && <div className="context-error">{run.error}</div>}
        <RelationshipGraph nodes={nodes} onSelect={(id) => {
          const detail = details.current.get(`${run.id}:${id}`);
          if (detail) { detail.open = true; detail.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
        }} />
        <ul className="m-0 list-none p-0">
          {nodes.map((node) => <li key={node.spec.id}>
            <details className="graph-node-result" ref={(element) => {
              const key = `${run.id}:${node.spec.id}`;
              if (element) details.current.set(key, element); else details.current.delete(key);
            }}>
              <summary>
                <span className="node-task">{taskLine(node.spec.prompt)}</span>
                 <span className="node-source">{node.spec.harness}{activeExecution(node)?.model
                   ? ` · ${activeExecution(node)?.model?.split("/").pop()}` : ""}</span>
                <span className="node-status">{STATUS_LABEL[node.status] ?? node.status}</span>
              </summary>
              <div className="node-detail">
                <div className="node-prompt">{node.spec.prompt}</div>
                {run.status === "running" && ["pending", "running"].includes(node.status) &&
                  <button className="context-command" disabled={busy} aria-label={`停止任务链 ${node.spec.id}`}
                    onClick={() => void action(async () => { await cancelGraphNode(run.id, node.spec.id); await reload(); })}>
                    <Square size={12} />停止此任务链
                  </button>}
                 {!!node.history?.length && <div className="node-stage-history">
                  {(node.history ?? []).map((stage) => <details key={stage.task_id}>
                    <summary>{stage.harness} · {phaseLabels[stage.phase] ?? stage.phase} · 第 {stage.round} 轮</summary>
                    <pre>{stage.report}</pre>
                     <div className="execution-current">
                       <span>绑定模型：{stage.evidence?.execution?.resolved.model || "运行器默认"}</span>
                       <span>运行器报告：{stage.evidence?.observed_model || "未报告实际模型"}</span>
                     </div>
                    {onViewTask && <button className="context-command" onClick={() => onViewTask(stage.task_id)}>查看阶段记录</button>}
                  </details>)}
                  {node.task_id && onViewTask && <button className="context-command" onClick={() => onViewTask(node.task_id!)}>查看当前阶段</button>}
                </div>}
                {run.status === "running" && (node.status === "pending" || (node.status === "running" && node.spec.supervision)) && <DelegationExecution runId={run.id} target={node.spec.id}
                  harness={node.spec.harness} initial={node.spec.execution ?? inheritedExecution()} taskId={taskId} />}
                {run.status === "running" && node.spec.supervision && <DelegationExecution runId={run.id}
                  target={`${node.spec.id}:commander`} harness={node.spec.supervision.commander}
                  initial={node.spec.supervision.execution ?? inheritedExecution()} taskId={taskId} />}
                {node.task_id && <div className="execution-current">
                  <span title={activeExecution(node)?.model ?? ""}>{activeExecution(node)?.model || "默认模型"}</span>
                  <span>{effortLabel(activeExecution(node)?.effort || "默认")}</span>
                   <span>运行器报告：{node.evidence?.observed_model || "未报告实际模型"}</span>
                </div>}
                <div className="context-actions">
                 {node.task_id && onViewTask && <button className="context-command"
                   onClick={() => onViewTask(node.task_id!)}>查看执行记录</button>}
                 {node.task_id && node.spec.contract?.outputs.map((path) =>
                   <button key={path} className="context-command" disabled={node.status !== "done" || run.status === "discarded"}
                     onClick={() => onOpenFile?.(node.task_id!, path)}>打开成果 · {path}</button>)}
                </div>
                {node.error && <div className="context-error">{node.error}</div>}
                {node.report
                  ? <pre>{node.report}</pre>
                  : <div className="node-empty">{node.status === "pending" ? "还没有开始" : "没有文本产出"}</div>}
                 {node.patch_hash && <div className="node-artifact" title={node.patch_hash}>
                   {artifacts ? "成果版本" : "改动记录"} {node.patch_hash.slice(0, 12)}</div>}
              </div>
            </details>
          </li>)}
        </ul>
      </div>;
    })}
  </div>;
}
