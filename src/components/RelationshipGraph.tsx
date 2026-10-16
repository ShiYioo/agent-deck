import { ArrowDown, ArrowRight, RotateCcw } from "lucide-react";
import type { GraphNodeSpec } from "../api";
import { HarnessIcon } from "./HarnessIcon";

export const phaseLabels: Record<string, string> = {
  planning: "规划", executing: "实施", reviewing: "验收",
};
const statusLabels: Record<string, string> = {
  pending: "等待", running: "运行中", done: "已完成", failed: "失败",
  blocked: "依赖阻塞", cancelled: "已停止", interrupted: "已中断", needs_attention: "待处理",
};
type RelationNode = {
  spec: GraphNodeSpec; status: string; phase?: string; round?: number;
};

export function RelationshipGraph({ nodes, onSelect }: {
  nodes: RelationNode[]; onSelect?: (id: string) => void;
}) {
  return <div className="relationship-graph" role="group" aria-label="指挥与协作关系图">
    {nodes.map((node) => {
      const supervision = node.spec.supervision;
      const commanderActive = node.status === "running" && node.phase !== "executing";
      return <div className="relationship-lane" key={node.spec.id} data-status={node.status}>
        <div className="relationship-caption">
          <button type="button" disabled={!onSelect} onClick={() => onSelect?.(node.spec.id)}
            title={node.spec.prompt} aria-label={`查看关系任务 ${node.spec.id}`}>
            <code>{node.spec.id}</code><span>{node.spec.prompt.split("\n")[0] || "待填写任务"}</span>
          </button>
          <span className="relationship-status">{statusLabels[node.status] ?? node.status}
            {node.status === "running" && node.phase ? ` · ${phaseLabels[node.phase] ?? node.phase}` : ""}
            {!!node.round && ` · ${node.round}/${supervision?.max_rounds ?? 1} 轮`}
          </span>
        </div>
        {!!node.spec.dependencies.length && <div className="relationship-dependencies">
          <ArrowDown size={12} /><span>依赖</span>
          {node.spec.dependencies.map((id) => <button key={id} type="button" disabled={!onSelect}
            onClick={() => onSelect?.(id)} aria-label={`查看依赖 ${id}`}>{id}</button>)}
        </div>}
        <div className="relationship-chain">
          {supervision && <>
            <div className="relationship-runner" data-active={commanderActive}>
              <HarnessIcon harness={supervision.commander} size={18} />
              <span>{supervision.commander}<small>指挥 · 验收</small></span>
            </div>
            <div className="relationship-arrows" aria-label="派发执行，验收未通过则返工">
              <span>派发<ArrowRight size={15} /></span>
              <span><RotateCcw size={13} />验收 / 返工</span>
            </div>
          </>}
          <div className="relationship-runner" data-active={node.status === "running" && !commanderActive}>
            <HarnessIcon harness={node.spec.harness} size={18} />
            <span>{node.spec.harness}<small>{supervision ? "执行" : "协作者"}</small></span>
          </div>
        </div>
      </div>;
    })}
  </div>;
}
