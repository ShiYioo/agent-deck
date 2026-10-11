import { useEffect, useState } from "react";
import { AlertCircle, RefreshCw, Settings2 } from "lucide-react";
import { checkHarness, type HarnessHealth } from "../api";

export function RuntimeStatus({ harness, refreshKey, onSettings }: {
  harness: string;
  refreshKey: boolean;
  onSettings: () => void;
}) {
  const [health, setHealth] = useState<HarnessHealth | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setHealth(null);
    checkHarness(harness).then((result) => {
      if (active) setHealth(result);
    }).catch((error) => {
      if (active) setHealth({ ready: false, issues: [`运行器检查失败：${String(error)}`] });
    });
    return () => { active = false; };
  }, [harness, refreshKey, version]);
  if (health?.ready || !health) {
    return <span className="sr-only" role="status">{health?.ready ? `${harness} 已就绪` : "检查运行器…"}</span>;
  }
  return (
    <div className={`runtime-status ${health?.ready === false ? "runtime-unavailable" : ""}`} role="status">
      <AlertCircle size={13} />
      <span>{health.issues.join("；")}</span>
      {health?.ready === false && harness === "deck" && (
        <button className="icon-button" title="模型设置" aria-label="模型设置" onClick={onSettings}><Settings2 size={14} /></button>
      )}
      <button className="icon-button" disabled={!health} title="重新检查运行器" aria-label="重新检查运行器" onClick={() => setVersion((v) => v + 1)}><RefreshCw size={13} /></button>
    </div>
  );
}
