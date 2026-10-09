// JsonRpcBridge —— Cordis 宿主与 Python OpenPyXL worker 之间的 JSON-RPC stdio 桥
// 协议：每行一个 JSON-RPC 2.0 对象；响应按 id 匹配 pending；stdout 仅承载协议。
import { spawn } from 'node:child_process'
import readline from 'node:readline'

export class JsonRpcBridge {
  constructor(pythonBin, scriptPath) {
    this.pythonBin = pythonBin
    this.scriptPath = scriptPath
    this.child = null
    this.pending = new Map()
    this.nextId = 1
    this.onExit = null
  }

  // 同步创建子进程并返回 "已 spawn" 的 Promise（拿到 pid 即 resolve）
  start() {
    if (this.child) return Promise.resolve(this.child.pid)
    this.child = spawn(this.pythonBin, ['-u', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.on('error', (err) => {
      // 启动失败（如 python 不存在）：reject 所有 pending
      for (const [, { reject }] of this.pending) reject(err)
      this.pending.clear()
    })

    this.child.stderr.on('data', (d) => {
      process.stderr.write('[py] ' + d.toString())
    })

    const rl = readline.createInterface({ input: this.child.stdout })
    rl.on('line', (line) => {
      line = line.trim()
      if (!line) return
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) {
          reject(new Error(msg.error.message + '\n' + (msg.error.data || '')))
        } else {
          resolve(msg.result)
        }
      }
    })

    this.child.on('exit', (code) => {
      for (const [, { reject }] of this.pending) reject(new Error('python worker exited (code ' + code + ')'))
      this.pending.clear()
      if (this.onExit) this.onExit(code)
    })

    if (this.child.pid) return Promise.resolve(this.child.pid)
    return new Promise((resolve) => this.child.on('spawn', () => resolve(this.child.pid)))
  }

  call(method, params) {
    if (!this.child) this.start()
    const id = this.nextId++
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return p
  }

  // 优雅关停：发 exit 通知 + 关闭 stdin（EOF 触发 python 自行退出），800ms 兜底 SIGKILL
  // 幂等：已被调用过（或 stdin 已关闭）则直接返回，避免 write-after-end 崩溃。
  async stop() {
    if (!this.child || this._stopped) return
    this._stopped = true
    const child = this.child
    try {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'exit' }) + '\n')
        child.stdin.end()
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, 800)
    await new Promise((r) => setTimeout(r, 900))
  }
}
