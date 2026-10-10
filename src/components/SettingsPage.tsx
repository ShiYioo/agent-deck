import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { X, Plus, ArrowLeft, Pencil, RefreshCw, Trash2, Coins } from "lucide-react";
import { useIsPresent } from "motion/react";
import { MotionLayer } from "../motion/MotionProvider";

import {
  addModelProfile,
  addProfileModel,
  clearProfileModels,
  deleteModelProfile,
  deleteProfileModel,
  fetchUpstreamModels,
  fetchUpstreamRates,
  getDefaultCwd,
  getSetting,
  listModelProfiles,
  listProfileModels,
  setModelProfileEnabled,
  updateProfileModel,
  setSetting,
  updateModelProfile,
} from "../api";
import type { ModelProfile, ProfileModel } from "../api";

type Section = "general" | "models";

const PROVIDER_LABEL: Record<string, string> = { glm: "GLM", gpt: "GPT", custom: "自定义" };

function maskKey(k: string) {
  if (k.length <= 8) return "•••";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** "1M"/"200K"/"128000" → token 数；空串 = null（通道默认）；非法 = NaN */
function parseContextWindow(s: string): number | null {
  const t = s.trim().toUpperCase();
  if (!t) return null;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*([KM])?$/);
  if (!m) return Number.NaN;
  const n = Number.parseFloat(m[1]);
  return Math.round(n * (m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : 1));
}

function formatContextWindow(n: number | null): string {
  if (!n) return "";
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n % 1_000 === 0) return `${n / 1_000}K`;
  return String(n);
}

/** 设置行：标签+描述居左，控件居右 */
function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-stone-100 py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-stone-800">{label}</div>
        {desc && <div className="mt-0.5 text-xs leading-relaxed text-stone-500">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** 开关 */
function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
        on ? "bg-stone-800" : "bg-stone-300"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all duration-200 ${
          on ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** 模型目录行：内联编辑，失焦/回车自动保存（倍率来自上游，只读展示） */
function ModelRow({
  row,
  isDefault,
  onMakeDefault,
  onRenamed,
  onSaved,
  onError,
}: {
  row: ProfileModel;
  isDefault: boolean;
  onMakeDefault: (name: string) => void;
  /** 重命名了默认模型行时同步父级选择 */
  onRenamed: (oldName: string, newName: string) => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(row.model);
  const [win, setWin] = useState(formatContextWindow(row.context_window));
  const [max, setMax] = useState(formatContextWindow(row.max_tokens));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === row.model) {
      if (!trimmed) setName(row.model);
    }
    const ctx = parseContextWindow(win);
    const out = parseContextWindow(max);
    if (Number.isNaN(ctx) || Number.isNaN(out)) {
      onError("窗口格式：1M / 200K / 纯数字 token");
      return;
    }
    const unchanged =
      trimmed === row.model && ctx === row.context_window && out === row.max_tokens;
    if (!trimmed || unchanged) return;
    setSaving(true);
    try {
      await updateProfileModel(row.id, trimmed, ctx, out);
      if (isDefault && trimmed !== row.model) onRenamed(row.model, trimmed);
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "min-w-0 rounded-lg border border-transparent px-1.5 py-1 font-mono text-xs outline-none transition-colors hover:border-stone-200 focus:border-stone-400 focus:bg-white";
  return (
    <div className="flex items-center gap-2 py-1">
      <button
        role="radio"
        aria-checked={isDefault}
        aria-label={`设为默认 ${row.model}`}
        title={isDefault ? "默认模型" : "设为默认模型"}
        onClick={() => onMakeDefault(row.model)}
        className={`shrink-0 rounded-full border transition-colors ${
          isDefault
            ? "border-stone-800 bg-stone-900"
            : "border-stone-300 bg-white hover:border-stone-500"
        }`}
        style={{ width: 14, height: 14 }}
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        aria-label="模型名称"
        className={`min-w-0 flex-1 font-mono text-xs text-stone-700 ${inputCls}`}
      />
      <input
        value={win}
        onChange={(e) => setWin(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        aria-label="上下文窗口"
        placeholder="默认"
        title="上下文窗口（1M / 200K / 纯数字 token）"
        className={`w-20 shrink-0 text-center font-mono text-xs text-stone-500 ${inputCls}`}
      />
      <input
        value={max}
        onChange={(e) => setMax(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        aria-label="最大输出 token"
        placeholder="出 8K"
        title="最大输出 token（8K / 64K / 纯数字）"
        className={`w-20 shrink-0 text-center font-mono text-xs text-stone-500 ${inputCls} ${max ? "" : "opacity-0 focus:opacity-100"}`}
      />
      {row.rate_multiplier != null && (
        <span
          className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-600"
          title="上游计费倍率"
        >
          {row.rate_multiplier}x
        </span>
      )}
      {saving && <span className="shrink-0 text-xs text-stone-300">…</span>}
    </div>
  );
}

/** 全页设置（Codex 桌面端式）：左侧分区导航 + 右侧行式布局 */
export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<Section>("general");
  const present = useIsPresent();
  useEffect(() => {
    if (!present) return;
    const previous = document.activeElement as HTMLElement | null;
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      previous?.focus();
    };
  }, [onClose, present]);

  // 常规
  const [defaultCwd, setDefaultCwd] = useState("");
  const [isolation, setIsolation] = useState(true);
  const [notifyOn, setNotifyOn] = useState(true);

  // 模型池
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    provider: "custom",
    label: "",
    api_key: "",
    base_url: "",
    protocol: "chat",
  });
  // 默认模型：在模型列表里用单选钮指定（不再单独输入）
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // 模型列表管理：展开的供应商 + 其模型目录 + 添加行输入
  const [modelLists, setModelLists] = useState<Record<string, ProfileModel[]>>({});
  const [newModelName, setNewModelName] = useState("");
  const [newModelWindow, setNewModelWindow] = useState("");
  const [newModelMax, setNewModelMax] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchingRates, setFetchingRates] = useState(false);
  // 每个档案的模型数量（行上直接可见，也是展开按钮的徽标）
  const [modelCounts, setModelCounts] = useState<Record<string, number>>({});

  const emptyForm = { provider: "custom", label: "", api_key: "", base_url: "", protocol: "chat" };

  const loadProfiles = useCallback(() => {
    listModelProfiles()
      .then((rows) => {
        setProfiles(rows);
        for (const p of rows) {
          listProfileModels(p.id)
            .then((ms) => setModelCounts((m) => ({ ...m, [p.id]: ms.length })))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    getDefaultCwd().then(setDefaultCwd).catch(() => {});
    getSetting("worktree_isolation").then((v) => setIsolation(v !== "off"));
    getSetting("notifications_enabled").then((v) => setNotifyOn(v !== "off"));
    loadProfiles();
  }, [loadProfiles]);

  const flash = (msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus(null), 1400);
  };

  const pickDefaultCwd = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setDefaultCwd(picked);
    await setSetting("default_cwd", picked);
    flash("默认目录已更新");
  };

  const saveIsolation = async (v: boolean) => {
    setIsolation(v);
    await setSetting("worktree_isolation", v ? "on" : "off");
    flash(v ? "任务隔离已开启" : "任务隔离已关闭");
  };

  const saveNotify = async (v: boolean) => {
    setNotifyOn(v);
    await setSetting("notifications_enabled", v ? "on" : "off");
    flash(v ? "通知已开启" : "通知已关闭");
  };

  const openAdd = () => {
    setForm(emptyForm);
    setDefaultModel(null);
    setEditingId(null);
    setAdding(true);
  };

  const openEdit = (p: ModelProfile) => {
    setForm({
      provider: p.provider,
      label: p.label ?? "",
      api_key: p.api_key,
      base_url: p.base_url ?? "",
      protocol: p.protocol ?? "chat",
    });
    setDefaultModel(p.model ?? null);
    setAdding(false);
    setEditingId(p.id);
    listProfileModels(p.id)
      .then((rows) => setModelLists((m) => ({ ...m, [p.id]: rows })))
      .catch(() => {});
  };

  const closeForm = () => {
    setAdding(false);
    setEditingId(null);
    setForm(emptyForm);
    setDefaultModel(null);
  };

  const saveProfile = async () => {
    if (!form.api_key.trim()) {
      flash("API Key 不能为空");
      return;
    }
    const payload = {
      provider: form.provider,
      label: form.label.trim() || null,
      api_key: form.api_key.trim(),
      base_url: form.base_url.trim() || null,
      model: defaultModel,
      protocol: form.protocol,
    };
    try {
      let saved: ModelProfile | null = null;
      if (editingId) {
        saved = await updateModelProfile({ id: editingId, ...payload });
        flash("已保存");
      } else {
        saved = await addModelProfile(payload);
        flash("已添加并启用");
      }
      closeForm();
      loadProfiles();

      // 从上游自动获取模型：目录为空且凭据齐全时静默拉取填满（失败不打扰）
      if (saved?.base_url && saved.api_key) {
        const existing = await listProfileModels(saved.id).catch(() => [] as ProfileModel[]);
        if (existing.length === 0) {
          const fetched = await fetchUpstreamModels(saved.base_url, saved.api_key).catch(() => [] as string[]);
          const ids = Array.isArray(fetched) ? fetched : [];
          for (const id of ids) {
            await addProfileModel(saved.id, id, null, null).catch(() => {});
          }
          if (ids.length > 0) {
            reloadModels(saved.id);
            flash(`已自动获取 ${ids.length} 个上游模型`);
          }
        }
      }
    } catch (e) {
      flash(String(e));
    }
  };

  // ── 模型列表管理 ──
  const reloadModels = (profileId: string) => {
    listProfileModels(profileId)
      .then((rows) => {
        setModelLists((m) => ({ ...m, [profileId]: rows }));
        setModelCounts((cnt) => ({ ...cnt, [profileId]: rows.length }));
      })
      .catch(() => {});
  };

  const addModelRow = async (p: ModelProfile) => {
    const name = newModelName.trim();
    if (!name) {
      flash("模型名称不能为空");
      return;
    }
    const win = parseContextWindow(newModelWindow);
    if (Number.isNaN(win)) {
      flash("上下文窗口格式：1M / 200K / 纯数字 token");
      return;
    }
    const maxOut = parseContextWindow(newModelMax);
    if (Number.isNaN(maxOut)) {
      flash("最大输出格式：8K / 64K / 纯数字 token");
      return;
    }
    try {
      await addProfileModel(p.id, name, win, maxOut);
      setNewModelName("");
      setNewModelWindow("");
      setNewModelMax("");
      reloadModels(p.id);
    } catch (e) {
      flash(String(e));
    }
  };

  const fetchModelsFromUpstream = async (p: ModelProfile) => {
    if (!p.base_url || !p.api_key) {
      flash("先保存 Base URL 和 API Key 再从上游获取");
      return;
    }
    setFetchingModels(true);
    try {
      const ids = await fetchUpstreamModels(p.base_url, p.api_key);
      await clearProfileModels(p.id);
      for (const id of ids) await addProfileModel(p.id, id, null, null);
      reloadModels(p.id);
      flash(`已从上游获取 ${ids.length} 个模型`);
    } catch (e) {
      flash(String(e));
    } finally {
      setFetchingModels(false);
    }
  };

  const fetchRates = async (p: ModelProfile) => {
    if (!p.base_url) {
      flash("先填写并保存 Base URL 再获取倍率");
      return;
    }
    setFetchingRates(true);
    try {
      const r = await fetchUpstreamRates(p.id, p.base_url, p.api_key);
      reloadModels(p.id);
      flash(`已从 ${r.source} 获取 ${r.applied} 个模型的倍率`);
    } catch (e) {
      flash(String(e));
    } finally {
      setFetchingRates(false);
    }
  };

  const clearModels = async (p: ModelProfile) => {
    try {
      await clearProfileModels(p.id);
      reloadModels(p.id);
    } catch (e) {
      flash(String(e));
    }
  };

  const editingProfile = editingId ? profiles.find((p) => p.id === editingId) ?? null : null;

  // 模型列表管理面板（编辑表单内嵌；一供多模）
  const renderModelManager = (p: ModelProfile) => (
    <div className="rounded-xl border border-stone-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-stone-500" title="行首圆点选中 = 默认模型（派任务未指定时使用）">
          模型列表（{modelCounts[p.id] ?? 0}）· 圆点选默认
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => fetchModelsFromUpstream(p)}
            disabled={fetchingModels}
            className="flex items-center gap-1 rounded-lg border border-stone-200 px-2 py-1 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-50"
            title="从上游 GET /models 拉取"
          >
            <RefreshCw size={12} className={fetchingModels ? "animate-spin" : ""} />
            从上游获取
          </button>
          <button
            onClick={() => fetchRates(p)}
            disabled={fetchingRates}
            className="flex items-center gap-1 rounded-lg border border-stone-200 px-2 py-1 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-50"
            title="sub2api 模型广场优先，new-api 价格表兜底"
          >
            <Coins size={12} className={fetchingRates ? "animate-pulse" : ""} />
            获取倍率
          </button>
          <button
            onClick={() => clearModels(p)}
            className="flex items-center gap-1 rounded-lg border border-stone-200 px-2 py-1 text-xs text-stone-600 hover:bg-stone-100"
          >
            <Trash2 size={12} />
            清空
          </button>
        </div>
      </div>

      {(modelLists[p.id] ?? []).length === 0 && (
        <div className="py-2 text-xs text-stone-400">暂无模型——手动添加，或从上游获取</div>
      )}
      {(modelLists[p.id] ?? []).map((m) => (
        <div key={m.id} className="flex items-center gap-2">
          <ModelRow
            row={m}
            isDefault={defaultModel === m.model}
            onMakeDefault={setDefaultModel}
            onRenamed={(o, n) => setDefaultModel((cur) => (cur === o ? n : cur))}
            onSaved={() => reloadModels(p.id)}
            onError={flash}
          />
          <button
            onClick={() => {
              deleteProfileModel(m.id)
                .then(() => reloadModels(p.id))
                .catch(() => {});
            }}
            className="shrink-0 text-stone-300 transition-colors hover:text-red-500"
            title="删除模型"
          >
            <X size={13} />
          </button>
        </div>
      ))}

      <div className="mt-2 flex gap-2">
        <input
          value={newModelName}
          onChange={(e) => setNewModelName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addModelRow(p)}
          aria-label="新模型名称"
          placeholder="模型名称（如 deepseek-chat）"
          className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1.5 font-mono text-xs outline-none focus:border-stone-400"
        />
        <input
          value={newModelWindow}
          onChange={(e) => setNewModelWindow(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addModelRow(p)}
          aria-label="新上下文窗口"
          placeholder="上下文窗口"
          className="w-24 shrink-0 rounded-lg border border-stone-200 px-2 py-1.5 font-mono text-xs outline-none focus:border-stone-400"
        />
        <input
          value={newModelMax}
          onChange={(e) => setNewModelMax(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addModelRow(p)}
          aria-label="新最大输出"
          placeholder="最大输出"
          className="w-24 shrink-0 rounded-lg border border-stone-200 px-2 py-1.5 font-mono text-xs outline-none focus:border-stone-400"
        />
        <button
          onClick={() => addModelRow(p)}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-stone-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
        >
          <Plus size={12} />
          添加
        </button>
      </div>
    </div>
  );

  const navItems: { key: Section; label: string }[] = [
    { key: "general", label: "常规" },
    { key: "models", label: "模型池" },
  ];

  return (
    <MotionLayer preset="scene" className="settings-page fixed inset-0 z-50 flex bg-white" role="dialog" aria-label="设置" aria-modal="true">
      {/* 左侧分区导航 */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-stone-100 bg-stone-50/60">
        <div className="px-5 pb-3 pt-5 text-xl font-semibold tracking-tight">设置</div>
        <nav className="flex-1 space-y-1 px-3">
          {navItems.map((n) => (
            <button
              key={n.key}
              onClick={() => setSection(n.key)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                section === n.key
                  ? "bg-stone-200/70 font-medium text-stone-900"
                  : "text-stone-600 hover:bg-stone-100"
              }`}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="px-5 pb-4">
          <button
            onClick={onClose}
            className="hover-lift w-full rounded-lg border border-stone-200 px-3 py-2 text-xs text-stone-600 hover:bg-stone-100"
          >
            <span className="flex items-center gap-2"><ArrowLeft size={14} />返回</span>
          </button>
        </div>
      </aside>

      {/* 右侧内容 */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <MotionLayer key={section} preset="scene" className="mx-auto max-w-2xl px-10 py-10">
          {section === "general" && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">常规</h1>

              <h2 className="mt-8 text-sm font-semibold text-stone-500">任务</h2>
              <div className="mt-2">
                <Row
                  label="Worktree 隔离"
                  desc="git 仓库内派发的任务在独立 worktree 分支中运行，完成后可合并或放弃"
                >
                  <Toggle label="Worktree 隔离" on={isolation} onChange={saveIsolation} />
                </Row>
                <Row
                  label="任务完成通知"
                  desc="窗口失焦时，任务完成或需要审批会弹出系统通知"
                >
                  <Toggle label="任务完成通知" on={notifyOn} onChange={saveNotify} />
                </Row>
              </div>

              <h2 className="mt-8 text-sm font-semibold text-stone-500">工作区</h2>
              <div className="mt-2">
                <Row
                  label="默认任务文件夹"
                  desc="在项目外启动的任务默认存储数据的位置"
                >
                  <div className="flex items-center gap-2">
                    <span className="max-w-56 truncate font-mono text-xs text-stone-500">
                      {defaultCwd || "（未设置）"}
                    </span>
                    <button
                      onClick={pickDefaultCwd}
                      className="rounded-lg border border-stone-200 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-100"
                    >
                      更改
                    </button>
                  </div>
                </Row>
              </div>
            </>
          )}

          {section === "models" && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">模型池</h1>

              <div className="mt-4">
                {profiles.length === 0 && (
                  <div className="py-4 text-sm text-stone-400">
                    暂无配置
                  </div>
                )}
                {profiles.map((p) => (
                  <div key={p.id} className="border-b border-stone-100 last:border-b-0">
                  <Row
                    label={`${PROVIDER_LABEL[p.provider] ?? p.provider}${p.label ? ` · ${p.label}` : ""}`}
                    desc={`${maskKey(p.api_key)}${p.base_url ? ` · ${p.base_url}` : ""} · ${modelCounts[p.id] ?? 0} 个模型`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Toggle
                        label={`启用 ${p.label ?? p.provider}`}
                        on={p.enabled}
                        onChange={() => {
                          setModelProfileEnabled(p.id, !p.enabled)
                            .then(loadProfiles)
                            .catch(() => {});
                        }}
                      />
                      <button
                        onClick={() => openEdit(p)}
                        className="text-stone-300 transition-colors hover:text-stone-700"
                        title="编辑"
                        aria-label={`编辑 ${p.label ?? p.provider}`}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => {
                          deleteModelProfile(p.id).then(loadProfiles).catch(() => {});
                        }}
                        className="text-stone-300 transition-colors hover:text-red-500"
                        title="删除"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </Row>

                  </div>
                ))}
              </div>

              {!adding && editingId === null ? (
                <button
                  onClick={openAdd}
                  className="mt-3 w-full rounded-xl border border-dashed border-stone-300 py-2.5 text-xs text-stone-500 transition-colors hover:bg-stone-50"
                >
                  <span className="flex items-center justify-center gap-2"><Plus size={14} />添加模型配置</span>
                </button>
              ) : (
                <div className="mt-3 space-y-2 rounded-xl border border-stone-200 bg-stone-50/70 p-4">
                  {editingId && (
                    <div className="text-xs font-medium text-stone-500">
                      正在编辑：{PROVIDER_LABEL[form.provider] ?? form.provider}
                    </div>
                  )}
                  <input
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                    aria-label="供应商名称"
                    placeholder="名称（可选，如「中转 · DeepSeek」）"
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 text-xs outline-none focus:border-stone-400"
                  />
                  <input
                    value={form.base_url}
                    onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                    placeholder="Base URL（如 https://api.deepseek.com/v1）"
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-xs outline-none focus:border-stone-400"
                  />
                  <input
                    type="password"
                    value={form.api_key}
                    onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                    placeholder="API Key"
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 text-xs outline-none focus:border-stone-400"
                  />
                  <div>
                    <div className="mb-1 text-xs font-medium text-stone-500">上游协议</div>
                    <div className="flex gap-2">
                      {[
                        { key: "chat", label: "Chat API" },
                        { key: "responses", label: "Responses API" },
                        { key: "anthropic", label: "Anthropic Messages" },
                      ].map((opt) => (
                        <button
                          key={opt.key}
                          onClick={() => setForm({ ...form, protocol: opt.key })}
                          className={`flex-1 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                            (form.protocol ?? "chat") === opt.key
                              ? "border-stone-800 bg-stone-900 font-medium text-white"
                              : "border-stone-200 text-stone-600 hover:bg-stone-100"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* 模型列表：编辑态内嵌管理（一供多模）；行首单选钮指定默认模型 */}
                  {editingId && editingProfile ? (
                    renderModelManager(editingProfile)
                  ) : (
                    <div className="rounded-lg border border-dashed border-stone-200 px-3 py-2 text-xs text-stone-400">
                      保存后可在表单里继续维护该供应商的模型列表（多模型 / 从上游获取 / 倍率）
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={saveProfile}
                      className="flex-1 rounded-lg bg-stone-900 py-2 text-xs font-medium text-white hover:bg-stone-700"
                    >
                      {editingId ? "保存修改" : "添加并启用"}
                    </button>
                    <button
                      onClick={closeForm}
                      className="rounded-lg border border-stone-200 px-3 py-2 text-xs text-stone-600 hover:bg-stone-100"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              {status && <div className="mt-2 text-xs text-emerald-600">{status}</div>}
            </>
          )}
        </MotionLayer>

        {/* 右上关闭 */}
        <button
          onClick={onClose}
          className="hover-lift fixed right-6 top-6 z-10 rounded-lg border border-stone-200 bg-white p-1.5 text-stone-400 hover:text-stone-700"
          title="关闭设置（Esc）"
          aria-label="关闭设置"
        >
          <X size={15} />
        </button>
      </main>
    </MotionLayer>
  );
}
