// tools/check_vendor_sync.mjs —— vendored 副本与上游的漂移检查（可自动化）
//
// 定位：src/core/referee.mjs 是 vendored 自 weiqi_lab/tournament/referee.mjs 的逐字副本。
// 上游会继续演进（实测 2026-10-25：上游 f882c62 新增 scoreAuto() 自动死子判定，
// 并引入对 tools/scoring.mjs 的跨文件依赖），若不同步，board-replay 的「离岸
// 交叉验证」就会基于一份过期的裁判 —— 门禁绿灯不代表真的对。
//
// 本脚本做的事：
//   1) 取上游 weiqi_lab 最新提交（本地同级仓库优先并 fetch；否则匿名浅克隆远端）；
//   2) 逐个比对 vendored 文件的**正文** SHA-256（剥掉本仓加的溯源标注头）；
//   3) 扫描上游 referee 的 import 依赖，检测「上游新增了本仓未 vendored 的依赖」
//      —— 这是单文件哈希发现不了的漂移形式；
//   4) 输出结论 + 退出码（0=同步 / 1=漂移 / 2=无法检查）。
//
// ★ 关键实现约束：比对必须针对「上游某个 git ref 的内容」（git show <ref>:<path>），
//   而**不是**本地工作区文件 —— fetch 不会更新工作区，读工作区会漏报漂移。
//
// 用法：
//   node tools/check_vendor_sync.mjs              # 检查（本地优先，回退远端浅克隆）
//   node tools/check_vendor_sync.mjs --json       # 机器可读输出（CI 用）
//   node tools/check_vendor_sync.mjs --no-fetch   # 跳过拉取，只比对本地已有的上游
//
// 退出码：0 = 同步；1 = 检测到漂移；2 = 无法执行检查（网络/依赖问题）。
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const UPSTREAM_REPO = 'https://gitee.com/siwpan/weiqi_lab.git'
const UPSTREAM_BRANCH = 'master'
// 本仓 vendored 的文件 -> 上游对应路径
// ★ 目录镜像上游结构（src/vendor/weiqi_lab/<上游路径>），
//   这样上游文件里的相对 import（../tools/scoring.mjs）在 vendored 后原样可用，
//   逐字副本的 import 路径无需任何改写 —— 这是「逐字」的关键。
const VENDORED_MAP = {
  'src/vendor/weiqi_lab/tournament/referee.mjs': 'tournament/referee.mjs',
  'src/vendor/weiqi_lab/tools/scoring.mjs': 'tools/scoring.mjs',
}
// ★ 本仓**确实已 vendored** 的上游同仓相对依赖。
//   每一项都必须同时出现在 VENDORED_MAP 里（有自己的正文比对），
//   否则不允许出现在上游 import 里 —— 那会变成悬空 import。
const VENDORED_DEPS = {
  'src/vendor/weiqi_lab/tournament/referee.mjs': ['tools/scoring.mjs'],
  'src/vendor/weiqi_lab/tools/scoring.mjs': [],
}
// 正文锚点：从「首个 import 或 export 语句」起（跳过本仓加的溯源标注头）
const BODY_ANCHOR_RE = /^(?:import\s|export\s|\/\*\*)/m

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const noFetch = argv.includes('--no-fetch')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 剥掉本仓加的溯源标注头，返回正文（从首个 import/export/文档注释起） */
function bodyOf(text) {
  // 标注头以 '── vendored 说明' 开头，若存在则从它之后的分隔线再取正文锚点
  let base = text
  const marker = '── vendored 说明'
  const mi = text.indexOf(marker)
  if (mi >= 0) {
    const sep = '// ────────────────────────────────────────────────────────────────────────'
    const si = text.indexOf(sep, mi)
    if (si >= 0) {
      const nl = text.indexOf('\n', si)
      base = text.slice(nl + 1)
    }
  }
  const m = base.match(BODY_ANCHOR_RE)
  if (m && m.index !== undefined) return base.slice(m.index)
  return base
}

const bodyHash = (text) => sha256(Buffer.from(bodyOf(text), 'utf8'))

/** 扫描上游文件的 import 依赖（相对路径），返回其解析后的仓库内 posix 路径 */
function scanImports(text, upstreamFilePath) {
  const deps = []
  const re = /from\s+["'](\.[^"']+)["']/g
  let m
  while ((m = re.exec(text))) {
    const dir = dirname(upstreamFilePath)
    deps.push(normalizeRelative(join(dir, m[1])))
  }
  return deps
}

/** 归一化为仓库内 posix 路径（处理 ../） */
function normalizeRelative(p) {
  const parts = []
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

const git = (repoDir, args, opts = {}) =>
  spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })

/** 从 git 对象读某 ref 下的文件内容（不依赖工作区状态） */
function readAtRef(repoDir, ref, relPath) {
  const r = git(repoDir, ['show', ref + ':' + relPath])
  return r.status === 0 ? r.stdout : null
}

// ── 取得上游（ref + 仓库目录）──────────────────────────────────
function resolveUpstream() {
  const local = resolve(ROOT, '..', 'weiqi_lab')
  if (existsSync(join(local, '.git'))) {
    if (!noFetch) git(local, ['fetch', '--quiet', 'origin', UPSTREAM_BRANCH])
    const remote = git(local, ['rev-parse', 'FETCH_HEAD'])
    if (remote.status === 0) {
      return { dir: local, ref: remote.stdout.trim(), mode: 'local-repo(FETCH_HEAD)' }
    }
    const head = git(local, ['rev-parse', 'HEAD'])
    return { dir: local, ref: head.stdout.trim(), mode: 'local-repo(HEAD)' }
  }
  if (noFetch) return null
  const tmp = mkdtempSync(join(tmpdir(), 'weiqi_lab-'))
  const r = spawnSync('git', ['clone', '--quiet', '--depth', '1', '--branch', UPSTREAM_BRANCH, UPSTREAM_REPO, tmp],
    { encoding: 'utf8', timeout: 120000 })
  if (r.status !== 0) {
    rmSync(tmp, { recursive: true, force: true })
    return null
  }
  const sha = git(tmp, ['rev-parse', 'HEAD']).stdout.trim()
  return { dir: tmp, ref: sha, mode: 'remote-clone', tmp }
}

// ── 主流程 ────────────────────────────────────────────────────
const upstream = resolveUpstream()
if (!upstream) {
  const msg = '无法取得上游仓库（本地同级不存在且远端克隆失败）'
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
  else console.error('✗ ' + msg)
  process.exit(2)
}

const results = []
let drift = false

for (const [localRel, upstreamRel] of Object.entries(VENDORED_MAP)) {
  const localPath = resolve(ROOT, localRel)
  const upstreamText = readAtRef(upstream.dir, upstream.ref, upstreamRel)
  const localMissing = !existsSync(localPath)
  if (localMissing || upstreamText === null) {
    results.push({
      file: localRel,
      upstream: upstreamRel,
      status: 'missing',
      detail: localMissing ? '本仓文件缺失' : '上游该 ref 下文件缺失',
      localBodySha256: localMissing ? null : bodyHash(readFileSync(localPath, 'utf8')),
      upstreamBodySha256: upstreamText === null ? null : bodyHash(upstreamText),
      upstreamDeps: upstreamText === null ? [] : scanImports(upstreamText, upstreamRel),
    })
    drift = true
    continue
  }
  const localText = readFileSync(localPath, 'utf8')
  const lh = bodyHash(localText)
  const uh = bodyHash(upstreamText)
  const same = lh === uh
  if (!same) drift = true
  const entry = {
    file: localRel,
    upstream: upstreamRel,
    status: same ? 'in-sync' : 'drifted',
    localBodySha256: lh,
    upstreamBodySha256: uh,
    localFullSha256: sha256(Buffer.from(localText, 'utf8')),
    upstreamFullSha256: sha256(Buffer.from(upstreamText, 'utf8')),
  }

  // 跨文件依赖检查：上游新增了本仓尚未 vendored 的依赖？
  const upstreamDeps = scanImports(upstreamText, upstreamRel)
  const allowed = VENDORED_DEPS[localRel] || []
  const missingDeps = []
  for (const dep of upstreamDeps) {
    // 依赖必须在本仓有对应的 vendored 文件，且该文件本身也要纳入正文比对
    // （只在 allowed 里声明但没纳入比对 = 漏报漂移，必须报错）
    const vendoredDepPath = 'src/vendor/weiqi_lab/' + dep
    if (!existsSync(resolve(ROOT, vendoredDepPath))) {
      missingDeps.push({ dep, suggestedVendoredPath: vendoredDepPath, reason: '本仓缺少该 vendored 文件' })
    } else if (!Object.values(VENDORED_MAP).includes(dep)) {
      missingDeps.push({ dep, suggestedVendoredPath: vendoredDepPath, reason: '该文件未纳入正文比对（会漏报漂移）' })
    }
  }
  entry.upstreamDeps = upstreamDeps
  entry.allowedDeps = allowed
  if (missingDeps.length) {
    drift = true
    entry.missingDeps = missingDeps
  }
  results.push(entry)
}

// 上游相关文件的最近提交（帮助定位漂移来源）
let upstreamLog = ''
try {
  upstreamLog = git(upstream.dir, ['log', '--oneline', '-5', '--', ...Object.values(VENDORED_MAP)]).stdout.trim()
} catch { /* ignore */ }

const report = {
  ok: !drift,
  upstreamRepo: UPSTREAM_REPO,
  upstreamBranch: UPSTREAM_BRANCH,
  upstreamRef: upstream.ref,
  upstreamMode: upstream.mode,
  upstreamRecentCommits: upstreamLog ? upstreamLog.split('\n') : [],
  files: results,
  checkedAt: new Date().toISOString(),
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('上游 weiqi_lab: ' + UPSTREAM_REPO + '@' + upstream.ref + '（' + upstream.mode + '）')
  if (upstreamLog) {
    console.log('上游相关提交:')
    for (const l of upstreamLog.split('\n')) console.log('  ' + l)
  }
  console.log('')
  for (const r of results) {
    const mark = r.status === 'in-sync' ? '✓' : '✗'
    console.log(mark + ' ' + r.file + '  <-  ' + r.upstream)
    console.log('    本仓正文 sha256: ' + (r.localBodySha256 || '-'))
    console.log('    上游正文 sha256: ' + (r.upstreamBodySha256 || '-'))
    if (r.status === 'drifted') console.log('    → 上游已变更，需重新 vendored')
    if (r.missingDeps && r.missingDeps.length) {
      console.log('    → 上游新增跨文件依赖，本仓尚未 vendored：')
      for (const d of r.missingDeps) {
        console.log('        ' + d.dep + '  (建议 vendored 到 ' + d.suggestedVendoredPath + ')')
      }
    }
  }
  console.log('')
  console.log(drift ? '✗ 检测到漂移 —— vendored 副本落后于上游' : '✓ vendored 副本与上游同步')
}

if (upstream.tmp) rmSync(upstream.tmp, { recursive: true, force: true })
process.exit(drift ? 1 : 0)
