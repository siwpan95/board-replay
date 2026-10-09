// tools/import_lab_chess.mjs
// 把 lab 跨语言国际象棋循环赛战报（Markdown）里的对局导出成 board-replay 可直接复盘的
// UCI 记录 JSON，写入 samples/chess/。
//
// 战报格式（tournament/run_tournament.mjs 生成）：
//   ### go (Go) vs rust (Rust)                       <- 对（pair）头
//   **第 1 局** （go 执白， rust 执黑） — 和棋（threefold）   <- 单局头
//   > 开局： Pirc Defense                             <- （部分战报）开局备注，非着法
//   > b1c3 b8c6 d2d4 ... h6g7#                        <- 整局标注版 UCI（可能带 #/+ 注释）
//
// runner 在写战报时会给将死着加 '#'、叫将着加 '+'（见 run_tournament.mjs 179-183），
// 这里清洗掉注释只留纯 UCI（含可选升变字母），保证能被 vendored chess_engine 的 applyUci 复现。
//
// 输出：每个战报一个聚合文件 samples/chess/<stem>.json = { report, date, count, games:[...] }，
// 每局 id 全局唯一（lab-<stem>-<执白>-<执黑>-<第N局>），避免同日多份战报的 id 冲突。
//
// 用法：
//   node tools/import_lab_chess.mjs                       # 导入 board-replay 旁边 lab 的全部战报
//   node tools/import_lab_chess.mjs --report /path/x.md   # 只导入单个战报
//   node tools/import_lab_chess.mjs --out ./samples/chess # 指定输出目录
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function cleanUci(token) {
  const m = token.match(/^[a-h][1-8][a-h][1-8][qrbnQRBN]?/)
  return m ? m[0] : null
}

function parseGameHeader(line) {
  const num = (line.match(/第\s*(\d+)\s*局/) || [])[1] || '?'
  const wm = line.match(/([A-Za-z0-9_]+)\s*执白/)
  const bm = line.match(/([A-Za-z0-9_]+)\s*执黑/)
  const white = wm ? wm[1] : ''
  const black = bm ? bm[1] : ''
  // 结果原因取行内最后一个括号（形如「— 和棋（threefold）」「— go 胜 vb（checkmate）」）；
  // 前面的「（go 执白， vb 执黑）」是先后手说明，不是原因。
  const allP = line.match(/[（(]([^）)]*)[）)]/g)
  const reason = allP && allP.length ? allP[allP.length - 1].slice(1, -1) : ''
  const win = line.match(/([A-Za-z0-9_]+)\s*胜\s*([A-Za-z0-9_]+)/)
  let result = 'draw'
  let winner = null
  let loser = null
  if (win) { result = 'win'; winner = win[1]; loser = win[2] }
  else if (/和棋|和局|draw/i.test(line)) result = 'draw'
  else if (/胜|win/i.test(line)) result = 'win'
  else if (/负|loss/i.test(line)) result = 'loss'
  else if (/forfeit|超时|timeout|crash|异常|illegal/i.test(line)) result = 'crash'
  return { num, white, black, result, winner, loser, reason }
}

// 解析单个战报文件，返回聚合对象 { report, date, games: [...] }
async function parseReport(file) {
  const text = await readFile(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const stem = basename(file).replace(/\.md$/i, '')
  const date = (stem.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || 'unknown'
  const games = []
  let pending = null // { num, white, black, result, winner, loser, reason }
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^###\s/.test(trimmed)) { pending = null; continue }
    if (/^\*\*第/.test(trimmed)) { pending = parseGameHeader(trimmed); continue }
    // 着法行：必须含至少一个合法 UCI token；「> 开局：...」之类非着法行直接跳过并保留 pending
    if (/^>\s/.test(trimmed) && pending) {
      const moves = trimmed.slice(1).trim().split(/\s+/)
        .map((t) => cleanUci(t))
        .filter(Boolean)
      if (!moves.length) continue
      const id = `lab-${stem}-${pending.white}-${pending.black}-${pending.num}`
      games.push({
        id,
        white: pending.white,
        black: pending.black,
        result: pending.result,
        winner: pending.winner,
        loser: pending.loser,
        reason: pending.reason,
        moves,
      })
      pending = null
    }
  }
  return { report: basename(file), date, count: games.length, games }
}

async function main() {
  const args = process.argv.slice(2)
  let outDir = resolve(__dirname, '../samples/chess')
  let reports = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--out') outDir = resolve(args[++i])
    else if (a === '--report') reports.push(resolve(args[++i]))
  }
  if (!reports.length) {
    const labRoot = process.env.LAB_REPORTS
      || resolve(__dirname, '../../lab/tournament/reports')
    let files = []
    try { files = (await readdir(labRoot)).filter((f) => f.toLowerCase().endsWith('.md')) } catch (e) {
      console.error('未找到 lab 战报目录：' + labRoot + ' (' + e.message + ')')
      process.exit(1)
    }
    reports = files.map((f) => resolve(labRoot, f))
  }

  await mkdir(outDir, { recursive: true })
  let totalGames = 0
  let totalPly = 0
  for (const r of reports) {
    try {
      const agg = await parseReport(r)
      if (!agg.games.length) { console.log(`[import] ${r} -> 0 局（跳过）`); continue }
      const file = resolve(outDir, agg.report.replace(/\.md$/i, '') + '.json')
      await writeFile(file, JSON.stringify(agg, null, 2) + '\n', 'utf8')
      let ply = 0
      for (const g of agg.games) ply += g.moves.length
      totalGames += agg.games.length
      totalPly += ply
      console.log(`[import] ${agg.report} -> ${agg.games.length} 局 (${ply} 手)`)
    } catch (e) {
      console.error(`[import] 解析 ${r} 失败：${e.message}`)
    }
  }
  if (!totalGames) { console.error('没有解析出任何对局'); process.exit(1) }
  console.log(`[import] 共 ${totalGames} 局 / ${totalPly} 手，写入 ${outDir}`)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
