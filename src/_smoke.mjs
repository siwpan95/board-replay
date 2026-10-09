// _smoke.mjs —— 端到端冒烟：board 内核 + SGF 复盘 + 提子逻辑
// 运行：npm run smoke  （或 node src/_smoke.mjs）
import { bootHost, stopHost } from './boot.mjs'
import { applyMove, makeBoard, vertexToXY } from './plugins/board.mjs'

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

  await stopHost()
  console.log(failures ? ('\n[smoke] 失败 ' + failures + ' 项') : '\n[smoke] 全部通过 ✅')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('[smoke] FATAL', e); process.exit(1) })
