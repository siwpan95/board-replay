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

  // 渲染某谱第 step 手（省略 step -> 终局）的棋盘 PNG。
  // out 省略 -> output/<id>-<step>.png
  async renderGame(id, step, out) {
    const st = this.ctx.board.stateAt(id, step == null ? 999999 : step)
    const file = out || resolve(process.cwd(), 'output', `${st.id}-${st.step}.png`)
    const res = await this.bridge.call('render_board_png', {
      size: st.size,
      board: st.board,
      out: file,
    })
    return { ...res, file, id: st.id, step: st.step }
  }

  // 直接渲染给定棋盘矩阵（供未来国际化象棋复用，棋盘约定一致时可直接复用）
  async renderBoard(board, size, out) {
    const file = out || resolve(process.cwd(), 'output', 'board.png')
    const res = await this.bridge.call('render_board_png', { size, board, out: file })
    return { ...res, file }
  }
}

export default PrintService
