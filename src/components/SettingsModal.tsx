import { useEffect, useState } from "react";
import { getSetting, setSetting } from "../api";
import { IconClose } from "./icons";

/** 设置面板：deck 运行时的 API key 等持久配置（SQLite settings 表） */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [glmKey, setGlmKey] = useState("");
  const [gptKey, setGptKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getSetting("deck_api_key_glm").then((v) => v && setGlmKey(v));
    getSetting("deck_api_key_gpt").then((v) => v && setGptKey(v));
  }, []);

  const save = async () => {
    await setSetting("deck_api_key_glm", glmKey.trim());
    await setSetting("deck_api_key_gpt", gptKey.trim());
    setStatus("已保存");
    setTimeout(onClose, 600);
  };

  return (
    <div
      className="anim-backdrop fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 p-6"
      onClick={onClose}
    >
      <div
        className="anim-pop w-full max-w-md rounded-xl border border-stone-200 bg-white p-5 shadow-[var(--shadow-2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">设置</span>
          <button
            onClick={onClose}
            className="hover-lift rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          >
            <IconClose size={15} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-stone-600">
              Z.ai API Key（GLM）
            </span>
            <input
              type="password"
              value={glmKey}
              onChange={(e) => setGlmKey(e.target.value)}
              placeholder="供 AgentDeck Agent 的 GLM 模型使用"
              className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-stone-600">
              OpenAI API Key（GPT）
            </span>
            <input
              type="password"
              value={gptKey}
              onChange={(e) => setGptKey(e.target.value)}
              placeholder="供 AgentDeck Agent 的 GPT 模型使用"
              className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
            />
          </label>
          <p className="text-[10px] leading-relaxed text-stone-400">
            Key 存储在本机数据库，随任务派发传给对应模型，不上传任何服务器。
          </p>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
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
