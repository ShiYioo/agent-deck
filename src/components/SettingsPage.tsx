import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { X, Plus, ArrowLeft, Pencil, RefreshCw, Trash2, Coins, Search, Settings2, Folder, Bell, Network, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useIsPresent } from "motion/react";
import { MotionLayer } from "../motion/MotionProvider";
import { useDialogFocus } from "../hooks/useDialogFocus";

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

type Section = "general" | "models" | "workspace" | "notifications";

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
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-label">{label}</div>
        {desc && <div className="settings-row-description">{desc}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** 开关 */
function Toggle({
  on,
  onChange,
  label,
  disabled = false,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`settings-toggle ${on ? "is-on" : ""}`}
    >
      <span
        className="settings-toggle-thumb"
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
    <div className="model-catalog-fields">
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
  const [navQuery, setNavQuery] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false);
  const present = useIsPresent();
  const dialogRef = useDialogFocus(present, 'input[aria-label="搜索设置"]');
  useEffect(() => {
    if (!present) return;
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, present]);

  // 常规
  const [defaultCwd, setDefaultCwd] = useState("");
  const [isolation, setIsolation] = useState(false);
  // 受管 worktree：根目录可配置 + 超限自动清理（对齐 Codex 的 worktree 设置）
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [autoPrune, setAutoPrune] = useState(true);
  const [pruneLimit, setPruneLimit] = useState("15");
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
    getSetting("worktree_isolation").then((v) => setIsolation(v === "on"));
    getSetting("worktree_root").then((v) => setWorktreeRoot(v ?? ""));
    getSetting("worktree_auto_prune").then((v) => setAutoPrune(v !== "off"));
    getSetting("worktree_prune_limit").then((v) => setPruneLimit(v ?? "15"));
    getSetting("notifications_enabled").then((v) => setNotifyOn(v !== "off"));
    loadProfiles();
  }, [loadProfiles]);

  const flash = (msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus(null), 1400);
  };

  const pickDefaultCwd = async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      await setSetting("default_cwd", picked);
      setDefaultCwd(picked);
      flash("默认目录已更新");
    } catch (error) { flash(String(error)); }
  };

  const saveIsolation = async (v: boolean) => {
    if (savingPreference) return;
    const previous = isolation;
    setSavingPreference(true);
    setIsolation(v);
    try {
      await setSetting("worktree_isolation", v ? "on" : "off");
      flash(v ? "任务隔离已开启" : "任务隔离已关闭");
    } catch (error) {
      setIsolation(previous);
      flash(String(error));
    } finally { setSavingPreference(false); }
  };

  const saveWorktreeRoot = async () => {
    try {
      await setSetting("worktree_root", worktreeRoot.trim());
      flash(worktreeRoot.trim() ? "Worktree 根目录已更新" : "已恢复默认根目录");
    } catch (error) { flash(String(error)); }
  };

  const saveAutoPrune = async (v: boolean) => {
    if (savingPreference) return;
    const previous = autoPrune;
    setSavingPreference(true);
    setAutoPrune(v);
    try {
      await setSetting("worktree_auto_prune", v ? "on" : "off");
      flash(v ? "已开启自动清理" : "已关闭自动清理");
    } catch (error) {
      setAutoPrune(previous);
      flash(String(error));
    } finally { setSavingPreference(false); }
  };

  const savePruneLimit = async () => {
    const value = Number(pruneLimit);
    if (!Number.isFinite(value) || value < 1) {
      setPruneLimit("15");
      flash("保留数量必须是不小于 1 的整数");
      return;
    }
    try {
      await setSetting("worktree_prune_limit", String(Math.floor(value)));
      flash("保留数量已更新");
    } catch (error) { flash(String(error)); }
  };

  const saveNotify = async (v: boolean) => {
    if (savingPreference) return;
    const previous = notifyOn;
    setSavingPreference(true);
    setNotifyOn(v);
    try {
      await setSetting("notifications_enabled", v ? "on" : "off");
      flash(v ? "通知已开启" : "通知已关闭");
    } catch (error) {
      setNotifyOn(previous);
      flash(String(error));
    } finally { setSavingPreference(false); }
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
    if (savingProfile) return;
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
    setSavingProfile(true);
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
    } finally {
      setSavingProfile(false);
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
    <div className="model-manager">
      <div className="model-manager-heading">
        <span className="text-xs font-semibold text-stone-500" title="行首圆点选中 = 默认模型（派任务未指定时使用）">
          模型列表（{modelCounts[p.id] ?? 0}）
        </span>
        <div className="model-manager-actions">
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
        <div key={m.id} className="model-manager-row">
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

      <div className="model-add-fields">
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

  const navItems = [
    { key: "general" as const, label: "常规", group: "个人", icon: Settings2 },
    { key: "workspace" as const, label: "工作区", group: "个人", icon: Folder },
    { key: "notifications" as const, label: "通知", group: "个人", icon: Bell },
    { key: "models" as const, label: "模型池", group: "智能体", icon: Network },
  ];
  const filteredNav = navItems.filter((item) => `${item.label} ${item.group}`.includes(navQuery.trim()));

  return (
    <MotionLayer ref={dialogRef} tabIndex={-1} initial={false} exit={{ opacity: 1 }} transition={{ duration: 0 }}
      className="settings-page" role="dialog" aria-label="设置" aria-modal="true">
      {/* 左侧分区导航 */}
      <aside className="settings-sidebar">
        <div className="settings-sidebar-heading"><span>设置</span><button className="icon-button" title="返回工作台" aria-label="返回工作台" onClick={onClose}><ArrowLeft size={18} /></button></div>
        <label className="settings-search"><Search size={16} /><input aria-label="搜索设置" placeholder="搜索" value={navQuery} onChange={(event) => setNavQuery(event.target.value)} />
          {navQuery && <button className="icon-button" aria-label="清除设置搜索" title="清除搜索" onClick={() => setNavQuery("")}><X size={14} /></button>}</label>
        <nav aria-label="设置分区">
          {filteredNav.map((n, index) => (
            <div key={n.key}>
            {(index === 0 || filteredNav[index - 1].group !== n.group) && <div className="settings-nav-group">{n.group}</div>}
            <button
              onClick={() => setSection(n.key)}
              aria-current={section === n.key ? "page" : undefined}
              className={`settings-nav-item ${section === n.key ? "is-active" : ""}`}
            >
              <n.icon size={18} />{n.label}
            </button>
            </div>
          ))}
          {filteredNav.length === 0 && <div className="sidebar-empty">无匹配设置</div>}
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
      <main className="settings-main">
        <MotionLayer key={section} preset="scene" className="settings-content">
          {section !== "models" && (
            <>
              <h1>{navItems.find((item) => item.key === section)?.label}</h1>

              {(section === "general" || section === "notifications") && <>
              <h2 className="settings-section-heading">{section === "notifications" ? "通知偏好" : "任务"}</h2>
              <div className="settings-group">
                {section === "general" && (
                <Row
                  label="Worktree 隔离"
                  desc="默认关闭：任务直接在你的项目目录里改，文件留在原处。开启后，git 仓库内派发的任务改在独立 worktree 分支（~/AgentDeck/worktrees/）里进行，完成后可合并或放弃"
                >
                  <Toggle label="Worktree 隔离" on={isolation} onChange={saveIsolation} disabled={savingPreference} />
                </Row>)}
                {section === "general" && (
                <Row
                  label="Worktree 根目录"
                  desc="受管 worktree 的存放位置，留空使用默认（~/AgentDeck/worktrees）"
                >
                  <input
                    aria-label="Worktree 根目录"
                    value={worktreeRoot}
                    placeholder="~/AgentDeck/worktrees"
                    onChange={(event) => setWorktreeRoot(event.target.value)}
                    onBlur={() => void saveWorktreeRoot()}
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 text-xs outline-none focus:border-stone-400"
                  />
                </Row>)}
                {section === "general" && (
                <Row
                  label="自动清理旧 worktree"
                  desc="超出保留数量的旧 worktree 会自动删除目录；分支保留在仓库里，随时可复原或合并"
                >
                  <Toggle label="自动清理旧 worktree" on={autoPrune} onChange={saveAutoPrune} disabled={savingPreference} />
                </Row>)}
                {section === "general" && (
                <Row
                  label="保留数量"
                  desc="保留最近使用的受管 worktree 数量，更旧的被淘汰"
                >
                  <input
                    aria-label="保留数量"
                    type="number"
                    min={1}
                    value={pruneLimit}
                    onChange={(event) => setPruneLimit(event.target.value)}
                    onBlur={() => void savePruneLimit()}
                    className="w-24 rounded-lg border border-stone-200 px-3 py-2 text-xs outline-none focus:border-stone-400"
                  />
                </Row>)}
                <Row
                  label="任务完成通知"
                  desc="窗口失焦时，任务完成或需要审批会弹出系统通知"
                >
                  <Toggle label="任务完成通知" on={notifyOn} onChange={saveNotify} disabled={savingPreference} />
                </Row>
              </div></>}

              {(section === "general" || section === "workspace") && <>
              <h2 className="settings-section-heading">工作区</h2>
              <div className="settings-group">
                <Row
                  label="默认任务文件夹"
                  desc="在项目外启动的任务默认存储数据的位置"
                >
                  <div className="settings-directory-control">
                    <span className="settings-directory" title={defaultCwd}>
                      {defaultCwd || "（未设置）"}
                    </span>
                    <button
                      onClick={pickDefaultCwd}
                      className="shrink-0 whitespace-nowrap rounded-lg border border-stone-200 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-100"
                    >
                      更改
                    </button>
                  </div>
                </Row>
              </div></>}
            </>
          )}

          {section === "models" && (
            <>
              <h1>模型池</h1>

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
                <div className="model-profile-form">
                  {editingId && (
                    <div className="text-xs font-medium text-stone-500">
                      正在编辑：{PROVIDER_LABEL[form.provider] ?? form.provider}
                    </div>
                  )}
                  <label className="settings-field"><span>供应商名称</span><input
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                    aria-label="供应商名称"
                    placeholder="名称（可选，如「中转 · DeepSeek」）"
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 text-xs outline-none focus:border-stone-400"
                  /></label>
                  <label className="settings-field"><span>Base URL</span><input
                    value={form.base_url}
                    onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                    placeholder="Base URL（如 https://api.deepseek.com/v1）"
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-xs outline-none focus:border-stone-400"
                  /></label>
                  <label className="settings-field"><span>API Key</span><div className="settings-secret-field"><input
                    type={showKey ? "text" : "password"}
                    value={form.api_key}
                    onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                    placeholder="API Key"
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 text-xs outline-none focus:border-stone-400"
                  /><button className="icon-button" type="button" title={showKey ? "隐藏 API Key" : "显示 API Key"} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                    onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
                  <div>
                    <div className="mb-1 text-xs font-medium text-stone-500">上游协议</div>
                    <div className="protocol-control" role="radiogroup" aria-label="上游协议">
                      {[
                        { key: "chat", label: "Chat API" },
                        { key: "responses", label: "Responses API" },
                        { key: "anthropic", label: "Anthropic Messages" },
                      ].map((opt) => (
                        <button
                          key={opt.key}
                          role="radio"
                          aria-checked={(form.protocol ?? "chat") === opt.key}
                          onClick={() => setForm({ ...form, protocol: opt.key })}
                          className={(form.protocol ?? "chat") === opt.key ? "is-active" : ""}
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
                    null
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={saveProfile}
                      disabled={savingProfile}
                      className="task-action task-action-primary disabled:opacity-40"
                    >
                      {savingProfile && <LoaderCircle size={13} className="animate-spin" />}
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
            </>
          )}
        </MotionLayer>
        {status && <div className="settings-feedback" role="status">{status}</div>}

        {/* 右上关闭 */}
        <button
          onClick={onClose}
          className="icon-button settings-close"
          title="关闭设置（Esc）"
          aria-label="关闭设置"
        >
          <X size={15} />
        </button>
      </main>
    </MotionLayer>
  );
}
