import { useEffect, useRef, useState } from "react";
import { GitMerge, Play, Plus, RefreshCw, Save, Square, Trash2 } from "lucide-react";
import {
  cancelGraphRun, discardGraphRun, getContextPolicy, getSetting, integrateGraphRun, listGraphRuns, resetConversationBinding, setSetting, startGraphRun, updateContextPolicy,
  type ContextPolicy, type GraphNodeSpec, type GraphRun,
} from "../api";
import { inheritedExecution } from "../api";
import { ExecutionPicker, effortLabel } from "./ExecutionPicker";
import { DelegationExecution } from "./DelegationExecution";

const harnesses = ["codex", "opencode", "zcode", "deck"];
const defaults: ContextPolicy = {
  version: 0, allowed_harnesses: harnesses, redact_secrets: true, blocked_terms: [],
  context_window: 32768, output_reserve: 8192, overhead_reserve: 8192,
};
const label: Record<string, string> = {
  pending: "待执行", running: "运行中", done: "已完成", failed: "失败", blocked: "依赖失败",
  cancelled: "已停止", interrupted: "已中断", needs_attention: "待处理",
  discarded: "已移除隔离成果",
};
const initialNodes = (): GraphNodeSpec[] => [
  { id: "task-1", harness: "codex", prompt: "", dependencies: [], read_only: true },
  { id: "task-2", harness: "opencode", prompt: "", dependencies: [], read_only: true },
];

export default function CollaborationBoard({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const [opened, setOpened] = useState(false);
  const [policyOpened, setPolicyOpened] = useState(false);
  const [policy, setPolicy] = useState<ContextPolicy>(defaults);
  const [policyLoaded, setPolicyLoaded] = useState(false);
  const [terms, setTerms] = useState("");
  const [runs, setRuns] = useState<GraphRun[]>([]);
  const [nodes, setNodes] = useState<GraphNodeSpec[]>(initialNodes);
  const [parallel, setParallel] = useState(2);
  const [minutes, setMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transports, setTransports] = useState<Record<string, string>>({});
  const epoch = useRef(0);
  const nextId = useRef(3);
  const draft = useRef({ nodes, parallel, minutes });
  draft.current = { nodes, parallel, minutes };
  const drafts = useRef(new Map<string, typeof draft.current>());
  const previousTask = useRef(taskId);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const runSignature = useRef("");
  const locked = busy || runs.some((r) => r.status === "running");

  useEffect(() => {
    ++epoch.current;
    if (previousTask.current !== taskId) {
      drafts.current.set(previousTask.current, draft.current);
      const saved = drafts.current.get(taskId);
      setNodes(saved?.nodes ?? initialNodes()); setParallel(saved?.parallel ?? 2); setMinutes(saved?.minutes ?? 15);
      previousTask.current = taskId;
    }
    runSignature.current = "";
    setRuns([]); setPolicyLoaded(false); setPolicy(defaults); setTerms(""); setError(null); setBusy(false);
    return () => { ++epoch.current; };
  }, [taskId]);

  useEffect(() => {
    if (!opened && !policyOpened) return;
    const current = epoch.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const rows = await listGraphRuns(taskId);
        if (disposed || current !== epoch.current) return;
        setRuns(rows ?? []);
        const signature = JSON.stringify(rows?.map((r) => [r.id, r.status, r.nodes.map((n) => [n.task_id, n.status])]) ?? []);
        if (runSignature.current && signature !== runSignature.current) onChangedRef.current();
        runSignature.current = signature;
        if (rows?.some((run) => run.status === "running")) timer = setTimeout(refresh, 1000);
      } catch (reason) { if (!disposed && current === epoch.current) setError(String(reason)); }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [taskId, opened, policyOpened, busy]);

  useEffect(() => {
    if (!policyOpened || policyLoaded) return;
    const current = epoch.current;
    let disposed = false;
    void Promise.all([getContextPolicy(taskId), getSetting("transport_codex"), getSetting("transport_opencode")]).then(([value, codex, opencode]) => {
      if (disposed || current !== epoch.current) return;
      setPolicy(value ?? defaults); setTerms(value?.blocked_terms.join("\n") ?? ""); setPolicyLoaded(true);
      setTransports({ codex: codex ?? "cli", opencode: opencode ?? "cli" });
    }).catch((reason) => { if (!disposed && current === epoch.current) setError(String(reason)); });
    return () => { disposed = true; };
  }, [taskId, policyOpened, policyLoaded]);

  const action = async (fn: () => Promise<void>) => {
    if (busy) return;
    const current = epoch.current;
    setBusy(true); setError(null);
    try { await fn(); }
    catch (reason) { if (current === epoch.current) setError(String(reason)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const updateNode = (index: number, change: Partial<GraphNodeSpec>) => {
    setNodes((previous) => previous.map((n, i) => i === index ? { ...n, ...change } : n));
  };

  return <div className="collaboration-board">
    {error && <div className="context-error" role="alert">{error}</div>}
    <details className="context-disclosure" onToggle={(e) => setPolicyOpened(e.currentTarget.open)}>
      <summary>共享范围与额度</summary>
      <div className="orchestration-hint">跨模型共享哪些内容，以及上下文预算上限。</div>
      {policyOpened && <form className="context-state" onSubmit={(event) => {
        event.preventDefault();
        const current = epoch.current;
        void action(async () => {
          const updated = await updateContextPolicy(taskId, policy.version, {
            ...policy, blocked_terms: terms.split("\n").map((s) => s.trim()).filter(Boolean),
          });
          if (current === epoch.current) { setPolicy(updated); onChanged(); }
        });
      }}>
        <fieldset disabled={locked || !policyLoaded}><legend>允许共享会话资料</legend>
          <div className="graph-options">{harnesses.map((h) => <label key={h}>
            <input type="checkbox" checked={policy.allowed_harnesses.includes(h)} onChange={(e) => setPolicy((p) => ({
              ...p, allowed_harnesses: e.target.checked ? [...p.allowed_harnesses, h] : p.allowed_harnesses.filter((v) => v !== h),
            }))} />{h}
          </label>)}</div>
          <label><input type="checkbox" checked={policy.redact_secrets} onChange={(e) => setPolicy((p) => ({ ...p, redact_secrets: e.target.checked }))} />过滤常见凭据</label>
          <label>禁止共享词<textarea aria-label="禁止共享词" rows={2} value={terms} onChange={(e) => setTerms(e.target.value)} /></label>
          <div className="graph-budget">
            {([
              ["context_window", "上下文窗口", 4096], ["output_reserve", "输出预留", 512], ["overhead_reserve", "系统与工具预留", 1024],
            ] as const).map(([key, text, min]) => <label key={key}>{text}
              <input type="number" aria-label={text} min={min} max={2000000} step={512} value={policy[key]}
                onChange={(e) => setPolicy((p) => ({ ...p, [key]: Number(e.target.value) }))} />
            </label>)}
          </div>
          <div className="graph-options">{["codex", "opencode"].map((h) => <label key={h}>{h} 运行入口
            <select aria-label={`${h} 运行入口`} value={transports[h] ?? "cli"} onChange={(e) => {
              const transport = e.target.value;
              const current = epoch.current;
              if (!window.confirm(`切换 ${h} 运行入口并重建当前会话的原生绑定？聊天原文将保留。`)) return;
              void action(async () => {
                await resetConversationBinding(taskId, h);
                await setSetting(`transport_${h}`, transport);
                if (current === epoch.current) { setTransports((p) => ({ ...p, [h]: transport })); onChanged(); }
              });
            }}><option value="cli">CLI</option><option value="native">原生服务</option>{h === "opencode" && <option value="acp">ACP</option>}</select>
          </label>)}</div>
          <div className="context-actions"><span>v{policy.version}</span>
            <button type="submit" className="icon-button" title="保存共享策略" aria-label="保存共享策略"><Save size={16} /></button>
            <button type="button" className="icon-button" title="刷新共享策略" aria-label="刷新共享策略" onClick={() => {
              if (window.confirm("刷新并放弃未保存的共享策略改动？")) setPolicyLoaded(false);
            }}><RefreshCw size={16} /></button>
          </div>
        </fieldset>
      </form>}
    </details>
    <details className="context-disclosure" onToggle={(e) => setOpened(e.currentTarget.open)}>
      <summary>多模型并行</summary>
      <div className="orchestration-hint">把任务拆给多个模型同时执行，各自产出后汇总。</div>
      {opened && <>
        <form className="graph-editor" onSubmit={(event) => {
          event.preventDefault();
          const current = epoch.current;
          void action(async () => {
            const run = await startGraphRun(taskId, nodes, parallel, minutes * 60);
            if (current === epoch.current) { setRuns((p) => [run, ...p]); onChanged(); }
          });
        }}>
          {nodes.map((node, index) => <div className="graph-node-editor" key={node.id}>
            <div className="graph-node-heading"><code>{node.id}</code>
               <select aria-label={`${node.id} harness`} value={node.harness} disabled={locked} onChange={(e) => updateNode(index, { harness: e.target.value, execution: inheritedExecution() })}>
                 {harnesses.map((h) => <option key={h}>{h}</option>)}
              </select>
              <label><input type="checkbox" checked={node.read_only} disabled={locked} onChange={(e) => updateNode(index, { read_only: e.target.checked })} />只读</label>
              <button type="button" className="icon-button" title={`移除 ${node.id}`} aria-label={`移除 ${node.id}`} disabled={locked || nodes.length === 1}
                onClick={() => setNodes((p) => p.filter((n) => n.id !== node.id).map((n) => ({ ...n, dependencies: n.dependencies.filter((d) => d !== node.id) })))}><Trash2 size={14} /></button>
            </div>
            <ExecutionPicker harness={node.harness} value={node.execution ?? inheritedExecution()} taskId={taskId}
              label={`${node.id} `} disabled={locked} onChange={(execution) => updateNode(index, { execution })} />
            <textarea aria-label={`${node.id} 任务要求`} required maxLength={16000} rows={2} disabled={locked} value={node.prompt}
              onChange={(e) => updateNode(index, { prompt: e.target.value })} />
            {nodes.length > 1 && <fieldset disabled={locked}><legend>依赖</legend><div className="graph-options">
              {nodes.filter((n) => n.id !== node.id).map((n) => <label key={n.id}><input type="checkbox" checked={node.dependencies.includes(n.id)}
                onChange={(e) => updateNode(index, { dependencies: e.target.checked ? [...node.dependencies, n.id] : node.dependencies.filter((d) => d !== n.id) })} />{n.id}</label>)}
            </div></fieldset>}
          </div>)}
          <div className="graph-toolbar">
            <button type="button" className="icon-button" aria-label="添加协作任务" title="添加协作任务" disabled={locked || nodes.length >= 12}
              onClick={() => setNodes((p) => [...p, { id: `task-${nextId.current++}`, harness: "codex", prompt: "", dependencies: [], read_only: true }])}><Plus size={16} /></button>
            <label>并行<input aria-label="并行数量" type="number" min={1} max={3} value={parallel} disabled={locked} onChange={(e) => setParallel(Number(e.target.value))} /></label>
            <label>分钟<input aria-label="协作总时限" type="number" min={1} max={60} value={minutes} disabled={locked} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
            <button type="submit" className="icon-button" aria-label="启动并行协作" title="启动并行协作" disabled={locked}><Play size={16} /></button>
            <button type="button" className="icon-button" aria-label="刷新协作成果" title="刷新协作成果" disabled={busy} onClick={() => {
              const current = epoch.current;
              void action(async () => { const rows = await listGraphRuns(taskId); if (current === epoch.current) setRuns(rows ?? []); });
            }}><RefreshCw size={16} /></button>
          </div>
        </form>
        {runs.map((run) => <div className="graph-run" key={run.id}>
          <div className="graph-run-heading"><span>{label[run.status] ?? run.status}</span><code title={run.base_commit}>{run.base_commit.slice(0, 8)}</code>
            {run.status === "running" && <button className="icon-button" title="停止任务图" aria-label="停止任务图" disabled={busy}
              onClick={() => void action(async () => { await cancelGraphRun(run.id); })}><Square size={14} /></button>}
            {run.status === "done" && !run.integrated && run.nodes.some((n) => !n.spec.read_only) && <button className="context-command" disabled={busy}
              onClick={() => {
                if (!window.confirm("将所有隔离成果集成到源工作区？源目录必须保持基线不变。")) return;
                const current = epoch.current;
                void action(async () => { const updated = await integrateGraphRun(run.id, true); if (current === epoch.current) { setRuns((p) => p.map((r) => r.id === run.id ? updated : r)); onChanged(); } });
              }}><GitMerge size={14} />集成成果</button>}
            {run.integrated && <span>已集成</span>}
            {!["running", "discarded"].includes(run.status) && <button className="icon-button" aria-label="移除隔离成果" title="移除隔离成果" disabled={busy}
              onClick={() => {
                if (!window.confirm("移除本任务图的所有隔离工作树和补丁？聊天记录及已集成到源目录的修改将保留。")) return;
                const current = epoch.current;
                void action(async () => { const updated = await discardGraphRun(run.id, true); if (current === epoch.current) { setRuns((p) => p.map((r) => r.id === run.id ? updated : r)); onChanged(); } });
              }}><Trash2 size={14} /></button>}
          </div>
          {run.error && <div className="context-error">{run.error}</div>}
          {run.nodes.map((node) => <details className="graph-node-result" key={node.spec.id}>
            <summary>{node.spec.id} · {node.spec.harness} · {label[node.status] ?? node.status}</summary>
             {run.status === "running" && node.status === "pending" && <DelegationExecution runId={run.id} target={node.spec.id}
               harness={node.spec.harness} initial={node.spec.execution ?? inheritedExecution()} taskId={taskId} />}
             {node.task_id && <div className="execution-current">
               <span title={node.spec.execution?.model ?? ""}>{node.spec.execution?.model || "默认模型"}</span>
               <span>{effortLabel(node.spec.execution?.effort || "默认")}</span>
             </div>}
            {node.error && <div className="context-error">{node.error}</div>}
            {node.report && <pre>{node.report}</pre>}
            {node.patch_hash && <code title={node.patch_hash}>{node.patch_hash.slice(0, 12)}</code>}
          </details>)}
        </div>)}
      </>}
    </details>
  </div>;
}
