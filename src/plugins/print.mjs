// PrintService —— 出图服务，挂到 ctx.print（仅 cordis.print.json 启用）
// 经 JsonRpcBridge 调 Python（Pillow）渲染棋盘 PNG。桥引用缓存在 boot.stopHost 兜底清理。
import { Service } from 'cordis'
import { resolve } from 'node:path'
import { JsonRpcBridge } from '../core/bridge.mjs'

export class PrintService extends Service {
  static provide = 'print'
  static inject = ['board']

  constructor(ctx, config) {
    super(ctx, 'print')
    this.config = config || {}
    // Python 解释器发现优先级：config.pythonBin > 环境变量 BOARD_PYTHON > 默认 python
    const pythonBin = this.config.pythonBin || process.env.BOARD_PYTHON || 'python'
    this.script = resolve(process.cwd(), this.config.script || 'python/rpc_server.py')
    this.bridge = new JsonRpcBridge(pythonBin, this.script)
    this.pid = null
  }

  [Service.init]() {
    const bridge = this.bridge
    const ready = bridge.start()
    ready.then((pid) => { this.pid = pid }).catch(() => {})
    bridge.onExit = (code) => this.ctx?.logger?.debug?.('print: python worker exited (code ' + code + ')')
    return () => { bridge.stop() }
  }

  ping() {
    return this.bridge.call('ping', {})
  }

  // 惰性取 chess 服务（未配置时为 null）
  _chess() {
    try { return this.ctx.get('chess') } catch { return null }
  }

  // 按 id / kind 解析出负责该谱的服务（围棋 board，国际象棋 chess）
  _resolveService(id, kind) {
    const chess = this._chess()
    if (kind === 'chess') return chess || this.ctx.board
    if (kind === 'go') return this.ctx.board
    if (this.ctx.board.meta(id)) return this.ctx.board
    if (chess && chess.meta(id)) return chess
    return this.ctx.board
  }

  // 渲染某谱第 step 手（省略 step -> 终局）的棋盘 PNG。
  // out 省略 -> output/<id>-<step>.png；kind 省略则按 id 自动判定。
  // extra 可透传渲染增强参数（coords / highlight / caption / title / px / font），仅围棋生效。
  async renderGame(id, step, out, kind, extra) {
    const svc = this._resolveService(id, kind)
    const st = svc.stateAt(id, step == null ? 999999 : step)
    const file = out || resolve(process.cwd(), 'output', `${st.id}-${st.step}.png`)
    const res = await this.bridge.call('render_board_png', {
      size: st.size,
      board: st.board,
      out: file,
      kind: st.kind || 'go',
      ...(extra || {}),
    })
    return { ...res, file, id: st.id, step: st.step, kind: st.kind || 'go' }
  }

  // 直接渲染给定棋盘矩阵（kind 区分围棋 / 国际象棋）
  async renderBoard(board, size, out, kind) {
    const file = out || resolve(process.cwd(), 'output', 'board.png')
    const res = await this.bridge.call('render_board_png', { size, board, out: file, kind: kind || 'go' })
    return { ...res, file }
  }

  // 逐手出图：把一谱从空盘到终局每一手各渲染一张 PNG（定格视频的帧序列）。
  //
  // opts:
  //   outDir    帧输出目录（默认 output/frames/<id>）
  //   px        格子像素（默认 44）
  //   coords    是否画坐标标注（默认 true）
  //   highlight 是否红圈标记最后一手（默认 true）
  //   title/caption  传字符串则直接用作图上标题/字幕；传函数则按 (st, info) 生成
  //   from/to   帧范围（默认 0..total）
  //   prefix    文件名前缀（默认 <id>）
  //
  // 返回 { id, kind, size, total, dir, frames: [{step, file, ...}], captures: {B, W} }
  async renderSequence(id, kind, opts = {}) {
    const svc = this._resolveService(id, kind)
    const meta = svc.meta(id)
    if (!meta) throw new Error('unknown game: ' + id)
    const k = meta.kind || 'go'
    const total = meta.total
    const from = Math.max(0, opts.from ?? 0)
    const to = Math.min(total, opts.to ?? total)
    const dir = resolve(opts.outDir || resolve(process.cwd(), 'output', 'frames', id))
    const prefix = opts.prefix || id
    const px = opts.px || 44

    // 提子统计：逐手比对前后盘面的棋子数差
    const captures = { B: 0, W: 0 }
    const countStones = (board) => {
      let n = 0
      for (const row of board) for (const v of row) if (v) n++
      return n
    }

    const frames = []
    let prevStones = 0
    for (let step = from; step <= to; step++) {
      const st = svc.stateAt(id, step)
      const stones = countStones(st.board)
      // step>0 时：落子 +1，若棋子数净减少则差值即提子数
      let captured = 0
      if (step > from) {
        const placed = st.last && st.last.vertex && st.last.vertex !== 'pass' ? 1 : 0
        captured = Math.max(0, prevStones + placed - stones)
        if (captured > 0 && st.last) captures[st.last.color] = (captures[st.last.color] || 0) + captured
      }
      prevStones = stones

      const last = st.last
      const colorText = last ? (last.color === 'B' ? '黑' : '白') : ''
      const moveText = last
        ? (last.vertex && last.vertex !== 'pass' ? last.vertex : '过手')
        : '开局'

      const info = { step, total, last, captured, captures: { ...captures }, colorText, moveText }
      const caption = typeof opts.caption === 'function' ? opts.caption(st, info) : opts.caption
      const title = typeof opts.title === 'function' ? opts.title(st, info) : opts.title

      const file = resolve(dir, `${prefix}-${String(step).padStart(4, '0')}.png`)
      const extra = {
        px,
        ...(opts.coords === false ? {} : { coords: true }),
        ...(opts.highlight === false ? {} : (last && last.x != null ? { highlight: [last.x, last.y] } : {})),
        ...(caption ? { caption } : {}),
        ...(title ? { title } : {}),
        ...(opts.font ? { font: opts.font } : {}),
      }
      await this.bridge.call('render_board_png', {
        size: st.size,
        board: st.board,
        out: file,
        kind: k,
        ...extra,
      })
      frames.push({ step, file, captured, last: last || null })
    }
    return { id, kind: k, size: meta.size, total, dir, frames, captures }
  }
}

export default PrintService
