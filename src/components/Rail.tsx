import { IconBrandMark, IconPlus, IconClock, IconGear } from "./icons";

/** 最左侧窄图标栏：品牌符 + 主操作，全部自绘图标 */
export function Rail({ onNew }: { onNew: () => void }) {
  return (
    <nav className="flex h-full w-14 shrink-0 flex-col items-center border-r border-stone-200/70 bg-stone-50 py-4">
      <div className="hover-lift mb-6 flex h-9 w-9 items-center justify-center rounded-xl bg-stone-900 text-white">
        <IconBrandMark size={18} />
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
          title="设置（开发中）"
          className="hover-lift flex h-9 w-9 items-center justify-center rounded-lg text-stone-300 hover:bg-stone-200/70 hover:text-stone-600"
        >
          <IconGear size={18} />
        </button>
      </div>
    </nav>
  );
}
