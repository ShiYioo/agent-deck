import { useEffect, useRef, useState } from "react";
import { GitMerge, RefreshCw, Square, Trash2 } from "lucide-react";
import {
  cancelGraphRun, discardGraphRun, integrateGraphRun, listGraphRuns, type GraphRun,
} from "../api";
import { inheritedExecution } from "../api";
import { DelegationExecution } from "./DelegationExecution";
import { effortLabel } from "./ExecutionPicker";

/**
 * 多模型协作的产出卡：放在对话与输入区之间，用户问完一句话就能在这里看到结果。
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

function headline(run: GraphRun, nodes: GraphRun["nodes"]) {
  const total = nodes.length;
  const finished = nodes.filter((node) => node.status === "done").length;
  // run.status 是 done 也可能有节点失败，绝不能因此谎报「都完成了」
  const failed = nodes.filter((node) => ["failed", "blocked", "interrupted", "needs_attention"].includes(node.status)).length;
  const writes = nodes.some((node) => !node.spec.read_only);
  if (run.status === "running") {
    return failed
      ? `正在并行工作 · ${finished}/${total} 已完成，${failed} 个出问题`
      : `正在并行工作 · ${finished}/${total} 个模型已完成`;
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

export default function CollaborationResults({ taskId, refreshKey = 0 }: { taskId: string; refreshKey?: number }) {
  const [runs, setRuns] = useState<GraphRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);

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
        setError(null);
        if (rows?.some((run) => run.status === "running")) timer = setTimeout(refresh, 1000);
      } catch {
        // 任务可能尚未落库 —— 这不该在界面上变成一个错误条
        if (!disposed && current === epoch.current) setRuns([]);
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [taskId, refreshKey]);

  const action = async (fn: () => Promise<void>) => {
    if (busy) return;
    const current = epoch.current;
    setBusy(true); setError(null);
    try { await fn(); }
    catch (reason) { if (current === epoch.current) setError(String(reason)); }
    finally { if (current === epoch.current) setBusy(false); }
  };

  // 动作之后一律回读服务端状态：只改本地副本会让「丢弃/采纳/停止」看起来没生效
  const reload = async () => { setRuns((await listGraphRuns(taskId)) ?? []); };

  if (!runs.length) return null;

  return <div className="anim-pop mx-6 mt-2 space-y-2 rounded-xl border border-stone-200 bg-white p-3">
    {runs.map((run) => {
      const nodes = nodesOf(run);
      const writes = nodes.some((node) => !node.spec.read_only);
      return <div className="graph-run" key={run.id}>
        {error && <div className="context-error" role="alert">{error}</div>}
        <div className="graph-run-heading">
          <GitMerge size={14} />
          <span title={run.base_commit}>{headline(run, nodes)}</span>
          {run.status === "running" && <button className="icon-button" title="停止这次协作" aria-label="停止任务图" disabled={busy}
            onClick={() => void action(async () => { await cancelGraphRun(run.id); await reload(); })}><Square size={14} /></button>}
          {run.status === "done" && !run.integrated && writes && <button className="context-command" disabled={busy}
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
        <ul className="m-0 list-none p-0">
          {nodes.map((node) => <li key={node.spec.id}>
            <details className="graph-node-result">
              <summary>
                <span className="node-task">{taskLine(node.spec.prompt)}</span>
                <span className="node-source">{node.spec.harness}</span>
                <span className="node-status">{STATUS_LABEL[node.status] ?? node.status}</span>
              </summary>
              <div className="node-detail">
                <div className="node-prompt">{node.spec.prompt}</div>
                {run.status === "running" && node.status === "pending" && <DelegationExecution runId={run.id} target={node.spec.id}
                  harness={node.spec.harness} initial={node.spec.execution ?? inheritedExecution()} taskId={taskId} />}
                {node.task_id && <div className="execution-current">
                  <span title={node.spec.execution?.model ?? ""}>{node.spec.execution?.model || "默认模型"}</span>
                  <span>{effortLabel(node.spec.execution?.effort || "默认")}</span>
                </div>}
                {node.error && <div className="context-error">{node.error}</div>}
                {node.report
                  ? <pre>{node.report}</pre>
                  : <div className="node-empty">{node.status === "pending" ? "还没有开始" : "没有文本产出"}</div>}
                {node.patch_hash && <div className="node-artifact" title={node.patch_hash}>改动记录 {node.patch_hash.slice(0, 12)}</div>}
              </div>
            </details>
          </li>)}
        </ul>
      </div>;
    })}
  </div>;
}
