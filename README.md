# board-replay

统一本地棋谱复盘器 —— 围棋（SGF）与国际象棋（UCI）一个界面里看。

基于 [Cordis](https://cordis.js.org/) 内核 + 原生 canvas 前端 + 可选 Python/Pillow 出图，
零三方运行时依赖（Node 宿主侧纯 JS；出图仅需 Python + Pillow）。

> 把 lab 系列项目里「围棋」与「跨语言国际象棋循环赛」的真实对局记录整合到同一个复盘器，
> 逐手回放、对比终局，前端步进/滑块浏览，并可导出 PNG。

---

## 功能

- **围棋（Go）复盘**：解析 SGF（FF\[4\]），坐标翻转、落子、整组提子、过手（pass），按手数回放。
- **国际象棋（chess）复盘**：解析 lab 循环赛战报导出的 UCI 着法记录，复用 vendored 的规则引擎
  （与 lab 赛事 runner 同款）逐手回放——王车易位、吃过路兵、升变全部支持，终局判定
  （将死 / 和棋 / 三轮重复 / 逼和）由引擎实时算出。
- **统一 Web UI**：左侧棋谱列表（按 `kind` 标注【围棋】/【国象】），右侧棋盘，首手/上一手/滑块/下一手/终局
  控制，最后一手高亮；国象盘带 8×8 方格、坐标标注（a–h / 1–8）、圆盘字母棋子。
- **PNG 出图**：经 JSON-RPC stdio 桥调用 Python（仅 Pillow）渲染木色围棋盘 / 8×8 国际象棋盘。
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
```

打开浏览器访问 `http://127.0.0.1:5173`，在左侧选择棋谱即可逐步复盘。

---

## 目录结构

```
board-replay/
├── cordis.json            # board + chess + http 插件配置（默认启动）
├── cordis.print.json      # 增加 print 插件（PNG 出图）
├── src/
│   ├── boot.mjs           # Cordis 宿主启动/关停（读 cordis.json 或 BOARD_CONFIG 环境变量）
│   ├── _smoke.mjs         # 端到端冒烟
│   ├── core/
│   │   ├── sgf.mjs        # vendored from weiqi_lab：SGF 解析（FF[4]）
│   │   ├── bridge.mjs     # vendored from cordis-table-app：JSON-RPC stdio 桥
│   │   └── chess_engine.mjs# vendored from lab/tournament/engine.mjs：国象规则引擎（perft 自检）
│   └── plugins/
│       ├── board.mjs      # BoardService：围棋 SGF 复盘内核
│       ├── chess.mjs      # ChessService：国象 UCI 复盘内核
│       ├── http.mjs       # HttpService：静态托管 + REST + SSE
│       └── print.mjs      # PrintService：调 Python 渲染 PNG
├── web/                   # 前端（index.html / app.js / style.css）
├── python/
│   └── rpc_server.py      # Python 渲染工作者（仅 Pillow），stdin/stdout 走 JSON-RPC
├── tools/
│   └── import_lab_chess.mjs  # 把 lab 战报导入为 samples/chess/*.json
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

### 重新导入国象对局

```bash
node tools/import_lab_chess.mjs
# 或指定单个战报 / 输出目录
node tools/import_lab_chess.mjs --report /path/to/report.md --out ./samples/chess
```

导入器会清洗掉战报里加在着法后的 `#`/`+` 注释（将死 / 叫将标记），只保留纯 UCI，
保证能被 vendored 规则引擎逐手复现。每个战报聚合为一个 JSON 文件
（`{ report, date, count, games: [...] }`），每局带全局唯一 `id`。

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
| POST | `/api/print` | 出图：`{ "id", "step?", "kind?", "out?" }`，返回 PNG 路径（需 `print` 插件） |
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
