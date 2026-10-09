// tools/verify_lab_report.mjs —— board-replay 作为 lab 跨语言国际象棋循环赛的「独立复盘验证环节」。
//
// 定位：赛事 runner（lab/tournament/run_tournament.mjs）自己产出的战报是「自证」，
// 本脚本用 board-replay 里 vendored 的规则引擎（与 lab runner 同款逐字副本）**离岸重放**每一局，
// 做一次独立交叉验证：
//
//   1) perft 黄金值自检 —— 证明本侧规则实现与官方基准（也就与 lab runner）一致；
//   2) 逐手合法性 —— 战报里每一手 UCI 都能被规则引擎接受，否则说明战报/引擎有偏差；
//   3) 终局一致 —— 重放到最后一手算出的终局（checkmate / stalemate / threefold / 其它和棋）
//      必须与战报声明的 reason 吻合，将死局还要核对胜方颜色；
//   4) 服务态一致 —— 启动 board-replay 的 Cordis host（端口 0 由系统分配，不占用常驻 5173），
//      核对 REST /api/games 列表与 /api/games/:id/state?step=total 的棋盘、终局
//      与离线重放逐子一致（即 Web UI 里看到的局面 = 赛事真实局面）。
//
// 用法：
//   node tools/verify_lab_report.mjs                       # 验证当天 lab 战报
//   node tools/verify_lab_report.mjs --report <path.md>    # 指定战报
//   node tools/verify_lab_report.mjs --json <file.json>    # 跳过导入，直接验证已导入的 UCI 记录
//   node tools/verify_lab_report.mjs --md reports/verify-YYYY-MM-DD.md   # 另写 Markdown 验证报告
//   node tools/verify_lab_report.mjs --no-serve            # 跳过第 4 步服务态校验
//
// 退出码：0 = 全部通过；1 = 存在 FAIL；2 = 无法运行（战报缺失 / 导入失败 / 零对局）。
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseFen,
  applyUci,
  serializeFen,
  isCheckmate,
  isStalemate,
  isThreefold,
  isDraw,
  runPerftSelfTest,
} from '../src/core/chess_engine.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = { report: null, json: null, md: null, serve: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--report') out.report = resolve(argv[++i])
    else if (a === '--json') out.json = resolve(argv[++i])
    else if (a === '--md') out.md = resolve(argv[++i])
    else if (a === '--no-serve') out.serve = false
  }
  return out
}

function localDateISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 战报声明 reason -> 期望的回放终局（与 ChessService._terminal 同口径）
function terminalOf(state) {
  if (isCheckmate(state)) return { type: 'checkmate', winner: state.whiteToMove ? 'b' : 'w' }
  if (isStalemate(state)) return { type: 'stalemate' }
  if (isThreefold(state)) return { type: 'draw', reason: 'threefold' }
  if (isDraw(state)) return { type: 'draw', reason: 'draw' }
  return null
}

function expectation(reason, g) {
  const r = String(reason || '')
  if (r === 'checkmate') {
    const wc = g.winner === g.white ? 'w' : (g.winner === g.black ? 'b' : null)
    return { kind: 'checkmate', winnerColor: wc, strict: true }
  }
  if (r === 'stalemate') return { kind: 'stalemate', strict: true }
  if (r === 'threefold') return { kind: 'draw', reason: 'threefold', strict: true }
  if (/fifty|insufficient/i.test(r)) return { kind: 'draw', strict: true }
  // max-ply 裁定和 / crash / 超时 / 不战而胜：回放终局不作强制要求（着法合法性仍然校验），
  // 但若回放实际是决定性终局（将死/逼和）则记一条「软告警」——
  // 典型如 runner 打到 MAX_PLY 最后一手正好将死却仍裁定为和（lab runner 的判负边界缺口）。
  return { kind: 'any', strict: false, soft: true }
}

function compareTerminal(exp, term) {
  const t = term ? term.type : 'none'
  if (!exp.strict) {
    if (exp.soft && (t === 'checkmate' || t === 'stalemate')) {
      return {
        ok: true,
        warn: true,
        detail: `软告警：战报按裁定/异常收尾，但棋盘实际是 ${t}${term.winner ? '（胜方 ' + term.winner + '）' : ''}`,
      }
    }
    return { ok: true, detail: '宽松（声明为裁定/异常局，不强制终局）' }
  }
  if (exp.kind === 'checkmate') {
    if (t !== 'checkmate') return { ok: false, detail: `期望 checkmate，实际 ${t}` }
    if (exp.winnerColor && term.winner !== exp.winnerColor) {
      return { ok: false, detail: `期望胜方 ${exp.winnerColor}，实际 ${term.winner}` }
    }
    return { ok: true, detail: 'checkmate 一致' }
  }
  if (exp.kind === 'stalemate') return { ok: t === 'stalemate', detail: `期望 stalemate，实际 ${t}` }
  if (exp.kind === 'draw') {
    if (t !== 'draw') return { ok: false, detail: `期望 draw，实际 ${t}` }
    if (exp.reason && term.reason !== exp.reason) {
      return { ok: false, detail: `期望 draw/${exp.reason}，实际 draw/${term.reason}` }
    }
    return { ok: true, detail: 'draw 一致' }
  }
  return { ok: true, detail: '无约束' }
}

function boardKey(board) {
  return board.map((row) => row.join('')).join('/')
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const today = localDateISO()
  const labReports = process.env.LAB_REPORTS || resolve(ROOT, '../lab/tournament/reports')
  const reportPath = args.report || resolve(labReports, `${today}.md`)

  console.log('=== board-replay 复盘验证 ===')
  console.log(`[verify] 战报：${reportPath}`)

  // 0) 规则引擎 perft 黄金值自检（证明本侧规则 == lab runner 规则）
  const perft = runPerftSelfTest()
  console.log(perft.text)
  const perftOk = perft.fail === 0
  console.log(`[verify] perft 自检：${perft.pass} passed, ${perft.fail} failed -> ${perftOk ? 'PASS' : 'FAIL'}`)

  // 1) 导入战报 -> UCI JSON（复用 tools/import_lab_chess.mjs，不重复实现解析）
  let jsonPath = args.json
  if (!jsonPath) {
    try { await stat(reportPath) } catch {
      console.error(`[verify] 战报不存在：${reportPath}`)
      process.exit(2)
    }
    const imp = spawnSync(
      process.execPath,
      [resolve(__dirname, 'import_lab_chess.mjs'), '--report', reportPath],
      { cwd: ROOT, encoding: 'utf8' },
    )
    const out = (imp.stdout || '') + (imp.stderr || '')
    process.stdout.write(out)
    if (imp.status !== 0) {
      console.error(`[verify] 导入战报失败（exit=${imp.status}）`)
      process.exit(2)
    }
    jsonPath = resolve(ROOT, 'samples/chess', basename(reportPath).replace(/\.md$/i, '') + '.json')
  }
  console.log(`[verify] UCI 记录：${jsonPath}`)

  const agg = JSON.parse(await readFile(jsonPath, 'utf8'))
  const games = agg.games || []
  if (!games.length) { console.error('[verify] 战报中零对局，无法验证'); process.exit(2) }

  // 2) 离线逐手重放
  const rows = []
  const warnings = []
  let illegalTotal = 0
  let terminalMismatch = 0
  let plyTotal = 0
  const termDist = {}
  const reasonDist = {}
  for (const g of games) {
    const rec = {
      id: g.id, white: g.white, black: g.black,
      declared: `${g.result}${g.reason ? '/' + g.reason : ''}`,
      plies: (g.moves || []).length,
      illegal: null, replay: 'none', ok: true, detail: '',
    }
    reasonDist[rec.declared] = (reasonDist[rec.declared] || 0) + 1
    if (!rec.plies) {
      // 不战而胜 / 崩溃弃权：无着法可重放
      rec.replay = 'n/a'
      rec.detail = '无着法（不战而胜/弃权），仅核对声明'
      if (/checkmate|stalemate|threefold/.test(String(g.reason || ''))) {
        rec.ok = false
        rec.detail = '声明了终局原因但着法为空 —— 战报异常'
        terminalMismatch++
      }
      rows.push(rec)
      continue
    }
    let state = parseFen(START_FEN)
    let illegal = null
    for (let i = 0; i < g.moves.length; i++) {
      try { state = applyUci(state, g.moves[i]) } catch (e) {
        illegal = { ply: i + 1, uci: g.moves[i], msg: e.message }
        break
      }
    }
    plyTotal += rec.plies
    if (illegal) {
      illegalTotal++
      rec.illegal = illegal
      rec.ok = false
      rec.detail = `第 ${illegal.ply} 手非法：${illegal.uci}（${illegal.msg.slice(0, 90)}）`
      rows.push(rec)
      continue
    }
    const term = terminalOf(state)
    rec.replay = term ? (term.type === 'draw' ? `draw/${term.reason}` : term.type + (term.winner ? ':' + term.winner : '')) : 'none'
    termDist[rec.replay] = (termDist[rec.replay] || 0) + 1
    const cmp = compareTerminal(expectation(g.reason, g), term)
    rec.ok = cmp.ok
    rec.detail = cmp.detail
    if (cmp.warn) warnings.push({ id: g.id, declared: rec.declared, replay: rec.replay, detail: cmp.detail })
    if (!cmp.ok) terminalMismatch++
    rows.push(rec)
  }

  // 3) 服务态校验（启动 Cordis host，端口 0 系统分配）
  let serveResult = { skipped: !args.serve, ok: null, url: null, checked: 0, mismatches: [], error: null }
  if (args.serve) {
    try {
      process.env.BOARD_PORT = '0'
      const { bootHost, stopHost } = await import('../src/boot.mjs')
      const ctx = await bootHost({ config: 'cordis.json' })
      const url = ctx.http && ctx.http.url
      serveResult.url = url
      if (!url) throw new Error('http 服务未启动')
      const listRes = await fetch(`${url}api/games`)
      const listJson = await listRes.json()
      const served = new Set((listJson.games || []).map((g) => g.id))
      const missing = rows.filter((r) => !served.has(r.id)).map((r) => r.id)
      if (missing.length) {
        serveResult.mismatches.push(`/api/games 缺少 ${missing.length} 个目标局（首例 ${missing[0]}）`)
      }
      // 逐局比对终局棋盘 + terminal（step=total）
      const byId = new Map(games.map((g) => [g.id, g]))
      for (const r of rows) {
        if (!r.plies) continue
        const g = byId.get(r.id)
        let state = parseFen(START_FEN)
        for (const u of g.moves) state = applyUci(state, u)
        const wantBoard = boardKey(state.board)
        const wantTerm = terminalOf(state)
        const stRes = await fetch(`${url}api/games/${encodeURIComponent(r.id)}/state?step=${g.moves.length}`)
        if (!stRes.ok) {
          serveResult.mismatches.push(`${r.id}: /state HTTP ${stRes.status}`)
          continue
        }
        const st = await stRes.json()
        serveResult.checked++
        const gotBoard = boardKey(st.board || [])
        if (gotBoard !== wantBoard) {
          serveResult.mismatches.push(`${r.id}: 终局棋盘不一致`)
        } else if (JSON.stringify(st.terminal || null) !== JSON.stringify(wantTerm)) {
          serveResult.mismatches.push(`${r.id}: 终局判定不一致（离线 ${JSON.stringify(wantTerm)} vs 服务 ${JSON.stringify(st.terminal || null)}）`)
        }
      }
      serveResult.ok = serveResult.mismatches.length === 0
      await stopHost()
    } catch (e) {
      serveResult.ok = false
      serveResult.error = e.message
    }
  }

  // 4) 汇总
  const replayable = rows.filter((r) => r.plies > 0)
  const bad = rows.filter((r) => !r.ok)
  const total = rows.length
  const okRate = total ? ((100 * (total - bad.length)) / total).toFixed(1) : '0.0'
  console.log('\n=== 汇总 ===')
  console.log(`对局总数：${total}（可重放 ${replayable.length}，无着法 ${total - replayable.length}）`)
  console.log(`总手数：${plyTotal}，平均 ${replayable.length ? (plyTotal / replayable.length).toFixed(1) : '0'} 手/局`)
  console.log(`非法着法局数：${illegalTotal}`)
  console.log(`终局不一致局数：${terminalMismatch}`)
  console.log(`回放一致率：${okRate}% (${total - bad.length}/${total})`)
  console.log('回放终局分布：')
  for (const [k, v] of Object.entries(termDist)) console.log(`  ${k}: ${v}`)
  console.log('战报声明分布：')
  for (const [k, v] of Object.entries(reasonDist)) console.log(`  ${k}: ${v}`)
  console.log(`软告警（裁定/异常局但回放为决定性终局）：${warnings.length}`)
  for (const w of warnings.slice(0, 10)) console.log(`  WARN ${w.id}｜声明 ${w.declared}｜回放 ${w.replay}`)
  if (serveResult.skipped) console.log('服务态校验：已跳过（--no-serve）')
  else if (serveResult.error) console.log(`服务态校验：FAIL（${serveResult.error}）`)
  else console.log(`服务态校验：${serveResult.ok ? 'PASS' : 'FAIL'}（${serveResult.url}，核对 ${serveResult.checked} 局，不一致 ${serveResult.mismatches.length}）`)

  const gateFail = (!perftOk ? 1 : 0) + bad.length + (serveResult.ok === false ? 1 : 0)
  console.log(gateFail ? `\n[verify] 结论：FAIL（${gateFail} 项未通过）` : '\n[verify] 结论：PASS ✅')

  // 5) Markdown 报告（可选）
  if (args.md) {
    const lines = []
    lines.push(`# board-replay 复盘验证 — ${agg.date || today}`)
    lines.push('')
    lines.push(`- 战报：\`${reportPath}\``)
    lines.push(`- UCI 记录：\`${jsonPath}\``)
    lines.push(`- 规则引擎 perft 自检：${perft.pass} passed, ${perft.fail} failed → ${perftOk ? 'PASS' : 'FAIL'}`)
    lines.push(`- 对局总数：${total}（可重放 ${replayable.length}）｜ 总手数 ${plyTotal}`)
    lines.push(`- 非法着法局数：**${illegalTotal}** ｜ 终局不一致局数：**${terminalMismatch}** ｜ 回放一致率 **${okRate}%** ｜ 软告警 **${warnings.length}**`)
    if (!serveResult.skipped) {
      lines.push(`- 服务态校验：${serveResult.error ? 'FAIL（' + serveResult.error + '）' : (serveResult.ok ? 'PASS' : 'FAIL')}（${serveResult.url || '-'}，核对 ${serveResult.checked} 局）`)
    }
    lines.push('')
    lines.push('## 终局分布（交叉核对）')
    lines.push('')
    lines.push('| 回放终局 | 局数 |')
    lines.push('| --- | --- |')
    for (const [k, v] of Object.entries(termDist)) lines.push(`| ${k} | ${v} |`)
    lines.push('')
    lines.push('| 战报声明 | 局数 |')
    lines.push('| --- | --- |')
    for (const [k, v] of Object.entries(reasonDist)) lines.push(`| ${k} | ${v} |`)
    lines.push('')
    if (warnings.length) {
      lines.push('## 软告警（不计 FAIL）')
      lines.push('')
      lines.push('| 对局 | 声明 | 回放 | 说明 |')
      lines.push('| --- | --- | --- | --- |')
      for (const w of warnings.slice(0, 50)) lines.push(`| ${w.id} | ${w.declared} | ${w.replay} | ${w.detail} |`)
      if (warnings.length > 50) lines.push(`| … | 另 ${warnings.length - 50} 局省略 | | |`)
      lines.push('')
    }
    if (bad.length) {
      lines.push('## 不一致 / 异常清单')
      lines.push('')
      lines.push('| 对局 | 声明 | 回放 | 说明 |')
      lines.push('| --- | --- | --- | --- |')
      for (const r of bad.slice(0, 50)) {
        lines.push(`| ${r.id} | ${r.declared} | ${r.replay} | ${r.detail} |`)
      }
      if (bad.length > 50) lines.push(`| … | 另 ${bad.length - 50} 局省略 | | |`)
      lines.push('')
    } else {
      lines.push('## 不一致 / 异常清单')
      lines.push('')
      lines.push('无：全部对局逐手合法，且回放终局与战报声明一致。')
      lines.push('')
    }
    if (serveResult.mismatches && serveResult.mismatches.length) {
      lines.push('## 服务态不一致')
      lines.push('')
      for (const m of serveResult.mismatches.slice(0, 30)) lines.push(`- ${m}`)
      lines.push('')
    }
    lines.push(`> 结论：${gateFail ? 'FAIL' : 'PASS'}${warnings.length ? `（含 ${warnings.length} 条软告警）` : ''} —— board-replay 独立复盘与 lab 赛事记录一致`)
    lines.push('')
    await mkdir(dirname(args.md), { recursive: true })
    await writeFile(args.md, lines.join('\n'), 'utf8')
    console.log(`[verify] Markdown 报告：${args.md}`)
  }

  process.exit(gateFail ? 1 : 0)
}

main().catch((e) => { console.error('[verify] FATAL', e); process.exit(2) })
