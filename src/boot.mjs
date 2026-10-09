// boot.mjs —— Cordis 宿主启动/关停（board-replay，复用 cordis-table-app / pomodmer 模式）
// 架构：new Context() -> 接 console 日志导出器 -> 装 Loader（声明式插件宿主）
//       -> 读 cordis.json 的 entries，逐条 loader.create 加载插件（board / http / print）
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

let ctx = null
let printBridgeRef = null

export function getCtx() {
  return ctx
}

export async function bootHost(options = {}) {
  ctx = new Context()

  // 1) 日志导出器（否则 loader 失败路径全走 logger.error 而静默）
  await ctx.plugin(ConsoleExporter)

  // 2) Cordis 插件宿主（声明式入口），baseUrl 决定条目相对路径解析基点 = 项目根
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(process.cwd() + '/').href })
  const loader = ctx.loader

  // 3) 读配置，逐条创建入口。显式入参 > 环境变量 BOARD_CONFIG > 默认 cordis.json
  const cfgPath = options.config || process.env.BOARD_CONFIG || 'cordis.json'
  const entries = JSON.parse(readFileSync(cfgPath, 'utf8')).entries || []
  for (const entry of entries) {
    await loader.create({ ...entry })
  }
  await loader.await()

  // 4) 缓存 print 桥引用，供 stopHost 兜底强杀 python worker
  printBridgeRef = ctx.print ? ctx.print.bridge : null

  ctx.logger.info('host booted, entries=%d, ctx.board=%s, ctx.print=%s', entries.length, !!ctx.board, !!ctx.print)
  return ctx
}

// 正确关停（Cordis 无 ctx.stop；根 fiber dispose=restart）：
// 逆序 dispose 顶层入口 fiber -> 触发各服务清理函数（杀 python），最后兜底强杀。
export async function stopHost() {
  if (!ctx) return
  const loader = ctx.loader
  ctx.logger.info('stopping host...')
  for (const entry of [...loader.root.tree.entries()]) {
    if (entry.fiber) {
      try {
        await entry.fiber.dispose()
      } catch (e) {
        ctx.logger.warn('dispose entry %s failed: %s', entry.options.id, e.message)
      }
    }
  }
  // 兜底：确保 python worker 已退出
  if (printBridgeRef) {
    await printBridgeRef.stop().catch(() => {})
  }
  ctx = null
  printBridgeRef = null
}

// 作为入口直接运行：启动宿主并保持（HTTP 服务常驻），收到 SIGINT/SIGTERM 优雅关停
if (process.argv[1] && process.argv[1].endsWith('boot.mjs')) {
  bootHost().then(() => {
    ctx.logger.info('board-replay 运行中；Ctrl+C 退出')
  }).catch((e) => {
    console.error('boot failed:', e)
    process.exit(1)
  })
  const shutdown = async () => {
    await stopHost()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
