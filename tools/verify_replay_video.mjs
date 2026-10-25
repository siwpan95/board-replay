// tools/verify_replay_video.mjs —— 定格视频的像素级端到端验证门禁
//
// 定位：tools/replay_video.mjs 产出的视频帧，必须忠实呈现原棋谱。
// 本脚本用**另一套独立实现**（weiqi_lab 赛事裁判）复演 SGF，再重建每一帧的叠加层
// （标题 / 字幕 / 最后一手红圈 / 提子数），用同一渲染器渲染后与视频帧逐帧全图 SHA-256 比对。
//
// 四道关卡（任一不过即退出码 1）：
//   1) 两套内核逐手局面全等       —— 复盘内核与赛事裁判对每一手给出同一棋盘
//   2) 两套内核逐手提子数全等     —— 提子计数口径一致
//   3) 裁判终局 == SGF RE         —— 终局结果自洽
//   4) 全部帧全图 SHA-256 一致    —— 视频画面 == 裁判复演局面
//
// 依赖：本仓 vendored 裁判 src/vendor/weiqi_lab/tournament/referee.mjs（MIT，随仓分发）；
//       Python + Pillow
// 用法：
//   node tools/verify_replay_video.mjs <sgf文件> <帧目录> [格子像素]
//   BOARD_PYTHON=E:/Python314/python.exe node tools/verify_replay_video.mjs \
//       samples/2026-10-09-g01-pyvsjs.sgf output/video/2026-10-09-g01-pyvsjs/frames 48
//
// 退出码：0 = 全部一致；1 = 存在不一致；2 = 依赖缺失。
import { readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseSgf, sgfToVertex } from '../src/core/sgf.mjs'
import { applyMove, makeBoard, vertexToXY } from '../src/plugins/board.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const REFEREE = resolve(ROOT, 'src', 'vendor', 'weiqi_lab', 'tournament', 'referee.mjs')
if (!existsSync(REFEREE)) {
  console.error('缺少裁判模块: %s', REFEREE)
  process.exit(2)
}
const { Ref, parseVertex } = await import(pathToFileURL(REFEREE).href)

const sgfPath = resolve(process.argv[2] || 'samples/2026-10-09-g01-pyvsjs.sgf')
const framesDir = resolve(process.argv[3] || 'output/video/2026-10-09-g01-pyvsjs/frames')
const PX = Number(process.argv[4] || 48)

const text = readFileSync(sgfPath, 'utf8')
const tree = parseSgf(text)
const size = parseInt(String(tree.root.SZ ? tree.root.SZ[0] : '19'), 10)
const km = tree.root.KM ? parseFloat(tree.root.KM[0]) : 7.5
const re = tree.root.RE ? tree.root.RE[0] : ''
const pb = tree.root.PB ? tree.root.PB[0] : ''
const pw = tree.root.PW ? tree.root.PW[0] : ''
const moves = tree.nodes.filter((n) => n.color === 'B' || n.color === 'W')

// ---- 1) 裁判复演：逐手局面 + 提子数 ----
// 坐标方向：裁判 cells 是「行优先、row=1 在底行」，board.mjs 内部是「y=0 在顶行」，
// 故统一翻转为自上而下。
const ref = new Ref(size, km, 'cn')
const toTopDown = (cells) => {
  const out = []
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y
    for (let x = 0; x < size; x++) out.push(cells[srcRow * size + x])
  }
  return out
}
const refStates = [new Array(size * size).fill(0)]
const refCapturedPerMove = [0] // 每手提子数（与裁判 captures 累计差一致）
let prevCapB = 0, prevCapW = 0
for (const m of moves) {
  const v = sgfToVertex(m.value, size)
  const idx = v === 'pass' ? -1 : parseVertex(v, size)
  const r = ref.play(m.color === 'B' ? 1 : 2, idx)
  if (!r.ok) {
    console.error('裁判复演失败:', r.reason)
    process.exit(1)
  }
  refStates.push(toTopDown(ref.cells))
  const cB = ref.captures[1], cW = ref.captures[2]
  refCapturedPerMove.push((cB - prevCapB) + (cW - prevCapW))
  prevCapB = cB; prevCapW = cW
}

// ---- 2) board-replay 内核复演：局面 + 提子数 ----
const brStates = []
const brCaptured = []
{
  const b = makeBoard(size)
  brStates.push(b.map((r) => r.slice()))
  brCaptured.push(0)
  let prevStones = 0
  for (const m of moves) {
    const v = sgfToVertex(m.value, size)
    applyMove(b, size, { color: m.color, vertex: v })
    brStates.push(b.map((r) => r.slice()))
    const stones = b.flat().filter((x) => x !== 0).length
    const placed = v !== 'pass' ? 1 : 0
    brCaptured.push(Math.max(0, prevStones + placed - stones))
    prevStones = stones
  }
}

// ---- 3) 两套内核逐手比对（局面 + 提子数）----
let mismatch = 0
for (let s = 0; s <= moves.length; s++) {
  const a = refStates[s].join('')
  const b = brStates[s].flat().join('')
  if (a !== b) {
    mismatch++
    console.error(`✗ 第 ${s} 手局面不一致\n  裁判: ${a}\n  本侧: ${b}`)
    if (mismatch > 3) break
  }
  if (refCapturedPerMove[s] !== brCaptured[s]) {
    mismatch++
    console.error(`✗ 第 ${s} 手提子数不一致：裁判 ${refCapturedPerMove[s]} vs 本侧 ${brCaptured[s]}`)
  }
}
if (mismatch) {
  console.error(`\n局面比对失败：${mismatch} 处不一致`)
  process.exit(1)
}
console.log(`✓ 两套独立内核逐手局面与提子数全等（${moves.length + 1} 个局面）`)

// ---- 4) 裁判终局结果 vs SGF RE ----
const sc = ref.score()
if (sc.result !== re) {
  console.error(`✗ 裁判终局 ${sc.result} != SGF RE ${re}`)
  process.exit(1)
}
console.log(`✓ 裁判终局 ${sc.result}（B${sc.black}/W${sc.white} 贴目${sc.komi}）== SGF RE`)

// ---- 5) 用裁判局面 + 重建叠加层渲染，与视频帧逐像素比对 ----
const py = process.env.BOARD_PYTHON || 'E:/Python314/python.exe'
const frames = readdirSync(framesDir).filter((f) => f.endsWith('.png')).sort()
if (frames.length !== moves.length + 1) {
  console.error(`✗ 帧数不符：目录 ${frames.length} != 期望 ${moves.length + 1}`)
  process.exit(1)
}
console.log(`视频帧数：${frames.length}（= ${moves.length} 手 + 1 开局空盘）`)

const titleText = `${pb}（黑） vs ${pw}（白） · ${size}×${size} · 贴目 ${km || '-'} · 结果 ${re || '?'}`
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// JS 值 -> Python 字面量（JSON 的 true/false/null 在 Python 里不合法）
function pyRepr(v) {
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (v === null || v === undefined) return 'None'
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']'
  if (typeof v === 'object') {
    return '{' + Object.entries(v).map(([k, val]) => `${JSON.stringify(k)}: ${pyRepr(val)}`).join(', ') + '}'
  }
  if (typeof v === 'number') return String(v)
  return JSON.stringify(v)
}

let bad = 0
const tmpFiles = []

for (let s = 0; s < frames.length; s++) {
  const board = []
  for (let y = 0; y < size; y++) board.push(refStates[s].slice(y * size, (y + 1) * size))

  // 独立重建这一帧的叠加层
  let caption, highlight = null
  if (s === 0) {
    caption = `开局 · 0 / ${moves.length}`
  } else {
    const m = moves[s - 1]
    const v = sgfToVertex(m.value, size)
    const c = m.color === 'B' ? '黑' : '白'
    const mv = v !== 'pass' ? v : '过手'
    const cap = refCapturedPerMove[s] > 0 ? ` · 提 ${refCapturedPerMove[s]} 子` : ''
    caption = `第 ${s} / ${moves.length} 手 · ${c} ${mv}${cap}`
    if (v !== 'pass') {
      const xy = vertexToXY(v, size)
      if (xy) highlight = [xy.x, xy.y]
    }
  }

  const tmp = resolve(framesDir, `_verify_tmp_${s}.png`)
  tmpFiles.push(tmp)
  const params = { size, board, out: tmp, kind: 'go', px: PX, coords: true, title: titleText, caption }
  if (highlight) params.highlight = highlight
  // 用 repr() 输出 Python 字面量（JSON 的 true/false/null 不是 Python 语法）
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(resolve(process.cwd(), 'python'))})
import rpc_server as R
R._render_board_png(${pyRepr(params)})
`
  const r = spawnSync(py, ['-c', script], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error('渲染失败:', r.stderr)
    process.exit(1)
  }
  const refSha = sha(readFileSync(tmp))
  const vidSha = sha(readFileSync(resolve(framesDir, frames[s])))
  if (refSha !== vidSha) {
    bad++
    if (bad <= 3) console.error(`✗ 第 ${s} 帧像素不一致`)
  }
}
for (const f of tmpFiles) { try { unlinkSync(f) } catch { /* ignore */ } }
console.log(bad === 0
  ? `✓ 全部 ${frames.length} 帧全图 SHA-256 一致（裁判复演 == 视频帧）`
  : `✗ ${bad} 帧像素不一致`)
process.exit(bad === 0 ? 0 : 1)
