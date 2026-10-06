import { useCallback, useEffect, useState } from "react";
import {
  addModelProfile,
  deleteModelProfile,
  getDefaultCwd,
  listModelProfiles,
  setModelProfileEnabled,
  setSetting,
} from "../api";
import { IconClose } from "./icons";

type ModelProfile = {
  id: string;
  provider: string;
  label: string | null;
  api_key: string;
  base_url: string | null;
  enabled: boolean;
  created_at: number;
};

const PROVIDER_META: Record<
  string,
  { label: string; urlPlaceholder: string }
> = {
  glm: {
    label: "GLM",
    urlPlaceholder: "默认 https://api.z.ai/api/coding/paas/v4",
  },
  gpt: {
    label: "GPT",
    urlPlaceholder: "默认 https://api.openai.com/v1",
  },
};

function maskKey(k: string) {
  if (k.length <= 8) return "•••";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** 设置面板：模型配置档案（多供应商、可增删、可启停）+ 真实默认工作目录 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [defaultCwd, setDefaultCwd] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    provider: "glm",
    label: "",
    api_key: "",
    base_url: "",
  });
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(() => {
    listModelProfiles().then(setProfiles).catch(() => {});
    getDefaultCwd().then(setDefaultCwd).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (p: ModelProfile) => {
    await setModelProfileEnabled(p.id, !p.enabled).catch(() => {});
    load();
  };

  const remove = async (p: ModelProfile) => {
    await deleteModelProfile(p.id).catch(() => {});
    load();
  };

  const add = async () => {
    if (!form.api_key.trim()) {
      setStatus("API Key 不能为空");
      return;
    }
    try {
      await addModelProfile({
        provider: form.provider,
        label: form.label.trim() || null,
        api_key: form.api_key.trim(),
        base_url: form.base_url.trim() || null,
      });
      setAdding(false);
      setForm({ provider: "glm", label: "", api_key: "", base_url: "" });
      setStatus("已添加并启用");
      load();
    } catch (e) {
      setStatus(String(e));
    }
  };

  const saveDefaultCwd = async () => {
    await setSetting("default_cwd", defaultCwd.trim());
    setStatus("默认目录已保存");
    setTimeout(() => setStatus(null), 1200);
  };

  return (
    <div
      className="anim-backdrop fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 p-6"
      onClick={onClose}
    >
      <div
        className="anim-pop flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-stone-200 bg-white shadow-[var(--shadow-2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-3">
          <span className="text-sm font-semibold">设置</span>
          <button
            onClick={onClose}
            className="hover-lift rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          >
            <IconClose size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* 模型配置档案 */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-stone-700">
                模型配置档案（deck 自有运行时，按顺序自动降级）
              </span>
              <button
                onClick={() => setAdding((v) => !v)}
                className="rounded-full border border-stone-200 px-2.5 py-0.5 text-[10px] text-stone-500 hover:bg-stone-100"
              >
                {adding ? "收起" : "＋ 添加配置"}
              </button>
            </div>

            {/* 新增表单 */}
            {adding && (
              <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50/70 p-3">
                <div className="flex gap-2">
                  <select
                    value={form.provider}
                    onChange={(e) =>
                      setForm({ ...form, provider: e.target.value })
                    }
                    className="rounded-lg border border-stone-200 px-2 py-1.5 text-xs"
                  >
                    <option value="glm">GLM</option>
                    <option value="gpt">GPT</option>
                  </select>
                  <input
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                    placeholder="备注名（可选）"
                    className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1.5 text-xs outline-none focus:border-stone-400"
                  />
                </div>
                <input
                  type="password"
                  value={form.api_key}
                  onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                  placeholder="API Key"
                  className="w-full rounded-lg border border-stone-200 px-2 py-1.5 text-xs outline-none focus:border-stone-400"
                />
                <input
                  value={form.base_url}
                  onChange={(e) =>
                    setForm({ ...form, base_url: e.target.value })
                  }
                  placeholder="Base URL（可选，留空用 provider 默认）"
                  className="w-full rounded-lg border border-stone-200 px-2 py-1.5 font-mono text-xs outline-none focus:border-stone-400"
                />
                <button
                  onClick={add}
                  className="w-full rounded-lg bg-stone-900 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
                >
                  添加并启用
                </button>
              </div>
            )}

            {/* 配置列表 */}
            {profiles.length === 0 && !adding && (
              <div className="rounded-lg bg-stone-50 px-3 py-3 text-xs text-stone-400">
                暂无配置。首次打开时已自动从本机凭据（opencode
                登录等）导入——若无，点上方「添加配置」。
              </div>
            )}
            {profiles.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2.5 rounded-lg border border-stone-100 bg-stone-50/60 px-3 py-2"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      p.provider === "glm" ? "#059669" : "#0284c7",
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-stone-700">
                    {PROVIDER_META[p.provider]?.label ?? p.provider}
                    {p.label && (
                      <span className="truncate text-[10px] font-normal text-stone-400">
                        {p.label}
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[10px] text-stone-400">
                    {maskKey(p.api_key)}
                    {p.base_url ? ` · ${p.base_url}` : ""}
                  </div>
                </div>
                <button
                  onClick={() => toggle(p)}
                  role="switch"
                  aria-checked={p.enabled}
                  className={`relative h-4.5 w-8 shrink-0 rounded-full transition-colors duration-200 ${
                    p.enabled ? "bg-emerald-500" : "bg-stone-300"
                  }`}
                  title={p.enabled ? "点击停用" : "点击启用"}
                >
                  <span
                    className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all duration-200 ${
                      p.enabled ? "left-4" : "left-0.5"
                    }`}
                  />
                </button>
                <button
                  onClick={() => remove(p)}
                  className="shrink-0 text-xs text-stone-300 hover:text-red-500"
                  title="删除"
                >
                  ✕
                </button>
              </div>
            ))}

            <p className="text-[10px] leading-relaxed text-stone-400">
              启用的档案按顺序构成 deck
              运行时的模型链：主配置额度/认证失败时自动切换到下一个。档案专供
              deck 运行时（含 @接力、会话压缩），与 ZCode/OpenCode/Codex
              各自的登录互不影响。
            </p>
          </section>

          {/* 默认工作目录：显示真实值，可编辑 */}
          <section className="space-y-1">
            <span className="text-xs font-semibold text-stone-700">
              默认工作目录
            </span>
            <div className="flex items-center gap-2">
              <input
                value={defaultCwd}
                onChange={(e) => setDefaultCwd(e.target.value)}
                placeholder="AgentDeck 工作区（默认 ~/AgentDeck）"
                className="min-w-0 flex-1 rounded-lg border border-stone-200 px-3 py-2 font-mono text-xs outline-none focus:border-stone-400"
              />
              <button
                onClick={saveDefaultCwd}
                className="shrink-0 rounded-lg border border-stone-200 px-3 py-2 text-xs text-stone-600 hover:bg-stone-100"
              >
                保存
              </button>
            </div>
            <p className="text-[10px] text-stone-400">
              新任务的默认落点；也可在每次派任务时用文件夹选择器临时指定。
            </p>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-stone-100 px-5 py-3">
          {status && <span className="text-xs text-emerald-600">{status}</span>}
          <button
            onClick={onClose}
            className="rounded-full bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
