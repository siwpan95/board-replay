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
    from PIL import Image, ImageDraw

    kind = (p.get("kind") or "go").lower()
    if kind == "chess":
        return _render_chess(p)

    size = int(p.get("size", 19))
    board = p.get("board") or [[0] * size for _ in range(size)]
    px = int(p.get("px", 44))
    margin = int(p.get("margin", px))
    out = p.get("out")
    if not out:
        raise ValueError("render_board_png 需要 out 参数")

    w = margin * 2 + (size - 1) * px
    bg = (219, 179, 117)   # 木色盘
    line = (40, 40, 40)    # 网格线
    img = Image.new("RGB", (w, w), bg)
    draw = ImageDraw.Draw(img)

    # 网格
    for i in range(size):
        c = margin + i * px
        draw.line([(c, margin), (c, margin + (size - 1) * px)], fill=line, width=1)
        draw.line([(margin, c), (margin + (size - 1) * px, c)], fill=line, width=1)

    # 星位
    for (sx, sy) in _hoshi(size):
        cx = margin + sx * px
        cy = margin + sy * px
        r = max(3, px // 8)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=line)

    # 棋子
    for y in range(size):
        for x in range(size):
            v = board[y][x] if y < len(board) and x < len(board[y]) else 0
            if not v:
                continue
            cx = margin + x * px
            cy = margin + y * px
            r = int(px * 0.46)
            if v == 1:
                fill, outline = (30, 30, 30), (10, 10, 10)
            else:
                fill, outline = (240, 240, 240), (150, 150, 150)
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill, outline=outline, width=1)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out)
    return {"ok": True, "file": out, "width": w, "height": w, "size": size}


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
