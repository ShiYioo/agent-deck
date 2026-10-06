//! AgentDeck 自绘图标库
//!
//! 视觉语言：24 视窗 / 1.8 描边 / 圆角端点，几何母题取自品牌符
//! 「四菱风车」。全部用 currentColor，尺寸由 size 控制。

import type { SVGProps } from "react";

type IconProps = {
  size?: number;
  className?: string;
};

const stroke = (size: number, props: SVGProps<SVGSVGElement>) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

const fill = (size: number, props: SVGProps<SVGSVGElement>) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "currentColor",
  ...props,
});

/** 品牌符：四菱风车。centerColor 可选——传入时中心菱用该色（用于品牌砖双色处理） */
export function IconBrandMark({
  size = 24,
  className,
  centerColor,
}: IconProps & { centerColor?: string }) {
  return (
    <svg {...fill(size, { className })}>
      <path d="M12 1.6l2.6 2.6L12 6.8 9.4 4.2z" />
      <path d="M17.8 9.4l2.6 2.6-2.6 2.6-2.6-2.6z" />
      <path d="M12 17.2l2.6 2.6L12 22.4l-2.6-2.6z" />
      <path d="M6.2 9.4L8.8 12l-2.6 2.6L3.6 12z" />
      <path
        d="M12 9.4l2.6 2.6-2.6 2.6L9.4 12z"
        opacity={centerColor ? undefined : 0.55}
        fill={centerColor ?? "currentColor"}
      />
    </svg>
  );
}

export function IconPlus({ size = 18, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconClock({ size = 18, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

export function IconGear({ size = 18, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </svg>
  );
}

export function IconFolder({ size = 16, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h3.8l2 2.3h8.7A1.5 1.5 0 0 1 21 9.3V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3.5 17z" />
    </svg>
  );
}

export function IconBell({ size = 16, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

export function IconSearch({ size = 16, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function IconSend({ size = 16, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function IconChevronDown({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconBack({ size = 16, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

export function IconClose({ size = 16, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function IconKey({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <circle cx="7.5" cy="16.5" r="3.5" />
      <path d="M10.2 14 20 4.2M15.5 4.5H20V9" />
    </svg>
  );
}

export function IconDiff({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="M13 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V9z" />
      <path d="M13 3.5V9h5.5" />
      <path d="M9.5 14.5h5M12 12v5" />
    </svg>
  );
}

export function IconStop({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <circle cx="12" cy="12" r="9" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconRetry({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

/** 用户输入：圆角方框内的右向箭头 */
export function IconPrompt({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="m10 8.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}

/** 思考/生成：四角星（实心，配流光动画） */
export function IconSparkle({ size = 14, className }: IconProps) {
  return (
    <svg {...fill(size, { className })}>
      <path d="M12 2.6c.62 4.1 2.68 6.18 6.78 6.8-4.1.62-6.16 2.68-6.78 6.78-.62-4.1-2.68-6.16-6.78-6.78 4.1-.62 6.16-2.7 6.78-6.8z" />
      <path d="M18.8 14.6c.3 2 1.32 3.02 3.32 3.32-2 .3-3.02 1.32-3.32 3.32-.3-2-1.32-3.02-3.32-3.32 2-.3 3.02-1.32 3.32-3.32z" opacity="0.6" />
    </svg>
  );
}

/** 通用工具：扳手 */
export function IconTool({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="M14.7 6.3a4.2 4.2 0 0 0-5.6 5.6L3.6 17.4a1.8 1.8 0 0 0 2.5 2.5l5.5-5.5a4.2 4.2 0 0 0 5.6-5.6l-2.6 2.6-2.5-2.5z" />
    </svg>
  );
}

/** 命令执行：终端 */
export function IconTerminal({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="m7 9.5 3 3-3 3M12.5 15.5H17" />
    </svg>
  );
}

/** 文件编辑：笔与文档 */
export function IconFileEdit({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <path d="M20 12.5V6a1.5 1.5 0 0 0-1.5-1.5h-13A1.5 1.5 0 0 0 4 6v12a1.5 1.5 0 0 0 1.5 1.5h7" />
      <path d="M17.8 11.5a1.6 1.6 0 0 1 2.3 2.3L15 18.9l-3 .7.7-3z" />
    </svg>
  );
}

/** 网络检索：地球 */
export function IconGlobe({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.6 2.3 3.9 5 3.9 8.5s-1.3 6.2-3.9 8.5c-2.6-2.3-3.9-5-3.9-8.5s1.3-6.2 3.9-8.5z" />
    </svg>
  );
}

export function IconCheckCircle({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.3 12.3 2.5 2.5 4.9-5.2" />
    </svg>
  );
}

export function IconXCircle({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
    </svg>
  );
}

export function IconInfo({ size = 14, className }: IconProps) {
  return (
    <svg {...stroke(size, { className })}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
