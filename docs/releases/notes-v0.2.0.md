# board-replay v0.2.0 —— 围棋对局定格视频

把一整局围棋对局**完整打印**成定格视频：每一手是一张静止画面，按固定节奏逐格推进（每手 700ms），
观感如翻书式复盘，而非平滑插值动画。

## 系统要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | Cordis 4.0.0-rc.x 宿主；实测 v22.22.2 |
| Python | ≥ 3.10 | 仅用于 PNG 渲染，**仅需 Pillow**；实测 3.13.14 + Pillow 11.3.0 |
| ffmpeg | ≥ 6.0 | 视频合成，需 libx264 + gif；实测 9.0.2 |
| 中文字体 | msyh.ttc / simhei.ttf | 坐标/字幕中文渲染；Windows 自带 |

## 本次附件内容

`board-replay-v0.2.0-replay-videos.zip`（7.57 MB，302 个文件）—— 两局完整对局的定格视频：

| 棋谱 | 对局 | 手数 | 帧数 | 结果 | mp4 | gif |
|---|---|---|---|---|---|---|
| `2026-10-09-g01-pyvsjs` | PyWeiqi（黑） vs JsWeiqi（白） | 155 | 156 | B+73.5 | 0.80 MB | 0.41 MB |
| `2026-10-09-g03-cppvsgo` | CppWeiqi（黑） vs GoWeiqi（白） | 139 | 140 | W+14.5 | 0.71 MB | 0.36 MB |

zip 内结构：

```
<棋谱 id>/
├── <棋谱 id>-replay.mp4    定格视频（h264 / yuv420p / 514×586 / 25fps）
├── <棋谱 id>-replay.gif    循环播放 gif
├── <棋谱 id>-replay.json   帧清单（每手步号/落点/提子数 + 视频规格）
└── frames/<棋谱 id>-NNNN.png  逐手 PNG 帧（NNNN = 步号，0000 为开局空盘）
```

每一帧带：棋盘坐标标注（A–T 跳 I / 行号 1–9）、最后一手红圈、手数字幕（含提子数）、
顶部标题（对局双方 / 棋盘大小 / 贴目 / 结果）。

`SHA256SUMS.txt` 为逐文件 SHA-256 清单（302 行），与 zip 内文件路径一一对应。

## 完整性校验

```bash
# 1) 校验 zip 本身
sha256sum board-replay-v0.2.0-replay-videos.zip
# 7f1c46f5ec9ba322c9e6e69d59d1cfb16a5da7a9537e587c1c90b838b8bbba3f

# 2) 解包后逐文件核对
unzip board-replay-v0.2.0-replay-videos.zip -d vids
cd vids && sha256sum -c ../SHA256SUMS.txt
```

## 自己生成

```bash
git clone https://gitee.com/siwpan/board-replay.git
cd board-replay && npm install

npm run video -- --list                      # 列出可打印的围棋谱
npm run video                               # 默认打印手数最多的一局
npm run video -- --id 2026-10-09-g01-pyvsjs --hold 700 --px 48
```

## 保真验证（两道离岸交叉验证门禁）

两局视频均通过，验证方式刻意使用**另一套独立实现**（赛事裁判 `src/core/referee.mjs`，
vendored 自 weiqi_lab，MIT）来交叉比对：

```bash
# 门禁1：裁判复演 samples/*.sgf，终局结果须与 SGF 的 RE 字段一致
npm run verify:go
#   -> 通过 15 / 失败 0

# 门禁2：像素级验证 —— 裁判复演局面 + 独立重建叠加层渲染，与视频帧逐帧全图 SHA-256 比对
BOARD_PYTHON=E:/Python314/python.exe npm run verify:video -- \
  samples/2026-10-09-g01-pyvsjs.sgf output/video/2026-10-09-g01-pyvsjs/frames 48
#   -> ✓ 两套独立内核逐手局面与提子数全等（156 局面）
#   -> ✓ 裁判终局 B+73.5（B81/W0 贴目7.5）== SGF RE
#   -> ✓ 全部 156 帧全图 SHA-256 一致（裁判复演 == 视频帧）
```

门禁 2 的四道关卡：逐手局面全等 → 逐手提子数全等 → 裁判终局 == SGF RE → 全部帧全图 SHA-256 一致。
任一不过即退出码 1。裁判模块已 vendored 进仓，**独立 clone 后即可运行**，无需额外仓库。

## 许可与对应源码

- 本项目：**MIT License**，见仓库根 `LICENSE`。
- 附件内的视频与帧：由本项目代码生成，无第三方素材。
- `src/core/referee.mjs`：vendored 自 `weiqi_lab/tournament/referee.mjs`（同作者，MIT），
  逐字副本 + 溯源标注头；对应源码即仓库内该文件。
- 源码获取：`git clone https://gitee.com/siwpan/board-replay.git`（tag `v0.2.0`）。

## 本版本实测数据

| 项 | 实测 |
|---|---|
| 局1 帧数 | 156（= 155 手 + 1 开局空盘），视频 109.2s |
| 局2 帧数 | 140（= 139 手 + 1 开局空盘），视频 98.0s |
| 提子统计 | 局1 黑 71 / 白 11；局2 黑 32 / 白 37 |
| 门禁1 | 15 局全过 |
| 门禁2 | 局1 156 帧、局2 140 帧全图 SHA-256 一致 |
| 回归 | 既有 `npm run smoke` 全过；基本出图口径 440×440 未变 |

## 已知限制

- **视频产物不入 Git 仓库**（`.gitignore` 忽略 `output/`），只经本发行版附件分发。
- 门禁 2 需要 Python + Pillow；**门禁 1 与主功能不需要**（纯 Node）。
- 帧序列 PNG 体积较大（两局合计约 7MB），只打包进附件、不进仓库。
- `npm run verify:video` 默认比对局1 的 48px 帧；换 `--px` 生成的帧需传对应像素值。
- 视频为静默无音轨（棋类复盘惯例，仅棋盘与字幕）。
