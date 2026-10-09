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
  async renderGame(id, step, out, kind) {
    const svc = this._resolveService(id, kind)
    const st = svc.stateAt(id, step == null ? 999999 : step)
    const file = out || resolve(process.cwd(), 'output', `${st.id}-${st.step}.png`)
    const res = await this.bridge.call('render_board_png', {
      size: st.size,
      board: st.board,
      out: file,
      kind: st.kind || 'go',
    })
    return { ...res, file, id: st.id, step: st.step, kind: st.kind || 'go' }
  }

  // 直接渲染给定棋盘矩阵（kind 区分围棋 / 国际象棋）
  async renderBoard(board, size, out, kind) {
    const file = out || resolve(process.cwd(), 'output', 'board.png')
    const res = await this.bridge.call('render_board_png', { size, board, out: file, kind: kind || 'go' })
    return { ...res, file }
  }
}

export default PrintService
