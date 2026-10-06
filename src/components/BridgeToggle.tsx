import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type BridgeStatus = {
  installed: boolean;
  zcode: string | null;
  codex: string | null;
  file: string;
};

/** 侧栏底部：A2A 桥接开关——开 = 两家 CLI 互相拥有委派工具 */
export function BridgeToggle() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    invoke<BridgeStatus>("bridge_status")
      .then(setStatus)
      .catch(() => {});
  };
  useEffect(refresh, []);

  const toggle = async () => {
    if (busy || !status) return;
    setBusy(true);
    try {
      setStatus(
        await invoke<BridgeStatus>(
          status.installed ? "bridge_remove" : "bridge_install",
        ),
      );
    } catch {
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const on = status?.installed ?? false;

  return (
    <div className="mx-3 mb-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-stone-300"}`}
        />
        <span className="text-xs font-medium text-stone-700">Agent 互调桥</span>
        <span className="flex-1" />
        <button
          onClick={toggle}
          disabled={busy || status === null}
          aria-checked={on}
          role="switch"
          className={`relative h-4.5 w-8 rounded-full transition-colors duration-200 disabled:opacity-50 ${
            on ? "bg-emerald-500" : "bg-stone-300"
          }`}
          title={on ? "点击断开桥接" : "点击安装桥接（注入两家 MCP 配置）"}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all duration-200 ${
              on ? "left-4" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <div className="mt-1 text-[10px] leading-relaxed text-stone-400">
        {on
          ? "Codex 与 ZCode 已互相拥有委派工具，可直接用自然语言让它们协作"
          : "开启后 AgentDeck 会自动把委派工具注入两家的 MCP 配置"}
      </div>
    </div>
  );
}
