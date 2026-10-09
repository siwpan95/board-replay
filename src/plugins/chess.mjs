// ChessService —— Cordis 服务，挂到 ctx.chess
// 国际象棋（chess）复盘内核：解析 lab 战报导出的 UCI 着法记录，按手数回放。
// 规则引擎复用 vendored src/core/chess_engine.mjs（与 lab 循环赛 runner 同款，
// 保证复盘局面与赛事记录逐子一致）。落子/提子/王车易位/吃过路兵/升变均由该引擎完成。
import { Service } from 'cordis'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  parseFen,
  applyUci,
  serializeFen,
  isCheckmate,
  isCheck,
  isThreefold,
  isStalemate,
  isDraw,
} from '../core/chess_engine.mjs'

// 标准初始局面 FEN（board[r][c]：r=0 为第 8 横线/顶端，c=0 为 a 列）
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// 把带 # / + 等注释的 UCI token 清洗成纯 UCI（含可选升变字母）
function cleanUci(token) {
  const m = token.match(/^[a-h][1-8][a-h][1-8][qrbnQRBN]?/)
  return m ? m[0] : null
}

// 解析清洗后的 UCI -> 引擎内部坐标（row 0 = rank 8）
function parseUci(uci) {
  const fromCol = uci.charCodeAt(0) - 97
  const fromRow = 8 - parseInt(uci[1], 10)
  const toCol = uci.charCodeAt(2) - 97
  const toRow = 8 - parseInt(uci[3], 10)
  const promo = uci.length > 4 ? uci[4].toLowerCase() : null
  return { fromCol, fromRow, toCol, toRow, promo }
}

const FILES = 'abcdefgh'

export class ChessService extends Service {
  static provide = 'chess'
  static inject = []

  constructor(ctx, config) {
    super(ctx, 'chess')
    this.config = config || {}
    this.jsonDir = config.jsonDir || 'samples/chess'
    this.games = new Map()
  }

  // Service.init：返回清理函数
  [Service.init]() {
    const cleanup = () => { this.games.clear() }
    return this._loadSamples()
      .catch((e) => this.ctx.logger.warn('chess: 载入样例失败 %s', e.message))
      .then(() => {
        if (this.games.size) this.ctx.emit('chess/loaded', this.list())
        return cleanup
      })
  }

  async _loadSamples() {
    const dir = resolve(process.cwd(), this.jsonDir)
    let files
    try {
      files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.json'))
    } catch {
      this.ctx.logger.warn('chess: 样例目录不存在 %s', dir)
      return
    }
    for (const f of files) {
      try {
        const text = await readFile(resolve(dir, f), 'utf8')
        const rec = JSON.parse(text)
        if (rec && Array.isArray(rec.games)) {
          // 聚合文件（import_lab_chess.mjs 产出）：每局自带全局唯一 id
          for (const g of rec.games) this.loadFromRecord(g.id, g)
        } else {
          // 单记录文件：用文件名当 id
          const id = f.replace(/\.json$/i, '')
          this.loadFromRecord(id, rec)
        }
      } catch (e) {
        this.ctx.logger.warn('chess: 解析 %s 失败 %s', f, e.message)
      }
    }
    this.ctx.logger.info('chess: 载入 %d 个 UCI 样例', this.games.size)
  }

  // 从记录对象载入一局（幂等：同 id 覆盖）
  loadFromRecord(id, rec) {
    const rawMoves = Array.isArray(rec.moves) ? rec.moves : (rec.uci || '').split(/\s+/)
    const moves = []
    for (const tok of rawMoves) {
      const u = cleanUci(String(tok).trim())
      if (u) moves.push(u)
    }
    const game = {
      id,
      kind: 'chess',
      white: rec.white || rec.w || '',
      black: rec.black || rec.b || '',
      result: rec.result || '',
      reason: rec.reason || '',
      moves,
    }
    this.games.set(id, game)
    return this.meta(id)
  }

  meta(id) {
    const g = this.games.get(id)
    if (!g) return null
    return {
      id: g.id,
      kind: 'chess',
      size: 8,
      total: g.moves.length,
      white: g.white,
      black: g.black,
      result: g.result,
      reason: g.reason,
    }
  }

  list() {
    return [...this.games.values()].map((g) => this.meta(g.id))
  }

  // 回放状态：前 k 手落完后的棋盘。step=0 初始局面；step=total 终局。
  // board 返回 char 矩阵（大写白 / 小写黑 / '.' 空），与引擎坐标一致（r=0 顶端）。
  stateAt(id, k) {
    const g = this.games.get(id)
    if (!g) throw new Error('unknown game: ' + id)
    let state = parseFen(START_FEN)
    const n = Math.max(0, Math.min(k | 0, g.moves.length))
    let last = null
    let fenTrail = [serializeFen(state)]
    for (let i = 0; i < n; i++) {
      const uci = g.moves[i]
      const parsed = parseUci(uci)
      const piece = state.board[parsed.fromRow][parsed.fromCol]
      const color = state.whiteToMove ? 'w' : 'b'
      state = applyUci(state, uci) // 非法会抛错（与 runner 同款）
      // 注释 # / + 由局面复算（与 runner 179-183 一致），不依赖存储的文本
      const annotation = isCheckmate(state) ? '#'
        : (isCheck(state, state.whiteToMove) ? '+' : '')
      last = {
        step: i + 1,
        color,
        piece,
        special: null,
        annotation,
        from: [parsed.fromRow, parsed.fromCol],
        to: [parsed.toRow, parsed.toCol],
      }
      fenTrail.push(serializeFen(state))
    }
    // 终局判定（供前端/出图标注）
    const terminal = this._terminal(state, g)
    return {
      id,
      kind: 'chess',
      size: 8,
      step: n,
      total: g.moves.length,
      board: state.board,
      last,
      whiteToMove: state.whiteToMove,
      castling: state.castling,
      ep: state.ep,
      halfmove: state.halfmove,
      fullmove: state.fullmove,
      terminal,
    }
  }

  // 终局信息：checkmate / stalemate / draw(reason) / null
  _terminal(state, g) {
    if (isCheckmate(state)) {
      const winner = state.whiteToMove ? 'b' : 'w' // 轮到谁被将死，对方胜
      return { type: 'checkmate', winner }
    }
    if (isStalemate(state)) return { type: 'stalemate' }
    if (isThreefold(state)) return { type: 'draw', reason: 'threefold' }
    if (isDraw(state)) return { type: 'draw', reason: 'draw' }
    return null
  }
}

// 导出辅助供测试 / 适配器复用
export { START_FEN, cleanUci, parseUci, FILES, applyUci, serializeFen }
export default ChessService
