// tools/verify_go_sgf_referee.mjs —— 围棋棋谱的「离岸交叉验证」门禁
//
// 定位：board-replay 的围棋复盘内核（src/plugins/board.mjs）与 weiqi_lab 赛事裁判
// （weiqi_lab/tournament/referee.mjs）是**两套独立实现**的规则引擎。
// 本脚本用赛事裁判复演 samples/*.sgf，要求裁判算出的终局结果与 SGF 里记录的
// RE 字段完全一致 —— 任一局对不上即退出码 1。
//
// 这道门禁的意义：出图/视频建立在「复盘内核逐子正确」的前提上，
// 若复盘内核与赛事裁判对同一份棋谱给出不同结论，则所有下游产物都不可信。
//
// 依赖：weiqi_lab 仓库需与 board-replay 同级（../weiqi_lab）
// 用法：
//   node tools/verify_go_sgf_referee.mjs            # 验证 samples/ 下全部 SGF
//   node tools/verify_go_sgf_referee.mjs <sgf目录>  # 指定目录
//
// 退出码：0 = 全部一致；1 = 存在不一致；2 = 依赖缺失。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSgf, sgfToVertex } from '../src/core/sgf.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const REFEREE = resolve(ROOT, '..', 'weiqi_lab', 'tournament', 'referee.mjs')
if (!existsSync(REFEREE)) {
  console.error('缺少赛事裁判模块: %s', REFEREE)
  console.error('需要 weiqi_lab 仓库与 board-replay 同级放置')
  process.exit(2)
}
const { Ref, parseVertex } = await import(pathToFileURL(REFEREE).href)

const sgfDir = resolve(process.argv[2] || 'samples')
const files = readdirSync(sgfDir).filter((f) => f.toLowerCase().endsWith('.sgf'))
let pass = 0, fail = 0

console.log('file'.padEnd(30), 'RE(SGF)'.padEnd(10), '裁判复演'.padEnd(10), '一致')
for (const f of files) {
  const text = readFileSync(resolve(sgfDir, f), 'utf8')
  const tree = parseSgf(text)
  const size = parseInt(String(tree.root.SZ ? tree.root.SZ[0] : '19'), 10)
  const km = tree.root.KM ? parseFloat(tree.root.KM[0]) : 7.5
  const ru = tree.root.RU ? String(tree.root.RU[0]) : 'cn'
  // SGF 的 RU 是全称（Chinese/Japanese/Tromp-Taylor），裁判用 profile 短名（cn/jp/tt）
  const ruLower = ru.toLowerCase()
  const profile = ruLower.startsWith('chi') ? 'cn'
    : ruLower.startsWith('jap') ? 'jp'
    : ruLower.includes('tromp') ? 'tt'
    : 'cn'
  const re = tree.root.RE ? tree.root.RE[0] : ''

  const ref = new Ref(size, km, profile)
  const moves = tree.nodes.filter((n) => n.color === 'B' || n.color === 'W')
  let r
  let stop = null
  for (let i = 0; i < moves.length; i++) {
    const v = sgfToVertex(moves[i].value, size)
    // 裁判的 play() 收「格子索引」，parseVertex 内部行号自上而下；顶点串 D16 语义为自下而上，
    // 故此处用 parseVertex 统一换算（与裁判自身 replay() 的用法一致）
    const idx = v === 'pass' ? -1 : parseVertex(v, size)
    r = ref.play(moves[i].color === 'B' ? 1 : 2, idx)
    if (!r.ok) { stop = `#${i + 1} ${moves[i].color}${v} -> ${r.reason}`; break }
  }
  const sc = ref.score()
  const judge = sc.result
  const ok = judge === re && !stop
  if (ok) pass++; else fail++
  console.log(
    f.padEnd(30),
    (re || '-').padEnd(10),
    (judge || '-').padEnd(10),
    ok ? '✓' : `✗ (B${sc.black}/W${sc.white} komi=${sc.komi} dame=${sc.dame}${stop ? ' stop=' + stop : ''})`
  )
}
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)