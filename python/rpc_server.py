#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
board-replay —— Python 侧棋盘渲染工作者（JSON-RPC over stdio，仅依赖 Pillow）

协议纪律（见 cordis-host-python-bridge 技能）：
  - stdout 只走一行一对象的 JSON-RPC 2.0，所有日志/异常栈走 stderr；
  - 处理器执行期间重定向 stdout->stderr，保证协议通道不被污染；
  - 每个方法 try/except 兜住，返回 JSON-RPC error，子进程不死。

方法：
  - ping             -> 探针（返回 python 版本）
  - render_board_png -> 给定 size + 二维棋盘矩阵 渲染棋盘 PNG
                        kind="go"   : 矩阵为 0空/1黑/2白，木盘+星位+棋子
                        kind="chess": 矩阵为字符('KQRBNP'白 / 'kqrbnp'黑 / '.'空)，
                                     8x8 双色格 + 圆盘字母棋子（无星位）
        可选增强参数（默认全部关闭，保持既有出图口径不变）：
          coords=True     棋盘四周标注 A-T 列 / 1-N 行坐标（围棋专用）
          highlight=(x, y) 在内部坐标 (列,行) 落红圈标记最后一手
          caption="文本"  棋盘下方渲染一行字幕（手数/落点/提子数等）
          title="文本"    棋盘上方渲染一行标题
          font="路径"     覆盖默认中文字体（默认 msyh.ttc，找不到则回退 arial）
"""

import sys
import os
import json
import traceback
import contextlib


def _setup_stdio_utf8():
    """三条标准流统一为 UTF-8（跨机器/中文 Windows 行为一致，避免孤立代理项）。

    中文 Windows 控制台 Python 默认 stdio 编码是 GBK(cp936)：本进程用
    ensure_ascii=False 写一行一 JSON-RPC，非 ASCII 字符会被编成 GBK 字节，
    而 Node 侧 readline 按 UTF-8 解码会得孤立代理项 -> 解 JSON 失败。
    显式 reconfigure 后协议两端都是 UTF-8。
    """
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass  # 流被重定向成不支持 reconfigure 的对象时保持原样


def _hoshi(size):
    """星位（内部坐标 x,y，自上而下/左→右）；小棋盘对称，与引擎坐标一致。"""
    if size == 9:
        return [(2, 2), (6, 2), (2, 6), (6, 6), (4, 4)]
    if size == 13:
        return [(3, 3), (9, 3), (3, 9), (9, 9), (6, 6)]
    if size >= 19:
        return [(3, 3), (9, 3), (15, 3),
                (3, 9), (9, 9), (15, 9),
                (3, 15), (9, 15), (15, 15)]
    return []


# 围棋列字母（跳过 I），与前端 COLS / 引擎坐标一致
GO_COLS = "ABCDEFGHJKLMNOPQRST"

# 中文字体候选（Windows）；找不到就回退 arial / PIL 默认位图字体
_FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
    "C:/Windows/Fonts/arial.ttf",
]


def _load_font(size, path=None):
    """加载字体：优先显式 path，其次中文字体候选，最后 PIL 默认字体。"""
    from PIL import ImageFont

    if path:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            pass
    for cand in _FONT_CANDIDATES:
        if os.path.exists(cand):
            try:
                return ImageFont.truetype(cand, size)
            except Exception:
                continue
    try:
        return ImageFont.load_default()
    except Exception:
        return None


def _norm_highlight(v):
    """highlight 参数归一化 -> (x, y) 或 None。接受 [x,y] / {"x":..,"y":..}。"""
    if v is None:
        return None
    try:
        if isinstance(v, dict):
            x, y = v.get("x"), v.get("y")
        else:
            x, y = v[0], v[1]
        x, y = int(x), int(y)
        return (x, y)
    except Exception:
        return None


def _fit_font(draw, text, max_width, start_size, font_path=None, min_size=9):
    """按可用宽度自动缩小字号，保证标题/字幕不被裁切。返回 (font, size)。"""
    size = max(9, int(start_size))
    while size > min_size:
        f = _load_font(size, font_path)
        if f is None:
            return None, size
        try:
            if draw.textlength(str(text), font=f) <= max_width:
                return f, size
        except Exception:
            pass
        size -= 1
    return _load_font(size, font_path), size


def _render_go(p):
    """围棋盘渲染。

    未开启增强参数时，走与历史版本**完全一致**的基本布局（margin*2 + (size-1)*px），
    保证既有出图口径不变；开启 coords/highlight/caption/title 后启用带标注的新布局。
    """
    from PIL import Image, ImageDraw

    size = int(p.get("size", 19))
    board = p.get("board") or [[0] * size for _ in range(size)]
    px = int(p.get("px", 44))
    margin = int(p.get("margin", px))
    out = p.get("out")
    if not out:
        raise ValueError("render_board_png 需要 out 参数")

    coords = bool(p.get("coords"))
    highlight = _norm_highlight(p.get("highlight"))
    caption = p.get("caption")
    title = p.get("title")
    font_path = p.get("font")
    enhanced = bool(coords or highlight or caption or title)

    bg = (219, 179, 117)   # 木色盘
    line = (40, 40, 40)    # 网格线

    if enhanced:
        # 布局自外向内：标题带 / [行号槽][棋盘边框] / [列字母槽] / 字幕带
        # 棋盘边框留 px —— 棋子画在网格线交点上，半径 0.46*px，边缘必须有溢出空间，
        # 否则最右列与最下行的棋子会被裁掉（历史基本布局靠 margin=px 保证同理）。
        gutter = 26 if coords else 0
        board_m = px
        pad_r = 8
        title_h = 44 if title else 0
        caption_h = 36 if caption else 0
        grid = (size - 1) * px
        w = gutter + board_m + grid + board_m + pad_r
        h = title_h + board_m + grid + board_m + gutter + caption_h
        origin_x = gutter + board_m
        origin_y = title_h + board_m
    else:
        w = margin * 2 + (size - 1) * px
        h = w
        origin_x = margin
        origin_y = margin

    img = Image.new("RGB", (w, h), bg)
    draw = ImageDraw.Draw(img)

    # 网格
    for i in range(size):
        c = origin_x + i * px
        draw.line([(c, origin_y), (c, origin_y + (size - 1) * px)], fill=line, width=1)
        draw.line([(origin_x, c), (origin_x + (size - 1) * px, c)], fill=line, width=1)

    # 星位
    for (sx, sy) in _hoshi(size):
        cx = origin_x + sx * px
        cy = origin_y + sy * px
        r = max(3, px // 8)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=line)

    # 棋子
    for y in range(size):
        for x in range(size):
            v = board[y][x] if y < len(board) and x < len(board[y]) else 0
            if not v:
                continue
            cx = origin_x + x * px
            cy = origin_y + y * px
            r = int(px * 0.46)
            if v == 1:
                fill, outline = (30, 30, 30), (10, 10, 10)
            else:
                fill, outline = (240, 240, 240), (150, 150, 150)
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill, outline=outline, width=1)

    if not enhanced:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        img.save(out)
        return {"ok": True, "file": out, "width": w, "height": h, "size": size}

    # ---------- 增强层：坐标 / 最后一手 / 标题 / 字幕 ----------

    # 最后一手：红圈标记（与 Web 前端口径一致）
    if highlight is not None:
        hx, hy = highlight
        if 0 <= hx < size and 0 <= hy < size:
            cx = origin_x + hx * px
            cy = origin_y + hy * px
            draw.ellipse(
                [cx - px * 0.22, cy - px * 0.22, cx + px * 0.22, cy + px * 0.22],
                outline=(226, 59, 59), width=max(2, px // 16),
            )

    if coords:
        f_coord = _load_font(max(11, px // 3), font_path)
        # 左侧行号：内部 y=0 是最上一行，对应引擎行号 size；y 越大行号越小
        for y in range(size):
            draw.text(
                (gutter / 2, origin_y + y * px),
                str(size - y), fill=(60, 45, 30), font=f_coord, anchor="mm",
            )
        # 底部列字母：A..T（跳过 I）
        col_y = origin_y + (size - 1) * px + board_m + gutter / 2
        for x in range(size):
            draw.text(
                (origin_x + x * px, col_y),
                GO_COLS[x], fill=(60, 45, 30), font=f_coord, anchor="mm",
            )

    # 标题 / 字幕：字号自适应宽度，避免被裁切
    if title:
        f_title, _ = _fit_font(draw, title, w - 16, max(14, px // 2), font_path)
        draw.text((w / 2, title_h / 2), str(title), fill=(35, 28, 20), font=f_title, anchor="mm")

    if caption:
        f_cap, _ = _fit_font(draw, caption, w - 16, max(12, int(px * 0.42)), font_path)
        cap_y = origin_y + (size - 1) * px + board_m + gutter + caption_h / 2
        draw.text((w / 2, cap_y), str(caption), fill=(45, 34, 24), font=f_cap, anchor="mm")

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out)
    return {"ok": True, "file": out, "width": w, "height": h, "size": size}


def _render_chess(p):
    from PIL import Image, ImageDraw, ImageFont

    size = int(p.get("size", 8))
    board = p.get("board") or [["."] * size for _ in range(size)]
    px = int(p.get("px", 52))
    margin = int(p.get("margin", 26))
    out = p.get("out")
    if not out:
        raise ValueError("render_board_png 需要 out 参数")

    w = margin * 2 + (size - 1) * px
    img = Image.new("RGB", (w, w), (240, 217, 181))
    draw = ImageDraw.Draw(img)

    # 双色格（r=0 顶端=第8横线；让 a8 深色、h1 浅色，符合标准棋盘）
    light, dark = (240, 217, 181), (181, 136, 99)
    for r in range(size):
        for c in range(size):
            col = light if (r + c) % 2 == 1 else dark
            draw.rectangle(
                [margin + c * px, margin + r * px, margin + c * px + px, margin + r * px + px],
                fill=col,
            )

    # 坐标标注（文件 a-h / 横线 8..1）
    try:
        font = ImageFont.truetype("arial.ttf", max(10, px // 4))
    except Exception:
        font = ImageFont.load_default()
    files = "abcdefgh"
    draw.fill = (91, 70, 54)
    for c in range(size):
        draw.text((margin + c * px + px / 2, w - margin / 2), files[c], fill=(91, 70, 54), font=font, anchor="mm")
    for r in range(size):
        draw.text((margin / 2, margin + r * px + px / 2), str(size - r), fill=(91, 70, 54), font=font, anchor="mm")

    # 棋子：圆盘 + 字母（颜色区分敌我）
    for r in range(size):
        for c in range(size):
            cell = board[r][c] if r < len(board) and c < len(board[r]) else "."
            if not cell or cell == ".":
                continue
            white = cell == cell.upper()
            cx = margin + c * px + px / 2
            cy = margin + r * px + px / 2
            rad = px * 0.4
            fill = (248, 248, 248) if white else (43, 43, 43)
            outline = (154, 154, 154) if white else (0, 0, 0)
            draw.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=fill, outline=outline, width=2)
            letter = cell.upper()
            draw.text((cx, cy + 1), letter, fill=(28, 28, 28) if white else (243, 243, 243),
                      font=font, anchor="mm")

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out)
    return {"ok": True, "file": out, "width": w, "height": w, "size": size}


def _render_board_png(p):
    kind = (p.get("kind") or "go").lower()
    if kind == "chess":
        return _render_chess(p)
    return _render_go(p)


def handle(method, params):
    p = params or {}
    if method == "ping":
        return {"python": sys.version.split()[0]}
    if method == "render_board_png":
        return _render_board_png(p)
    raise ValueError("unknown method: " + str(method))


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        msgid = req.get("id")
        method = req.get("method")
        params = req.get("params")
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = handle(method, params)
            resp = {"jsonrpc": "2.0", "id": msgid, "result": result}
        except Exception as e:
            resp = {
                "jsonrpc": "2.0",
                "id": msgid,
                "error": {"code": -32000, "message": str(e), "data": traceback.format_exc()},
            }
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    _setup_stdio_utf8()
    main()
