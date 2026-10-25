# board-replay

统一本地棋谱复盘器 —— 围棋（SGF）与国际象棋（UCI）一个界面里看。

基于 [Cordis](https://cordis.js.org/) 内核 + 原生 canvas 前端 + 可选 Python/Pillow 出图，
零三方运行时依赖（Node 宿主侧纯 JS；出图仅需 Python + Pillow）。

> 把 lab 系列项目里「围棋」与「跨语言国际象棋循环赛」的真实对局记录整合到同一个复盘器，
> 逐手回放、对比终局，前端步进/滑块浏览，并可导出 PNG。

当前版本：**v0.2.0**（见 [发行版说明](docs/releases/notes-v0.2.0.md) /
[Gitee Releases](https://gitee.com/siwpan/board-replay/releases)）

---

## 功能

- **围棋（Go）复盘**：解析 SGF（FF\[4\]），坐标翻转、落子、整组提子、过手（pass），按手数回放。
- **国际象棋（chess）复盘**：解析 lab 循环赛战报导出的 UCI 着法记录，复用 vendored 的规则引擎
  （与 lab 赛事 runner 同款）逐手回放——王车易位、吃过路兵、升变全部支持，终局判定
  （将死 / 和棋 / 三轮重复 / 逼和）由引擎实时算出。
- **统一 Web UI**：左侧棋谱列表（按 `kind` 标注【围棋】/【国象】），右侧棋盘，首手/上一手/滑块/下一手/终局
  控制，最后一手高亮；国象盘带 8×8 方格、坐标标注（a–h / 1–8）、圆盘字母棋子。
- **PNG 出图**：经 JSON-RPC stdio 桥调用 Python（仅 Pillow）渲染木色围棋盘 / 8×8 国际象棋盘。
  围棋盘可选叠加**坐标标注**、**最后一手红圈**、**标题**与**字幕**（默认全部关闭，既有出图口径不变）。
- **定格视频**：把一整局棋逐手渲染成 PNG 帧序列，再用 ffmpeg 合成定格视频（mp4 + gif），
  每手定格固定毫秒数，观感如翻书式复盘。详见 [定格视频](#定格视频)。
- **战报导入**：`tools/import_lab_chess.mjs` 把 lab 的 Markdown 战报转成可直接复盘的 UCI JSON。

---

## 快速开始

```bash
npm install

# 启动 Web UI（围棋 + 国象），监听 http://127.0.0.1:5173
npm start

# 启用 PNG 出图（需要 Python + Pillow；本机确认 E:/Python314/python.exe 含 Pillow）
BOARD_CONFIG=cordis.print.json BOARD_PYTHON=E:/Python314/python.exe npm start

# 无浏览器端到端冒烟（Go 提子 + 国象复盘保真 + 规则引擎 perft 自检）
npm run smoke

# 打印一局围棋对局为定格视频（默认取手数最多的一局）
npm run video -- --list                      # 先看有哪些可打印的谱
npm run video                               # 生成 mp4 + gif
npm run video -- --id 2026-10-09-g01-pyvsjs --hold 700 --px 48
```

打开浏览器访问 `http://127.0.0.1:5173`，在左侧选择棋谱即可逐步复盘。

---

## 定格视频

把一整局棋**完整打印**成定格视频：每一手是一张静止画面，按固定节奏逐格推进（默认每手 700ms），
观感如翻书式复盘，而非平滑插值动画。

```bash
npm run video -- --list                      # 列出可打印的围棋谱（按手数降序）
npm run video                               # 默认打印手数最多的一局
npm run video -- --id 2026-10-09-g01-pyvsjs --hold 700 --px 48
npm run video -- --id <id> --no-gif         # 只出 mp4
```

流水线（`tools/replay_video.mjs`）：

```
SGF 谱
  └─ board.mjs 逐手复盘（含整组提子）
       └─ print.renderSequence() 逐手出 PNG 帧（坐标标注 + 最后一手红圈 + 手数字幕）
            └─ ffmpeg 合成定格视频 -> <id>-replay.mp4 (h264/yuv420p) + <id>-replay.gif
```

产物落在 `output/video/<id>/`：

| 文件 | 说明 |
| --- | --- |
| `<id>-replay.mp4` | 定格视频（h264 / yuv420p，浏览器与播放器通用） |
| `<id>-replay.gif` | 循环播放的 gif |
| `<id>-replay.json` | 帧清单（每手的步号/落点/提子数 + 视频规格） |
| `frames/<id>-NNNN.png` | 逐手 PNG 帧（`NNNN` = 步号，从 0000 开局空盘起） |

### 帧数守恒

帧数恒等于 **手数 + 1**（含开局空盘）。工具在合成后自检：目录 PNG 数 == 清单帧数 == 手数 + 1，
不符即退出码 1。实测示例（`2026-10-09-g01-pyvsjs`，155 手）：156 帧 × 700ms = 109.2s。

### 保真验证（两道门禁）

出图建立在「复盘内核逐子正确」的前提上，因此有两道**离岸交叉验证**——都刻意用
**另一套独立实现**（赛事裁判 `src/core/referee.mjs`，vendored 自 weiqi_lab）来验：

```bash
# 门禁 1：赛事裁判复演 samples/*.sgf，终局结果必须与 SGF 的 RE 字段一致
npm run verify:go
#   -> 通过 15 / 失败 0

# 门禁 2：像素级验证 —— 裁判复演局面 + 重建叠加层渲染，与视频帧逐帧全图 SHA-256 比对
BOARD_PYTHON=E:/Python314/python.exe npm run verify:video -- \
  samples/2026-10-09-g01-pyvsjs.sgf output/video/2026-10-09-g01-pyvsjs/frames 48
#   -> ✓ 两套独立内核逐手局面与提子数全等（156 个局面）
#   -> ✓ 裁判终局 B+73.5（B81/W0 贴目7.5）== SGF RE
#   -> ✓ 全部 156 帧全图 SHA-256 一致（裁判复演 == 视频帧）
```

门禁 2 的四道关卡：两套内核逐手局面全等 → 逐手提子数全等 → 裁判终局 == SGF RE →
全部帧全图 SHA-256 一致。任一不过即退出码 1。

> 裁判模块已 **vendored 进本仓**（`src/core/referee.mjs`，MIT，逐字副本 + 溯源标注头），
> 因此两个门禁在**独立 clone 后即可运行**，无需同级放置 `weiqi_lab`。
> 若需确认 vendored 副本与上游是否仍同步（上游改了要重新 vendored），跑：
> `node tools/verify_go_sgf_referee.mjs --upstream` —— 它比对「去掉标注头后的正文」SHA-256。

### 坐标方向（易错点）

三处坐标约定各不相同，混用会导致画面与棋谱对不上：

| 位置 | 约定 |
| --- | --- |
| SGF 点串 `dd` | 列 `a` 最左、行 `a` 最上 |
| 引擎顶点 `D16` | 列 `A→T`（跳过 I）最左、行号 `1` 在**下** |
| board.mjs 内部 `(x,y)` | `y=0` 在**上**（与 SGF 一致），渲染时直接用 |
| 赛事裁判 `cells` | 行优先、**row=1 在底行**（比对本侧时需翻转） |

---

```
board-replay/
├── cordis.json            # board + chess + http 插件配置（默认启动）
├── cordis.print.json      # 增加 print 插件（PNG 出图）
├── cordis.video.json      # 仅 board + print（定格视频用，不占 HTTP 端口）
├── src/
│   ├── boot.mjs           # Cordis 宿主启动/关停（读 cordis.json 或 BOARD_CONFIG 环境变量）
│   ├── _smoke.mjs         # 端到端冒烟
│   ├── core/
│   │   ├── sgf.mjs        # vendored from weiqi_lab：SGF 解析（FF[4]）
│   │   ├── referee.mjs    # vendored from weiqi_lab/tournament/referee.mjs：赛事裁判（离岸验证用）
│   │   ├── bridge.mjs     # vendored from cordis-table-app：JSON-RPC stdio 桥
│   │   └── chess_engine.mjs# vendored from lab/tournament/engine.mjs：国象规则引擎（perft 自检）
│   └── plugins/
│       ├── board.mjs      # BoardService：围棋 SGF 复盘内核
│       ├── chess.mjs      # ChessService：国象 UCI 复盘内核
│       ├── http.mjs       # HttpService：静态托管 + REST + SSE
│       └── print.mjs      # PrintService：调 Python 渲染 PNG（单帧 + 逐手序列）
├── web/                   # 前端（index.html / app.js / style.css）
├── python/
│   └── rpc_server.py      # Python 渲染工作者（仅 Pillow），stdin/stdout 走 JSON-RPC
├── tools/
│   ├── import_lab_chess.mjs       # 把 lab 战报导入为 samples/chess/*.json
│   ├── verify_lab_report.mjs      # lab 国际象棋战报的离岸交叉验证
│   ├── replay_video.mjs           # 围棋对局 -> 定格视频（mp4 + gif）
│   ├── verify_go_sgf_referee.mjs  # 门禁1：赛事裁判复演 SGF，终局须与 RE 一致
│   └── verify_replay_video.mjs    # 门禁2：视频帧逐帧 SHA-256 与裁判复演比对
├── samples/
│   ├── *.sgf              # 围棋样例（来自 weiqi_lab/tournament/sgf）
│   └── chess/*.json       # 国象样例（来自 lab 跨语言循环赛战报）
└── LICENSE                # MIT
```

---

## 数据来源

| 盘类 | 原始记录 | 落地位置 |
| --- | --- | --- |
| 围棋 | `weiqi_lab/tournament/sgf/*.sgf`（9×9） | `samples/*.sgf` |
| 国象 | `lab/tournament/reports/*.md`（runner 导出的 UCI 战报） | `samples/chess/*.json` |

> **两个 lab 的分工**：`lab/` 是**国际象棋**跨语言循环赛（`GoChess` 是 Go *语言*写的国象引擎，
> 不是围棋）；**围棋**对局来自同系列的 `weiqi_lab/`（`GoWeiqi` 等）。本仓库 `samples/*.sgf`
> 是 `weiqi_lab/tournament/sgf/` 的逐字副本（MD5 一致）。
> 赛事裁判 `referee.mjs` 也已 vendored 进本仓（`src/core/referee.mjs`，MIT，同作者），
> 故离岸验证门禁无需外部仓库即可运行。

### 重新导入国象对局

```bash
node tools/import_lab_chess.mjs
# 或指定单个战报 / 输出目录
node tools/import_lab_chess.mjs --report /path/to/report.md --out ./samples/chess
```

导入器会清洗掉战报里加在着法后的 `#`/`+` 注释（将死 / 叫将标记），只保留纯 UCI，
保证能被 vendored 规则引擎逐手复现。每个战报聚合为一个 JSON 文件
（`{ report, date, count, games: [...] }`），每局带全局唯一 `id`。

### 作为 lab 循环赛的「独立复盘验证环节」

`tools/verify_lab_report.mjs`（`npm run verify`）把上面的导入 + 回放做成一道**离岸交叉验证**：

```bash
# 验证当天 lab 战报（默认 D:/projects/lab/tournament/reports/YYYY-MM-DD.md）
npm run verify

# 指定战报 + 输出 Markdown 验证报告
node tools/verify_lab_report.mjs --report /path/to/2026-09-30.md --md reports/verify-2026-09-30.md
```

四道关卡（任一不过即退出码 1；缺战报/零对局为 2）：

| # | 关卡 | 判据 |
| --- | --- | --- |
| 1 | 规则引擎 perft 黄金值自检 | 5 项官方基准全过（证明本侧规则 == lab runner 规则） |
| 2 | 逐手合法性 | 战报每一手 UCI 都能被规则引擎接受，非法即 FAIL |
| 3 | 终局一致 | 重放出的终局（checkmate / stalemate / threefold / 其它和棋）与战报声明的 reason 吻合，将死局还要核对胜方颜色 |
| 4 | 服务态一致 | 启动 Cordis host（`BOARD_PORT=0` 由系统分配端口，不占用常驻 5173），REST `/api/games` 与 `/state?step=total` 的棋盘、终局与离线重放逐子一致 |

「裁定/异常局」（max-ply 和棋 / 超时 / 崩溃 / 不战而胜）不强制终局，但若回放实际是**将死或逼和**
会记一条**软告警**（不计 FAIL）——例如 runner 打到 `MAX_PLY` 最后一手正好将死却仍裁定为和棋，
这类 adjudication 边界缺口会被稳定暴露出来。

---

## 加入你自己的对局

- **围棋**：把 `.sgf` 丢进 `samples/`（或改 `cordis.json` 里 `board` 插件的 `sgfDir`）。
- **国象**：把对局写成 `{ "white","black","result","reason","moves":["e2e4",...] }` 的 JSON
  放到 `samples/chess/`，或写一份 Markdown 战报用 `tools/import_lab_chess.mjs` 转换。

---

## HTTP API

所有响应为 JSON，除特别说明外监听 `127.0.0.1`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/games` | 棋谱列表（围棋 + 国象合并，每项带 `kind`: `go` / `chess`） |
| GET | `/api/games/:id` | 单谱元信息（含 `size`、`total`、`result` 等） |
| GET | `/api/games/:id/state?step=k` | 第 `k` 手后的局面（`step=0` 开局，`step=total` 终局）。<br>国象返回 `board`（字符矩阵：大写白 / 小写黑 / `.` 空）、`last`、`terminal` 等 |
| POST | `/api/print` | 出图：`{ "id", "step?", "kind?", "out?" }`，返回 PNG 路径（需 `print` 插件）。<br>可选 `"extra": { "coords": true, "highlight": [x,y], "caption": "...", "title": "..." }` 透传渲染增强参数（仅围棋生效） |
| GET | `/api/events` | SSE：连接即推当前棋谱列表 |

国象 `state` 的 `terminal` 字段：

```json
{ "type": "checkmate", "winner": "w" }      // 将死，winner 为胜方颜色
{ "type": "stalemate" }                      // 逼和
{ "type": "draw", "reason": "threefold" }    // 三轮重复等和棋
```

---

## 复盘保真说明

国象规则引擎 `src/core/chess_engine.mjs` 是 `lab/tournament/engine.mjs` 的**逐字 vendored 副本**
（仅移除了 `node engine.mjs test` 的导入期自运行守卫），因此这里回放出的每一个局面，
都与 lab 跨语言循环赛 runner 在赛事中记录的局面**逐子一致**。`npm run smoke` 会对该引擎做
perft 黄金值自检（Start/Kiwipete/Wiki 等 5 项），全过即证明规则实现与官方基准吻合。

---

## 许可证

[MIT](./LICENSE) © 2026 siwpan
