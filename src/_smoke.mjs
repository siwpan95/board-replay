// _smoke.mjs —— 端到端冒烟：board 内核 + SGF 复盘 + 提子逻辑 + chess 复盘（vendored 规则引擎）
// 运行：npm run smoke  （或 node src/_smoke.mjs）
import { bootHost, stopHost } from './boot.mjs'
import { applyMove, makeBoard, vertexToXY } from './plugins/board.mjs'
import { applyUci, parseFen, serializeFen, runPerftSelfTest } from './core/chess_engine.mjs'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log('[smoke] PASS ' + name)
  else { console.log('[smoke] FAIL ' + name + (extra ? ' :: ' + extra : '')); failures++ }
}

async function main() {
  const ctx = await bootHost({ config: 'cordis.json' })

  // 1) 样例加载
  const games = ctx.board.list()
  check('样例加载 >= 1', games.length >= 1, 'got ' + games.length)
  const g0 = games[0]
  console.log('[smoke] 首个谱 meta:', JSON.stringify(g0))

  // 2) 终局棋盘非空
  const fin = ctx.board.stateAt(g0.id, g0.total)
  let stones = 0
  for (const row of fin.board) for (const v of row) if (v) stones++
  check('终局棋盘有子', stones > 0, 'stones=' + stones)
  check('终局步数=手数', fin.step === g0.total, fin.step + ' vs ' + g0.total)

  // 3) 第一手落点坐标正确（9x9：B[de] -> D5 -> 内部(3,4)）
  if (g0.size === 9) {
    const s1 = ctx.board.stateAt(g0.id, 1)
    const xy = vertexToXY('D5', 9)
    check('首手 D5 落在内部(' + xy.x + ',' + xy.y + ')', s1.board[xy.y][xy.x] === 1, 'val=' + s1.board[xy.y][xy.x])
  } else {
    console.log('[smoke] 跳过坐标断言（非 9x9 样例）')
  }

  // 4) 提子逻辑单测：5x5，黑落(2,2)，白四邻包围 -> 黑整组被提
  {
    const size = 5
    const b = makeBoard(size)
    applyMove(b, size, { color: 'B', vertex: 'C3' }) // C3 -> 内部(2,2)
    applyMove(b, size, { color: 'W', vertex: 'B3' })
    applyMove(b, size, { color: 'W', vertex: 'C4' })
    applyMove(b, size, { color: 'W', vertex: 'D3' })
    applyMove(b, size, { color: 'W', vertex: 'C2' })
    check('白包围后黑子被提（(2,2)空）', b[2][2] === 0, 'val=' + b[2][2])
  }

  // 5) 过手不落子（SGF 末两手为 B[]/W[]）
  {
    const size = 9
    const b = makeBoard(size)
    const before = JSON.stringify(b)
    const r = applyMove(b, size, { color: 'B', vertex: 'pass' })
    check('过手返回 false 且不改变棋盘', r === false && JSON.stringify(b) === before)
  }

  // ===== 国际象棋复盘（vendored tournament/engine.mjs） =====
  const chess = ctx.chess
  check('chess 服务已加载', !!chess)
  if (chess) {
    const cgames = chess.list()
    check('chess 样例加载 >= 1', cgames.length >= 1, 'got ' + cgames.length)

    // 6) 复盘保真：stateAt(total) 的 FEN 必须等于独立用 applyUci 重放全部着法的结果
    {
      const g = cgames[0]
      const st = chess.stateAt(g.id, g.total)
      // 独立重放（不依赖 ChessService，纯 vendored 引擎）
      let s = parseFen(START_FEN)
      const rec = chess.games.get(g.id)
      for (const uci of rec.moves) s = applyUci(s, uci)
      check('复盘保真 FEN 一致 (' + g.id + ')', serializeFen(st) === serializeFen(s),
        serializeFen(st) + ' vs ' + serializeFen(s))
    }

    // 7) 将死局：找一局 reason=checkmate，断言终局 type=checkmate 且末手带 '#'
    {
      const cm = cgames.find((g) => g.reason === 'checkmate' && g.result === 'win')
        || cgames.find((g) => /checkmate/i.test(g.reason || ''))
      if (cm) {
        const st = chess.stateAt(cm.id, cm.total)
        check('将死局终局判定为 checkmate (' + cm.id + ')', st.terminal && st.terminal.type === 'checkmate',
          JSON.stringify(st.terminal))
        check('将死局末手标注 # (' + cm.id + ')', st.last && st.last.annotation === '#',
          st.last && st.last.annotation)
      } else {
        console.log('[smoke] 跳过将死断言（样例中无 checkmate 局）')
      }
    }

    // 8) 和棋（threefold）：reason=threefold 的局终局应为 draw/threefold
    {
      const tf = cgames.find((g) => /threefold/i.test(g.reason || ''))
      if (tf) {
        const st = chess.stateAt(tf.id, tf.total)
        check('三轮重复局终局为 draw (' + tf.id + ')', st.terminal && st.terminal.type === 'draw',
          JSON.stringify(st.terminal))
      } else {
        console.log('[smoke] 跳过三轮重复断言（样例中无 threefold 局）')
      }
    }

    // 9) step 边界：step=0 是初始局面，棋盘含 32 子
    {
      const g = cgames[0]
      const s0 = chess.stateAt(g.id, 0)
      let pieces = 0
      for (const row of s0.board) for (const v of row) if (v && v !== '.') pieces++
      check('step=0 初始局面 32 子', pieces === 32, 'pieces=' + pieces)
    }

    // 11) PGN 导出：SAN 正确 + 结果标签 + 头
    {
      const tf = cgames.find((g) => /threefold/i.test(g.reason || ''))
      if (tf) {
        const pgn = chess.pgn(tf.id)
        check('PGN 含 [Event]/[Result] 头', pgn.includes('[Event') && pgn.includes('[Result'), '')
        check('PGN 含 1. 着法编号', pgn.includes('1. '), '')
        // go-rust-1 前两手 b1c3 b8c6 d2d4 g8f6 -> 1. Nc3 Nc6 2. d4
        check('PGN SAN 正确 (1. Nc3 Nc6 2. d4)', pgn.includes('1. Nc3 Nc6 2. d4'), pgn.split('\n').pop().slice(0, 60))
        check('PGN 三轮重复以 1/2-1/2 结束', pgn.trimEnd().endsWith('1/2-1/2'), JSON.stringify(pgn.trimEnd().slice(-14)))
      }
      const cm = cgames.find((g) => g.reason === 'checkmate' && g.result === 'win')
      if (cm) {
        const pgn = chess.pgn(cm.id)
        check('PGN 将死局含 #', pgn.includes('#'), pgn.split('\n').pop().slice(0, 80))
        check('PGN 将死局以 1-0 结束', pgn.trimEnd().endsWith('1-0'), JSON.stringify(pgn.trimEnd().slice(-12)))
      }
    }
  }

  // 10) vendored 国际象棋规则引擎 perft 自检（黄金值，证明规则与 lab runner 一致）
  {
    const r = runPerftSelfTest()
    check('vendored chess engine perft 自检全过', r.fail === 0, r.text)
  }

  await stopHost()
  console.log(failures ? ('\n[smoke] 失败 ' + failures + ' 项') : '\n[smoke] 全部通过 ✅')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('[smoke] FATAL', e); process.exit(1) })
