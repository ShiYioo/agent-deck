import { useEffect, useState } from "react";
import { discoverCredentials, getSetting, setSetting } from "../api";
import { IconClose } from "./icons";

/** 设置面板：deck 自有运行时的模型池（GLM/GPT 双池）+ 默认目录。
 *  key/url 存 SQLite settings 表；支持从本机已有配置一键导入。 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [glmKey, setGlmKey] = useState("");
  const [gptKey, setGptKey] = useState("");
  const [glmUrl, setGlmUrl] = useState("");
  const [gptUrl, setGptUrl] = useState("");
  const [defaultCwd, setDefaultCwd] = useState("");
  const [importHint, setImportHint] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getSetting("deck_api_key_glm").then((v) => v && setGlmKey(v));
    getSetting("deck_api_key_gpt").then((v) => v && setGptKey(v));
    getSetting("deck_base_url_glm").then((v) => v && setGlmUrl(v));
    getSetting("deck_base_url_gpt").then((v) => v && setGptUrl(v));
    getSetting("default_cwd").then((v) => v && setDefaultCwd(v));
  }, []);

  const importLocal = async () => {
    try {
      const list = await discoverCredentials();
      if (list.length === 0) {
        setImportHint("本机未发现可复用的 key（opencode 登录或环境变量）");
        return;
      }
      for (const c of list) {
        if (c.target === "glm") {
          setGlmKey(c.key);
          setImportHint(`GLM key 已从 ${c.source} 导入`);
        } else if (c.target === "gpt") {
          setGptKey(c.key);
          setImportHint(`GPT key 已从 ${c.source} 导入`);
        }
      }
    } catch (e) {
      setImportHint(`导入失败：${String(e)}`);
    }
  };

  const save = async () => {
    await setSetting("deck_api_key_glm", glmKey.trim());
    await setSetting("deck_api_key_gpt", gptKey.trim());
    await setSetting("deck_base_url_glm", glmUrl.trim());
    await setSetting("deck_base_url_gpt", gptUrl.trim());
    await setSetting("default_cwd", defaultCwd.trim());
    setStatus("已保存");
    setTimeout(onClose, 600);
  };

  return (
    <div
      className="anim-backdrop fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 p-6"
      onClick={onClose}
    >
      <div
        className="anim-pop flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-stone-200 bg-white shadow-[var(--shadow-2)]"
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
          {/* 模型池：deck 自有运行时 */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-stone-700">
                模型池 · deck 自有运行时
              </span>
              <button
                onClick={importLocal}
                className="rounded-full border border-stone-200 px-2.5 py-0.5 text-[10px] text-stone-500 hover:bg-stone-100"
                title="扫描 opencode 登录凭据与环境变量"
              >
                从本机导入
              </button>
            </div>

            <label className="block">
              <span className="text-xs font-medium text-stone-600">GLM API Key</span>
              <input
                type="password"
                value={glmKey}
                onChange={(e) => setGlmKey(e.target.value)}
                placeholder="deck 主模型"
                className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-stone-600">
                GLM Base URL（可选）
              </span>
              <input
                value={glmUrl}
                onChange={(e) => setGlmUrl(e.target.value)}
                placeholder="默认 https://api.z.ai/api/coding/paas/v4"
                className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-xs outline-none focus:border-stone-400"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-stone-600">GPT API Key</span>
              <input
                type="password"
                value={gptKey}
                onChange={(e) => setGptKey(e.target.value)}
                placeholder="deck 降级模型"
                className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-stone-600">
                GPT Base URL（可选）
              </span>
              <input
                value={gptUrl}
                onChange={(e) => setGptUrl(e.target.value)}
                placeholder="默认 https://api.openai.com/v1"
                className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-xs outline-none focus:border-stone-400"
              />
            </label>

            {importHint && (
              <div className="rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-700">
                {importHint}
              </div>
            )}
            <p className="text-[10px] leading-relaxed text-stone-400">
              双池专供 deck 自有运行时（含 @ 接力、会话压缩），与
              ZCode/OpenCode/Codex 各自的登录互不影响。
              运行时自动降级：GLM 额度/认证失败 → 自动切 GPT。
            </p>
          </section>

          {/* 默认工作目录 */}
          <section>
            <span className="text-xs font-medium text-stone-600">默认工作目录</span>
            <input
              value={defaultCwd}
              onChange={(e) => setDefaultCwd(e.target.value)}
              placeholder="新任务的工作目录默认值（派任务时也会自动记住最近目录）"
              className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-xs outline-none focus:border-stone-400"
            />
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-stone-100 px-5 py-3">
          {status && <span className="text-xs text-emerald-600">{status}</span>}
          <button
            onClick={save}
            className="rounded-full bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
