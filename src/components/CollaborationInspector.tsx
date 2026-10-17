import { useState } from "react";
import { cancelCollaboration, cancelGraphNode, type Collaboration, type GraphRun } from "../api";
import { RelationshipGraph } from "./RelationshipGraph";

export function CollaborationInspector({ runs, guided = [], onViewTask, onChanged }: {
  runs: GraphRun[]; guided?: Collaboration[]; onViewTask: (id: string) => void; onChanged: () => void;
}) {
  const [selection, setSelection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!runs.length && !guided.length) return <p className="inspector-empty">当前没有多模型任务。可以在“任务与设置”中安排指挥或协作。</p>;
  return <section aria-label="协作关系与成果">
    {error && <div role="alert" className="context-error">{error}</div>}
    {guided.map((run) => <div key={run.id} className="inspector-run">
      <RelationshipGraph nodes={[{ spec: {
        id: run.id, harness: run.worker, prompt: "指导协作", dependencies: [], read_only: run.read_only ?? false,
        supervision: { commander: run.mentor, max_rounds: run.max_rounds },
      }, status: run.status, phase: run.phase, round: run.round }]} />
      <div className="inspector-node">
        {run.current_task_id && <button className="context-command" onClick={() => onViewTask(run.current_task_id!)}>打开当前执行记录</button>}
        {run.status === "running" && <button className="context-command" disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try { await cancelCollaboration(run.id); onChanged(); }
          catch (reason) { setError(String(reason)); }
          finally { setBusy(false); }
        }}>停止指导协作</button>}
        {run.error && <p role="alert">{run.error}</p>}
      </div>
    </div>)}
    {runs.map((run) => {
      const selected = run.nodes.find((node) => `${run.id}:${node.spec.id}` === selection);
      return <div key={run.id} className="inspector-run">
        <RelationshipGraph nodes={run.nodes} onSelect={(id) => setSelection(`${run.id}:${id}`)} />
        {selected && <div className="inspector-node">
          <h3>{selected.spec.prompt.split("\n")[0]}</h3>
          <p>{selected.spec.harness} · {selected.phase ?? selected.status}</p>
          {selected.task_id && <button className="context-command" onClick={() => onViewTask(selected.task_id!)}>打开执行记录</button>}
          {run.status === "running" && ["pending", "running"].includes(selected.status) &&
            <button className="context-command" disabled={busy} onClick={async () => {
              setBusy(true); setError("");
              try { await cancelGraphNode(run.id, selected.spec.id); onChanged(); }
              catch (reason) { setError(String(reason)); }
              finally { setBusy(false); }
            }}>停止此任务链</button>}
          <pre>{selected.report || selected.error || "尚未产生文本成果"}</pre>
        </div>}
      </div>;
    })}
  </section>;
}
