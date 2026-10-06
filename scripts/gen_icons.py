#!/usr/bin/env python3
"""生成 AgentDeck 应用图标（纯 Python，无第三方依赖）。

产出 src-tauri/icons/ 下的 32x32.png / 128x128.png / 128x128@2x.png / icon.ico。
深色圆角底 + 荧光绿 "Z"（ZCode 的标识），按尺寸比例绘制，可重复执行。
"""

import os
import struct
import zlib

BG = (27, 31, 39, 255)        # #1B1F27
FG = (124, 227, 139, 255)     # #7CE38B
TRANSPARENT = (0, 0, 0, 0)
RADIUS_RATIO = 0.22           # 圆角比例


def pixel_color(x: int, y: int, size: int) -> tuple:
    """计算 (x, y) 处像素颜色：圆角深色底 + 荧光绿 Z。"""
    fx, fy = x / size, y / size

    # 圆角矩形裁剪
    r = RADIUS_RATIO
    if (fx < r and fy < r and (fx - r) ** 2 + (fy - r) ** 2 > r * r) or \
       (fx > 1 - r and fy < r and (fx - (1 - r)) ** 2 + (fy - r) ** 2 > r * r) or \
       (fx < r and fy > 1 - r and (fx - r) ** 2 + (fy - (1 - r)) ** 2 > r * r) or \
       (fx > 1 - r and fy > 1 - r and (fx - (1 - r)) ** 2 + (fy - (1 - r)) ** 2 > r * r):
        return TRANSPARENT

    # Z 字形：上横杠 / 对角线 / 下横杠
    top, bottom = 0.18, 0.82
    bar_h = 0.10
    if top <= fy <= top + bar_h and 0.22 <= fx <= 0.78:
        return FG
    if bottom - bar_h <= fy <= bottom and 0.22 <= fx <= 0.78:
        return FG
    # 对角线：从右上到左下，按 y 插值 x 中心
    if top + bar_h < fy < bottom - bar_h:
        t = (fy - top - bar_h) / (bottom - top - 2 * bar_h)
        cx = 0.72 - 0.44 * t
        half_w = 0.085
        if abs(fx - cx) <= half_w:
            return FG
    return BG


def make_png(size: int) -> bytes:
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter type 0
        for x in range(size):
            rows.extend(pixel_color(x, y, size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def make_ico(png_bytes: bytes) -> bytes:
    # ICO 内嵌 256x256 PNG（Vista+ 格式）
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack(
        "<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png_bytes), 22
    )
    return header + entry + png_bytes


def main() -> None:
    out_dir = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    png_256 = make_png(256)
    targets = {
        "32x32.png": make_png(32),
        "128x128.png": make_png(128),
        "128x128@2x.png": png_256,
    }
    for name, data in targets.items():
        with open(os.path.join(out_dir, name), "wb") as f:
            f.write(data)
    with open(os.path.join(out_dir, "icon.ico"), "wb") as f:
        f.write(make_ico(png_256))

    print(f"icons written to {out_dir}")


if __name__ == "__main__":
    main()
