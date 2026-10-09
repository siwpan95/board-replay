// BoardService —— Cordis 服务，挂到 ctx.board
// 围棋（Go）棋盘复盘内核：SGF 解析 + 落子/提子模型 + 按手数回放状态。
// 零依赖（仅复用 vendored src/core/sgf.mjs）；落子/提子纯 JS 实现，前端与 B4 出图共用同一状态。
import { Service } from 'cordis'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseSgf, sgfToVertex } from '../core/sgf.mjs'

const EMPTY = 0
const BLACK = 1
const WHITE = 2
export const COLS = 'ABCDEFGHJKLMNOPQRST'

function parseSize(root) {
  const raw = root.SZ ? String(root.SZ[0] ?? '19') : '19'
  if (raw.includes(':')) {
    const [a] = raw.split(':').map((t) => parseInt(t, 10))
    return a
  }
  return parseInt(raw, 10)
}

function makeBoard(size) {
  const b = new Array(size)
  for (let y = 0; y < size; y++) b[y] = new Array(size).fill(EMPTY)
  return b
}

// 顶点 "D16" -> 内部坐标 {x,y}（x 列 A→T 跳 I 从左到右；y 行号自下而上，翻转成自上而下）
function vertexToXY(vertex, size) {
  if (!vertex || vertex === 'pass') return null
  const col = COLS.indexOf(vertex[0])
  if (col < 0) return null
  const row = parseInt(vertex.slice(1), 10)
  if (!Number.isFinite(row) || row < 1 || row > size) return null
  const yEngine = row - 1
  const y = size - 1 - yEngine // 翻转：引擎自下而上 -> 内部自上而下
  return { x: col, y }
}

// 洪水填充收集同色连通块 + 气数
function collectGroup(board, size, sx, sy) {
  const color = board[sy][sx]
  const stones = []
  let liberties = 0
  const seen = new Set()
  const stack = [[sx, sy]]
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  while (stack.length) {
    const [x, y] = stack.pop()
    const key = y * size + x
    if (seen.has(key)) continue
    seen.add(key)
    stones.push([x, y])
    for (const [dx, dy] of dirs) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const v = board[ny][nx]
      if (v === EMPTY) liberties++
      else if (v === color) stack.push([nx, ny])
    }
  }
  return { stones, liberties }
}

// 把一步棋落到 board（原地修改）。过手/非法（已占用）跳过；提子自动整组移除。
// 返回是否真正落子（用于单元测试断言）。
function applyMove(board, size, move) {
  if (!move || move.vertex === 'pass' || move.vertex == null) return false
  const xy = vertexToXY(move.vertex, size)
  if (!xy) return false
  const { x, y } = xy
  if (board[y][x] !== EMPTY) return false // 复盘：占用点不覆盖（理论上不该出现）
  const color = move.color === 'B' ? BLACK : WHITE
  const opp = color === BLACK ? WHITE : BLACK
  board[y][x] = color
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [dx, dy] of dirs) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
    if (board[ny][nx] === opp) {
      const grp = collectGroup(board, size, nx, ny)
      if (grp.liberties === 0) {
        for (const [gx, gy] of grp.stones) board[gy][gx] = EMPTY
      }
    }
  }
  return true
}

export class BoardService extends Service {
  static provide = 'board'
  static inject = []

  constructor(ctx, config) {
    super(ctx, 'board')
    this.config = config || {}
    this.sgfDir = config.sgfDir || 'samples'
    this.games = new Map()
  }

  // Service.init：返回清理函数（fiber dispose 时执行）
  [Service.init]() {
    const cleanup = () => { this.games.clear() }
    return this._loadSamples()
      .catch((e) => this.ctx.logger.warn('board: 载入样例失败 %s', e.message))
      .then(() => {
        if (this.games.size) this.ctx.emit('board/loaded', this.list())
        return cleanup
      })
  }

  async _loadSamples() {
    const dir = resolve(process.cwd(), this.sgfDir)
    let files
    try {
      files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.sgf'))
    } catch {
      this.ctx.logger.warn('board: 样例目录不存在 %s', dir)
      return
    }
    for (const f of files) {
      try {
        const id = f.replace(/\.sgf$/i, '')
        const text = await readFile(resolve(dir, f), 'utf8')
        this.loadFromText(id, text)
      } catch (e) {
        this.ctx.logger.warn('board: 解析 %s 失败 %s', f, e.message)
      }
    }
    this.ctx.logger.info('board: 载入 %d 个 SGF 样例', this.games.size)
  }

  // 从 SGF 文本载入一谱（幂等：同 id 覆盖）
  loadFromText(id, text) {
    const tree = parseSgf(text)
    const size = parseSize(tree.root)
    const moves = tree.nodes.map((nd) => ({
      color: nd.color,
      vertex: nd.color ? sgfToVertex(nd.value, size) : null,
    }))
    const game = {
      id,
      size,
      root: tree.root,
      moves,
      result: tree.root.RE ? tree.root.RE[0] : '',
      pb: tree.root.PB ? tree.root.PB[0] : '',
      pw: tree.root.PW ? tree.root.PW[0] : '',
      km: tree.root.KM ? tree.root.KM[0] : '',
      ru: tree.root.RU ? tree.root.RU[0] : '',
    }
    this.games.set(id, game)
    return this.meta(id)
  }

  meta(id) {
    const g = this.games.get(id)
    if (!g) return null
    return {
      id: g.id,
      size: g.size,
      total: g.moves.length,
      result: g.result,
      pb: g.pb,
      pw: g.pw,
      km: g.km,
      ru: g.ru,
    }
  }

  list() {
    return [...this.games.values()].map((g) => this.meta(g.id))
  }

  // 回放状态：前 k 手落完后的棋盘。step=0 空盘；step=total 终局。
  stateAt(id, k) {
    const g = this.games.get(id)
    if (!g) throw new Error('unknown game: ' + id)
    const size = g.size
    const board = makeBoard(size)
    const n = Math.max(0, Math.min(k | 0, g.moves.length))
    let last = null
    for (let i = 0; i < n; i++) {
      const m = g.moves[i]
      applyMove(board, size, m)
      const xy = m.vertex && m.vertex !== 'pass' ? vertexToXY(m.vertex, size) : null
      last = { step: i + 1, color: m.color, vertex: m.vertex, x: xy ? xy.x : null, y: xy ? xy.y : null }
    }
    return { id, size, step: n, total: g.moves.length, board, last }
  }
}

// 导出纯函数供测试 / 未来国际化棋盘复用
export { applyMove, makeBoard, vertexToXY, parseSize }
export default BoardService
