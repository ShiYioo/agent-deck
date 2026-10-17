import { IconBrandMark, IconPlus, IconClock, IconGear } from "./icons";

/** 最左侧窄图标栏：品牌符 + 主操作，全部自绘图标 */
export function Rail({
  onNew,
  onSettings,
}: {
  onNew: () => void;
  onSettings: () => void;
}) {
  return (
    <nav className="flex h-full w-14 shrink-0 flex-col items-center border-r border-stone-200/70 bg-stone-50 py-4">
      {/* 与桌面图标统一的品牌砖 */}
      <div
        className="hover-lift mb-6 flex h-10 w-10 items-center justify-center rounded-[14px] text-white"
        style={{
          background: "#242723",
          color: "#F4F0E6",
        }}
        title="AgentDeck"
      >
        <IconBrandMark size={28} centerColor="#E9A16C" />
      </div>
      <button
        onClick={onNew}
        title="新任务"
        className="hover-lift flex h-9 w-9 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-200/70 hover:text-stone-800"
      >
        <IconPlus size={18} />
      </button>
      <button
        title="历史任务（见侧栏）"
        className="hover-lift mt-2 flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-200/70 hover:text-stone-700"
      >
        <IconClock size={18} />
      </button>
      <div className="mt-auto">
        <button
          onClick={onSettings}
          title="设置"
          className="hover-lift flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-200/70 hover:text-stone-700"
        >
          <IconGear size={18} />
        </button>
      </div>
    </nav>
  );
}
