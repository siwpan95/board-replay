// tools/install_hooks.mjs —— 安装本地 git hook（pre-commit 漂移拦截）
//
// 用途：防止「vendored 副本落后上游」被提交。CI 能兜底，但本地拦截更早、更快。
// 安装：node tools/install_hooks.mjs
// 卸载：node tools/install_hooks.mjs --uninstall
//
// 说明：
//   - hook 装在 .git/hooks/pre-commit（不随 clone 分发，需各人自行安装）；
//   - hook 失败不阻塞提交（打印警告即可）——因为它依赖网络，网络抖动不该挡住工作。
import { writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const HOOK = resolve(ROOT, '.git', 'hooks', 'pre-commit')
const uninstall = process.argv.includes('--uninstall')

if (uninstall) {
  if (existsSync(HOOK)) {
    unlinkSync(HOOK)
    console.log('✓ 已卸载 pre-commit hook')
  } else {
    console.log('- 未安装 pre-commit hook')
  }
  process.exit(0)
}

if (!existsSync(resolve(ROOT, '.git', 'hooks'))) {
  console.error('不是 git 仓库根目录: %s', ROOT)
  process.exit(2)
}

const script = `#!/bin/sh
# board-replay pre-commit hook —— vendored 漂移拦截
# 由 tools/install_hooks.mjs 安装。可用 node tools/install_hooks.mjs --uninstall 卸载。
#
# 作用：提交前检查本仓 vendored 的 weiqi_lab 副本是否落后上游。
# 注意：这是**警告式**拦截（不阻塞提交）——它依赖网络，网络抖动不该挡住正常工作。

ROOT="$(git rev-parse --show-toplevel)"
OUT="$(cd "$ROOT" && node tools/check_vendor_sync.mjs 2>&1)"
STATUS=$?

if [ $STATUS -eq 0 ]; then
  echo "[pre-commit] vendored 漂移检查: 通过"
  exit 0
fi

if [ $STATUS -eq 2 ]; then
  echo "[pre-commit] vendored 漂移检查: 无法执行（网络/依赖问题），跳过"
  exit 0
fi

echo ""
echo "[pre-commit] ✗ 检测到 vendored 副本落后上游 weiqi_lab："
echo "$OUT" | sed 's/^/    /'
echo ""
echo "    请重新 vendored 后再提交，或用 --no-verify 跳过（不建议）。"
echo ""
exit 0
`

writeFileSync(HOOK, script, 'utf8')
try {
  chmodSync(HOOK, 0o755)
} catch {
  // Windows 上 git bash 会忽略执行位，无需失败
}
console.log('✓ 已安装 pre-commit hook: %s', HOOK)
console.log('  提示：hook 不随 clone 分发，克隆后请执行一次 node tools/install_hooks.mjs')
