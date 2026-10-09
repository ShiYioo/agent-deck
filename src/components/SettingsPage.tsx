import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { X, Plus, ArrowLeft, Pencil, ChevronDown, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import { useIsPresent } from "motion/react";
import { MotionLayer } from "../motion/MotionProvider";

import {
  addModelProfile,
  addProfileModel,
  clearProfileModels,
  deleteModelProfile,
  deleteProfileModel,
  fetchUpstreamModels,
  getDefaultCwd,
  getSetting,
  listModelProfiles,
  listProfileModels,
  setModelProfileEnabled,
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
    model: "",
    protocol: "chat",
  });
  const [status, setStatus] = useState<string | null>(null);
  // 模型列表管理：展开的供应商 + 其模型目录 + 添加行输入
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modelLists, setModelLists] = useState<Record<string, ProfileModel[]>>({});
  const [newModelName, setNewModelName] = useState("");
  const [newModelWindow, setNewModelWindow] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);

  const emptyForm = { provider: "custom", label: "", api_key: "", base_url: "", model: "", protocol: "chat" };

  const loadProfiles = useCallback(() => {
    listModelProfiles().then(setProfiles).catch(() => {});
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
    setEditingId(null);
    setAdding(true);
  };

  const openEdit = (p: ModelProfile) => {
    setForm({
      provider: p.provider,
      label: p.label ?? "",
      api_key: p.api_key,
      base_url: p.base_url ?? "",
      model: p.model ?? "",
      protocol: p.protocol ?? "chat",
    });
    setAdding(false);
    setEditingId(p.id);
  };

  const closeForm = () => {
    setAdding(false);
    setEditingId(null);
    setForm(emptyForm);
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
      model: form.model.trim() || null,
      protocol: form.protocol,
    };
    try {
      if (editingId) {
        await updateModelProfile({ id: editingId, ...payload });
        flash("已保存");
      } else {
        await addModelProfile(payload);
        flash("已添加并启用");
      }
      closeForm();
      loadProfiles();
    } catch (e) {
      flash(String(e));
    }
  };

  // ── 模型列表管理 ──
  const toggleModels = (p: ModelProfile) => {
    if (expandedId === p.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(p.id);
    listProfileModels(p.id).then((rows) => setModelLists((m) => ({ ...m, [p.id]: rows }))).catch(() => {});
  };

  const reloadModels = (profileId: string) => {
    listProfileModels(profileId).then((rows) => setModelLists((m) => ({ ...m, [profileId]: rows }))).catch(() => {});
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
    try {
      await addProfileModel(p.id, name, win);
      setNewModelName("");
      setNewModelWindow("");
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
      for (const id of ids) await addProfileModel(p.id, id, null);
      reloadModels(p.id);
      flash(`已从上游获取 ${ids.length} 个模型`);
    } catch (e) {
      flash(String(e));
    } finally {
      setFetchingModels(false);
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
                    desc={`${maskKey(p.api_key)}${p.base_url ? ` · ${p.base_url}` : ""}`}
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
                        onClick={() => toggleModels(p)}
                        className="text-stone-300 transition-colors hover:text-stone-700"
                        title="模型列表"
                        aria-label={`模型列表 ${p.label ?? p.provider}`}
                        aria-expanded={expandedId === p.id}
                      >
                        {expandedId === p.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
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

                  {expandedId === p.id && (
                    <div className="pb-4">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-semibold text-stone-500">模型列表</span>
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
                            onClick={() => clearModels(p)}
                            className="flex items-center gap-1 rounded-lg border border-stone-200 px-2 py-1 text-xs text-stone-600 hover:bg-stone-100"
                          >
                            <Trash2 size={12} />
                            清空
                          </button>
                        </div>
                      </div>

                      {(modelLists[p.id] ?? []).length === 0 && (
                        <div className="py-2 text-xs text-stone-400">
                          暂无模型——手动添加，或从上游获取
                        </div>
                      )}
                      {(modelLists[p.id] ?? []).map((m) => (
                        <div key={m.id} className="flex items-center gap-2 py-1">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-stone-700">
                            {m.model}
                          </span>
                          <span className="shrink-0 font-mono text-xs text-stone-400">
                            {formatContextWindow(m.context_window) || "默认"}
                          </span>
                          <button
                            onClick={() => {
                              deleteProfileModel(m.id).then(() => reloadModels(p.id)).catch(() => {});
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
                          placeholder="模型名称（如 deepseek-chat）"
                          className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1.5 font-mono text-xs outline-none focus:border-stone-400"
                        />
                        <input
                          value={newModelWindow}
                          onChange={(e) => setNewModelWindow(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && addModelRow(p)}
                          placeholder="上下文窗口"
                          className="w-28 shrink-0 rounded-lg border border-stone-200 px-2 py-1.5 font-mono text-xs outline-none focus:border-stone-400"
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
                  )}
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
                        { key: "chat", label: "Chat Completions" },
                        { key: "responses", label: "Responses API" },
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
                  <input
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="模型 ID（如 deepseek-chat，留空用通道默认）"
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-xs outline-none focus:border-stone-400"
                  />
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
