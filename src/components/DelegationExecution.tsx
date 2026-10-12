import { useEffect, useRef, useState } from "react";
import { Save, RefreshCw } from "lucide-react";
import { listExecutionOverrides, updateDelegationExecution, type ExecutionConfig } from "../api";
import { ExecutionPicker } from "./ExecutionPicker";

export function DelegationExecution({ runId, target, harness, initial, taskId, disabled = false }: {
  runId: string; target: string; harness: string; initial: ExecutionConfig; taskId: string; disabled?: boolean;
}) {
  const [config, setConfig] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const load = async (current: number) => {
    setBusy(true); setError("");
    try {
      const rows = await listExecutionOverrides(runId);
      if (epoch.current !== current) return;
      const row = rows.find((r) => r.target === target);
      const next = row?.config ?? initial;
      setConfig(next); setSaved(next); setVersion(row?.version ?? 0);
    } catch (reason) { if (epoch.current === current) setError(String(reason)); }
    finally { if (epoch.current === current) setBusy(false); }
  };
  useEffect(() => {
    const current = ++epoch.current;
    void load(current);
    return () => { ++epoch.current; };
  }, [runId, target]);
  const dirty = JSON.stringify(config) !== JSON.stringify(saved);
  return <div className="delegation-execution">
    <ExecutionPicker harness={harness} value={config} onChange={setConfig} label={`${target} `} taskId={taskId} disabled={disabled || busy} />
    <div className="execution-actions">
      <span className="execution-note">后续派发 · v{version}</span>
      <button type="button" className="icon-button" title="保存后续执行配置" aria-label={`${target} 保存执行配置`} disabled={disabled || busy || !dirty} onClick={async () => {
        const current = epoch.current;
        setBusy(true); setError("");
        try {
          const row = await updateDelegationExecution(runId, target, version, config);
          if (current === epoch.current) { setSaved(row.config); setVersion(row.version); }
        } catch (reason) { if (current === epoch.current) setError(String(reason)); }
        finally { if (current === epoch.current) setBusy(false); }
      }}><Save size={14} /></button>
      <button type="button" className="icon-button" title="刷新执行配置" aria-label={`${target} 刷新执行配置`} disabled={busy} onClick={() => {
        if (!dirty || window.confirm("放弃未保存的执行配置改动？")) void load(epoch.current);
      }}><RefreshCw size={14} /></button>
    </div>
    {error && <div className="context-error" role="alert">{error}</div>}
  </div>;
}
