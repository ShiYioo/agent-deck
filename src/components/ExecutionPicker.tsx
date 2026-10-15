import { useEffect, useState } from "react";
import { Brain, RefreshCw } from "lucide-react";
import { discoverExecutionModels, discoverModels, getExecutionDefaults, getSetting, listModelProfiles, listProfileModels,
  type ExecutionConfig, type ModelCapability } from "../api";
import { Dropdown, type DropdownOption } from "./Dropdown";

export const effortLabel = (value: string | null | undefined) => ({
  minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极高", none: "关闭",
} as Record<string, string>)[value ?? ""] ?? value ?? "默认";

const inherit = "__inherit__";
export function ExecutionPicker({ harness, value, onChange, label = "", disabled = false, taskId = null,
  allowInherit = true, modelOptions, showModel = true }: {
  harness: string; value: ExecutionConfig; onChange: (value: ExecutionConfig) => void; label?: string;
  disabled?: boolean; taskId?: string | null; allowInherit?: boolean; modelOptions?: DropdownOption[]; showModel?: boolean;
}) {
  const [models, setModels] = useState<ModelCapability[]>([]);
  const [options, setOptions] = useState<DropdownOption[]>([]);
  const [base, setBase] = useState<ExecutionConfig>({ model: null, effort: null });
  const [transport, setTransport] = useState("cli");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setModels([]); setOptions([]); setLoading(true); setError("");
    void (async () => {
      try {
        const [capabilities, defaults, entry] = await Promise.all([
          discoverExecutionModels(harness), getExecutionDefaults(taskId, harness), getSetting(`transport_${harness}`),
        ]);
        let rows: DropdownOption[];
        if (harness === "deck") {
          const profiles = (await listModelProfiles()).filter((p) => p.enabled);
          const groups = await Promise.all(profiles.map(async (p) => {
            const list = await listProfileModels(p.id);
            return (list.length ? list.map((m) => m.model) : p.model ? [p.model] : []).map((model) => ({
              value: `${p.id}:${model}`, label: model,
            }));
          }));
          rows = groups.flat();
        } else {
          const names = capabilities.length ? capabilities.map((m) => m.model) : await discoverModels(harness);
          rows = names.map((model) => ({ value: model, label: model, tag: model.endsWith("-free") ? "免费" : undefined }));
        }
        if (alive) { setModels(capabilities); setOptions(rows); setBase(defaults ?? { model: null, effort: null }); setTransport(entry ?? "cli"); }
      } catch (reason) { if (alive) setError(String(reason)); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [harness, taskId, refresh]);
  const effectiveModel = value.model ?? base.model ?? "";
  const efforts = models.find((m) => m.model === effectiveModel)?.efforts ?? [];
  const locked = disabled || transport === "acp";
  const modelValue = value.model === null && allowInherit ? inherit : value.model ?? "";
  // 不提供「默认模型」空选项：必须选具体模型（没有就是没有）
  const modelChoices: DropdownOption[] = [
    ...(allowInherit ? [{ value: inherit, label: "继承会话配置" }] : []),
    ...(modelOptions ?? options).filter((o) => o.value !== ""),
  ];
  if (value.model && !modelChoices.some((o) => o.value === value.model)) modelChoices.push({ value: value.model, label: value.model });
  const effectiveEffort = value.effort ?? base.effort ?? "";
  const unsupported = !!effectiveEffort && !efforts.includes(effectiveEffort);
  return <div className="execution-picker" aria-label={`${label}执行配置`}>
    {showModel && <Dropdown title={`${label}模型`} value={modelValue} disabled={locked || loading} searchable
      displayLabel={modelValue ? undefined : loading ? "加载中" : "选择模型"}
      options={modelChoices} groupBy={(v) => v === inherit ? "默认" : v.includes("/") ? v.split("/")[0] : harness}
      onChange={(model) => onChange({ model: model === inherit ? null : model, effort: model === inherit ? null : "" })} />}
    <Dropdown title={`${label}思考强度`} icon={<Brain size={14} />} value={value.effort === null && allowInherit ? inherit : value.effort ?? ""}
      displayLabel={loading ? "加载中" : unsupported ? "档位待调整" : efforts.length ? effortLabel(effectiveEffort || "默认") : "不可配置"}
      disabled={locked || loading || (!efforts.length && !unsupported)}
      options={[
        ...(allowInherit ? [{ value: inherit, label: "继承会话配置" }] : []),
        { value: "", label: "默认" },
        ...efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
      ]} onChange={(effort) => onChange({ ...value, effort: effort === inherit ? null : effort })} />
    {error && <button type="button" className="icon-button" title={`模型能力加载失败：${error}`} aria-label={`${label}重试模型目录`} onClick={() => setRefresh((n) => n + 1)}><RefreshCw size={14} /></button>}
    {transport === "acp" && <span className="execution-note">ACP · 默认配置</span>}
    {unsupported && <span className="execution-note" role="alert">当前模型不支持该档位</span>}
  </div>;
}
