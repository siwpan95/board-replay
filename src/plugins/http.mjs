// HttpService —— 本地接入层，挂到 ctx.http
// 只用 node:http（零新增 npm 依赖）：静态托管 web/ + REST 控制 + SSE 推送。
// 安全：默认只监听 127.0.0.1；静态目录做路径穿越防护；不代理任意路径。
import { Service } from 'cordis'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(__dirname, '../../web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
}
const MAX_BODY = 1 << 20

export class HttpService extends Service {
  static provide = 'http'
  static inject = ['board']

  constructor(ctx, config) {
    super(ctx, 'http')
    this.config = config || {}
    // 优先级：环境变量（CLI 透传）> cordis.json 配置 > 内置默认
    this.host = process.env.BOARD_HOST || this.config.host || '127.0.0.1'
    // 端口 0（系统分配空闲端口）必须保留，不能用 || 吞掉
    const envPort = process.env.BOARD_PORT
    this.port = envPort != null ? Number(envPort) : (this.config.port === 0 ? 0 : Number(this.config.port) || 5173)
    this.open = process.env.BOARD_OPEN === '0' ? false : this.config.open !== false
    this.server = null
    this.clients = new Set()
  }

  [Service.init]() {
    this.server = createServer((req, res) => this._handle(req, res))
    return new Promise((resolveReady, rejectReady) => {
      this.server.on('error', (e) => {
        this.ctx.logger.warn('http: 服务错误 %s', e.message)
        rejectReady(e)
      })
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address()
        this.port = addr.port
        this.url = 'http://' + this.host + ':' + this.port + '/'
        this.ctx.logger.info('http: board-replay 已启动 -> %s', this.url)
        resolveReady()
      })
    }).then(() => () => {
      // 关停：先断 SSE 连接，再关服务器
      for (const res of this.clients) {
        try { res.end() } catch { /* ignore */ }
      }
      this.clients.clear()
      if (this.server) this.server.close()
      this.ctx.logger.info('http: 服务已关闭')
    })
  }

  // ---------- 路由 ----------
  async _handle(req, res) {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
    const path = url.pathname
    try {
      if (path === '/api/events') return this._sse(req, res)
      if (path.startsWith('/api/')) return await this._api(req, res, path, url)
      return await this._static(res, path)
    } catch (e) {
      this.ctx.logger.warn('http: %s %s 失败 %s', req.method, path, e.message)
      return this._json(res, 500, { error: e.message })
    }
  }

  async _api(req, res, path, url) {
    const board = this.ctx.board
    const chess = this._chess()
    const json = (code, body) => this._json(res, code, body)

    // 谱列表（围棋 + 国际象棋 合并；各自带 kind 字段区分）
    if (path === '/api/games' && req.method === 'GET') {
      const games = [...board.list(), ...(chess ? chess.list() : [])]
      return json(200, { games })
    }

    // 单个谱：/api/games/:id  /  /api/games/:id/state?step=k  /  /api/games/:id/pgn
    if (path.startsWith('/api/games/')) {
      const rest = decodeURIComponent(path.slice('/api/games/'.length))
      const id = rest.split('/')[0]
      if (rest.endsWith('/pgn')) {
        if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
        const chess = this._chess()
        if (!chess) return json(501, { error: 'chess 插件未启用，无法导出 PGN' })
        try {
          const pgn = chess.pgn(id)
          res.writeHead(200, {
            'Content-Type': 'application/x-chess-pgn; charset=utf-8',
            'Content-Disposition': `attachment; filename="${id}.pgn"`,
            'Cache-Control': 'no-store',
          })
          return res.end(pgn)
        } catch (e) {
          return json(404, { error: e.message })
        }
      }
      if (rest.endsWith('/state')) {
        if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
        const stepRaw = url.searchParams.get('step')
        const step = stepRaw == null ? 999999 : Number(stepRaw)
        try {
          const st = board.meta(id) ? board.stateAt(id, step)
            : (chess ? chess.stateAt(id, step) : (() => { throw new Error('unknown game: ' + id) })())
          return json(200, st)
        } catch (e) {
          return json(404, { error: e.message })
        }
      }
      if (req.method === 'GET') {
        const meta = board.meta(id) || (chess ? chess.meta(id) : null)
        if (!meta) return json(404, { error: 'game not found: ' + id })
        return json(200, meta)
      }
      return json(405, { error: 'method not allowed' })
    }

    // B4：出图（需 print 服务）
    if (path === '/api/print' && req.method === 'POST') {
      const print = this.ctx.get('print')
      if (!print) return json(501, { error: 'print 插件未启用（用 BOARD_CONFIG=cordis.print.json 启动，需 Python + Pillow）' })
      const body = await this._body(req)
      try {
        const out = await print.renderGame(body.id, body.step, body.out, body.kind, body.extra)
        return json(200, out)
      } catch (e) {
        return json(500, { error: e.message })
      }
    }

    return json(404, { error: '未找到: ' + path })
  }

  // ---------- SSE ----------
  // 惰性取 chess 服务（cordis.json 未挂 chess 插件时为 null，不报错）
  _chess() {
    try { return this.ctx.get('chess') } catch { return null }
  }

  _sse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    // 连接即推当前谱列表（围棋 + 国际象棋合并）
    const chess = this._chess()
    try {
      this._send(res, 'games', { games: [...this.ctx.board.list(), ...(chess ? chess.list() : [])] })
    } catch { /* ignore */ }
    this.clients.add(res)
    req.on('close', () => {
      this.clients.delete(res)
    })
  }

  _send(res, event, data) {
    try {
      res.write('event: ' + event + '\n')
      res.write('data: ' + JSON.stringify(data) + '\n\n')
    } catch {
      this.clients.delete(res)
    }
  }

  // ---------- 静态资源 ----------
  async _static(res, path) {
    let rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '')
    const full = resolve(WEB_ROOT, rel)
    // 路径穿越防护：解析后必须仍在 web/ 内
    if (full !== WEB_ROOT && !full.startsWith(WEB_ROOT + sep)) {
      return this._json(res, 403, { error: '禁止访问' })
    }
    try {
      const st = await stat(full)
      if (st.isDirectory()) return this._static(res, join(path, 'index.html'))
      const buf = await readFile(full)
      res.writeHead(200, {
        'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      })
      res.end(buf)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('404 Not Found: ' + path)
    }
  }

  // ---------- 工具 ----------
  _body(req) {
    return new Promise((ok, no) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY) { no(new Error('请求体过大')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (!raw) return ok({})
        try { ok(JSON.parse(raw)) } catch { no(new Error('请求体不是合法 JSON')) }
      })
      req.on('error', no)
    })
  }

  _json(res, code, body) {
    const s = JSON.stringify(body)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(s),
      'Cache-Control': 'no-store',
    })
    res.end(s)
  }
}

export default HttpService
