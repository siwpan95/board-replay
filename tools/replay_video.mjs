// tools/replay_video.mjs —— 把一局围棋对局「完整打印」成定格视频。
//
// 定位：board-replay 已有单帧出图能力（print 插件 -> Python/Pillow），
// 本工具把它串成一条完整的**定格视频**流水线：
//
//   SGF 谱 -> 逐手状态 -> 逐手 PNG 帧（含坐标 / 最后一手红圈 / 手数字幕）
//          -> ffmpeg 合成定格视频（每手定格若干毫秒）-> mp4 + gif
//
// 「定格」的含义：每一手是一张静止画面，按固定节奏逐格推进（默认每手 700ms），
// 观感类似翻书式复盘，而不是平滑插值的动画。
//
// 用法：
//   node tools/replay_video.mjs                                  # 打印默认局（手数最长的一局）
//   node tools/replay_video.mjs --id 2026-10-09-g01-pyvsjs       # 指定棋谱 id
//   node tools/replay_video.mjs --list                           # 列出全部可打印的围棋谱
//   node tools/replay_video.mjs --id <id> --hold 900 --px 56     # 每手定格 900ms、格子 56px
//   node tools/replay_video.mjs --id <id> --no-gif               # 只出 mp4
//   node tools/replay_video.mjs --id <id> --out output/video     # 指定输出目录
//
// 退出码：0 = 成功；1 = 出图/合成失败；2 = 参数或依赖缺失。
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = {
    id: null, list: false, hold: 700, px: 44, outDir: null,
    gif: true, python: null, ffmpeg: null, help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--id') out.id = argv[++i]
    else if (a === '--list') out.list = true
    else if (a === '--hold') out.hold = Number(argv[++i])
    else if (a === '--px') out.px = Number(argv[++i])
    else if (a === '--out') out.outDir = argv[++i]
    else if (a === '--no-gif') out.gif = false
    else if (a === '--python') out.python = argv[++i]
    else if (a === '--ffmpeg') out.ffmpeg = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

// ---------- 工具 ----------
function run(cmd, args, opts = {}) {
  return new Promise((ok, no) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let stdout = '', stderr = ''
    p.stdout.on('data', (d) => { stdout += d.toString() })
    p.stderr.on('data', (d) => { stderr += d.toString() })
    p.on('error', (e) => no(new Error(cmd + ' 启动失败: ' + e.message)))
    p.on('close', (code) => {
      if (code === 0) ok({ stdout, stderr })
      else no(new Error(cmd + ' 退出码 ' + code + '\n' + (stderr || stdout).slice(-2000)))
    })
  })
}

const USAGE = [
  'tools/replay_video.mjs —— 把一局围棋对局完整打印成定格视频',
  '',
  '  node tools/replay_video.mjs                            # 默认局（手数最多的一局）',
  '  node tools/replay_video.mjs --list                     # 列出可打印的围棋谱',
  '  node tools/replay_video.mjs --id <id> --hold 900       # 指定棋谱 + 每手定格毫秒',
  '  node tools/replay_video.mjs --id <id> --px 56          # 格子像素',
  '  node tools/replay_video.mjs --id <id> --no-gif         # 只出 mp4',
].join('\n')

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return 0
  }

  // Python：优先显式 --python，其次 BOARD_PYTHON，再次探测常见解释器
  const pythonCandidates = [
    args.python, process.env.BOARD_PYTHON,
    'E:/Python314/python.exe', 'python',
  ].filter(Boolean)
  let pythonBin = null
  for (const cand of pythonCandidates) {
    try {
      const r = await run(cand, ['-c', 'import PIL,sys;print(PIL.__version__)'])
      pythonBin = cand
      console.log('python: %s (Pillow %s)', cand, r.stdout.trim())
      break
    } catch {
      /* 试下一个 */
    }
  }
  if (!pythonBin) {
    console.error('找不到带 Pillow 的 Python（试过: %s）', pythonCandidates.join(', '))
    return 2
  }

  // ffmpeg
  const ffmpegCandidates = [args.ffmpeg, process.env.FFMPEG_BIN, 'ffmpeg', 'E:/ffmpeg/bin/ffmpeg.exe']
    .filter(Boolean)
  let ffmpegBin = null
  for (const cand of ffmpegCandidates) {
    try {
      await run(cand, ['-hide_banner', '-encoders'])
      ffmpegBin = cand
      break
    } catch {
      /* 试下一个 */
    }
  }
  if (!ffmpegBin) {
    console.error('找不到 ffmpeg（试过: %s）', ffmpegCandidates.join(', '))
    return 2
  }
  console.log('ffmpeg: %s', ffmpegBin)

  // 启动 Cordis 宿主（只挂 board + print，不开 HTTP —— 不占用 5173 端口）
  // 注意：print 插件构造时读 BOARD_PYTHON，必须在 bootHost 之前设好
  process.env.BOARD_PYTHON = pythonBin
  const cwd = process.cwd()
  process.chdir(ROOT) // loader 与 print 插件的相对路径都基于 cwd
  const { bootHost, stopHost } = await import('../src/boot.mjs')
  const ctx = await bootHost({ config: resolve(ROOT, 'cordis.video.json') })
  const print = ctx.get('print')
  const board = ctx.get('board')

  try {
    if (!print || !board) {
      console.error('宿主未装载 board/print 插件')
      return 1
    }

    const games = board.list().filter((g) => g.kind === 'go')
    if (!games.length) {
      console.error('samples/ 下没有围棋 SGF')
      return 2
    }
    games.sort((a, b) => b.total - a.total)

    if (args.list) {
      console.log('\n可打印的围棋谱（按手数降序）：')
      for (const g of games) {
        console.log(
          `  ${g.id.padEnd(28)} ${String(g.total).padStart(3)} 手  ` +
          `${g.size}×${g.size}  ${g.pb} vs ${g.pw}  ${g.result}`
        )
      }
      return 0
    }

    // 选局：显式 --id，否则取手数最多的（= 完整度最高的一局）
    const game = args.id ? games.find((g) => g.id === args.id) : games[0]
    if (!game) {
      console.error('找不到棋谱 id: %s（用 --list 看可选项）', args.id)
      return 2
    }

    const outDir = resolve(args.outDir || resolve(ROOT, 'output', 'video'), game.id)
    const framesDir = resolve(outDir, 'frames')
    await mkdir(framesDir, { recursive: true })

    console.log('\n目标棋谱：%s', game.id)
    console.log('  对局：%s(黑) vs %s(白)  %s×%s  贴目 %s  结果 %s',
      game.pb, game.pw, game.size, game.size, game.km || '-', game.result || '-')
    console.log('  总手数：%d', game.total)
    console.log('  输出目录：%s', outDir)

    const titleText = `${game.pb}（黑） vs ${game.pw}（白） · ${game.size}×${game.size} · 贴目 ${game.km || '-'} · 结果 ${game.result || '?'}`

    // 逐手出图（含开局空盘）
    const seq = await print.renderSequence(game.id, 'go', {
      outDir: framesDir,
      px: args.px,
      coords: true,
      highlight: true,
      title: titleText,
      caption: (st, info) => {
        if (!info.last) return `开局 · 0 / ${info.total}`
        const c = info.colorText
        const mv = info.moveText
        const cap = info.captured > 0 ? ` · 提 ${info.captured} 子` : ''
        return `第 ${info.step} / ${info.total} 手 · ${c} ${mv}${cap}`
      },
    })

    const passCount = seq.frames.filter((f) => f.last && (!f.last.vertex || f.last.vertex === 'pass')).length
    console.log('  已渲染 %d 帧（含开局空盘），其中过手 %d 手', seq.frames.length, passCount)

    // ffmpeg 合成定格视频
    // 定格实现：每帧停留 hold 毫秒 —— 输入帧率取 1000/hold，即每张 PNG 展示 hold ms
    const fps = 1000 / args.hold
    const mp4 = resolve(outDir, `${game.id}-replay.mp4`)
    const pattern = resolve(framesDir, `${game.id}-%04d.png`)
    // yuv420p 要求偶数宽高，这里统一向下取偶（避免奇数 px 时被 libx264 拒收）
    const even = 'scale=ceil(iw/2)*2:ceil(ih/2)*2'
    console.log('  合成 mp4（每手定格 %dms）…', args.hold)
    await run(ffmpegBin, [
      '-y',
      '-framerate', String(fps),
      '-i', pattern,
      '-vf', even,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-r', '25',
      '-movflags', '+faststart',
      mp4,
    ])
    const mp4Size = (await stat(mp4)).size

    let gif = null
    if (args.gif) {
      const gifPath = resolve(outDir, `${game.id}-replay.gif`)
      console.log('  合成 gif…')
      await run(ffmpegBin, [
        '-y',
        '-framerate', String(fps),
        '-i', pattern,
        '-vf', `split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer:bayer_scale=3,${even}`,
        '-loop', '0',
        gifPath,
      ])
      gif = { path: gifPath, size: (await stat(gifPath)).size }
    }

    // 帧清单（可复现证据）
    const manifest = {
      game: {
        id: game.id, size: game.size, total: game.total,
        pb: game.pb, pw: game.pw, km: game.km, ru: game.ru, result: game.result,
      },
      video: {
        mp4: { path: mp4, bytes: mp4Size },
        gif: gif ? { path: gif.path, bytes: gif.size } : null,
        holdMs: args.hold, inputFps: Number(fps.toFixed(4)), px: args.px,
        frames: seq.frames.length,
      },
      captures: seq.captures,
      frames: seq.frames.map((f) => ({
        step: f.step,
        file: f.file,
        captured: f.captured,
        move: f.last ? (f.last.color === 'B' ? 'B' : 'W') + (f.last.vertex || 'pass') : null,
      })),
    }
    const manifestPath = resolve(outDir, `${game.id}-replay.json`)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    // 帧数守恒自检：目录 PNG 数 == 清单帧数 == 手数+1
    const pngs = (await readdir(framesDir)).filter((f) => f.endsWith('.png'))
    const expect = game.total + 1
    if (pngs.length !== seq.frames.length || pngs.length !== expect) {
      console.error('  ✗ 帧数不符：目录 %d 个 PNG / 清单 %d 帧 / 期望 %d 帧',
        pngs.length, seq.frames.length, expect)
      return 1
    }

    console.log('\n✓ 完成')
    console.log(`  mp4 : ${mp4} (${(mp4Size / 1048576).toFixed(2)} MB)`)
    if (gif) console.log(`  gif : ${gif.path} (${(gif.size / 1048576).toFixed(2)} MB)`)
    console.log('  清单: %s', manifestPath)
    console.log('  帧数: %d（= %d 手 + 1 开局空盘）', pngs.length, game.total)
    console.log('  提子: 黑 %d 子 / 白 %d 子', seq.captures.B, seq.captures.W)
    return 0
  } finally {
    const { stopHost } = await import('../src/boot.mjs')
    await stopHost()
    process.chdir(cwd)
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
