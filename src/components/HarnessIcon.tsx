import { IconBrandMark } from "./icons";
import zcodeIcon from "../assets/harness/zcode.png";
import codexIcon from "../assets/harness/codex.svg";
import opencodeIcon from "../assets/harness/opencode.png";

/** 各 harness 官方图标（zcode/codex/opencode 为真实品牌资源，deck 用自有品牌符） */
const ICON_SRC: Record<string, string> = {
  zcode: zcodeIcon,
  codex: codexIcon,
  opencode: opencodeIcon,
};

export function HarnessIcon({
  harness,
  size = 16,
  rounded = false,
  className,
}: {
  harness: string;
  size?: number;
  /** 圆角底板形态（任务头部/diff 归属），裸图形态（侧栏行/按钮） */
  rounded?: boolean;
  className?: string;
}) {
  if (harness === "deck") {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-[6px] text-white"
        style={{
          width: size,
          height: size,
          background: "linear-gradient(135deg, #44403c 0%, #1c1917 100%)",
        }}
        title="AgentDeck Agent"
      >
        <IconBrandMark size={Math.round(size * 0.62)} />
      </span>
    );
  }

  const src = ICON_SRC[harness];
  if (!src) return null;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={harness}
      draggable={false}
      className={`shrink-0 object-contain ${rounded ? "rounded-[5px]" : ""} ${className ?? ""}`}
    />
  );
}
