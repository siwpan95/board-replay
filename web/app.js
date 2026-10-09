'use strict'

const canvas = document.getElementById('board')
const ctx = canvas.getContext('2d')
let current = null // { id, kind, size, total, ...meta }
let step = 0

const FILES = 'abcdefgh'

async function loadGames() {
  const r = await fetch('/api/games')
  const data = await r.json()
  const ul = document.getElementById('games')
  ul.innerHTML = ''
  for (const g of data.games) {
    const li = document.createElement('li')
    const badge = g.kind === 'chess' ? '【国象】' : '【围棋】'
    let label
    if (g.kind === 'chess') {
      label = `${g.white || '白'} vs ${g.black || '黑'} · ${g.result || ''}${g.reason ? '(' + g.reason + ')' : ''}`
    } else {
      label = `${g.pb || '黑'} vs ${g.pw || '白'} · ${g.result || ''}`
    }
    li.textContent = `${badge} ${g.id} · ${label}`
    li.title = g.kind === 'chess'
      ? `${g.white}（白） vs ${g.black}（黑） · 8×8 · 结果 ${g.result || '?'} · ${g.reason || ''}`
      : `${g.size}×${g.size} · 贴目 ${g.km || '-'} · ${g.ru || ''}`
    li.onclick = () => selectGame(g.id, li)
    ul.appendChild(li)
  }
}

async function selectGame(id, li) {
  document.querySelectorAll('#games li').forEach((e) => e.classList.remove('active'))
  if (li) li.classList.add('active')
  const r = await fetch('/api/games/' + encodeURIComponent(id))
  const meta = await r.json()
  current = { id, kind: meta.kind, size: meta.size, total: meta.total, ...meta }
  let metaLine
  if (meta.kind === 'chess') {
    metaLine = `${meta.white || '白'}（白） vs ${meta.black || '黑'}（黑） · 8×8 · 结果 ${meta.result || '?'} · ${meta.reason || ''}`
  } else {
    metaLine = `${meta.pb || '黑'}（黑） vs ${meta.pw || '白'}（白） · ${meta.size}×${meta.size} · ` +
      `结果 ${meta.result || '?'} · 贴目 ${meta.km || '-'} · ${meta.ru || ''}`
  }
  document.getElementById('meta').textContent = metaLine
  const slider = document.getElementById('slider')
  slider.max = meta.total
  step = meta.total // 默认看终局，再逐步回退
  slider.value = step
  document.getElementById('print').hidden = false
  await render()
}

async function render() {
  if (!current) return
  const r = await fetch(`/api/games/${encodeURIComponent(current.id)}/state?step=${step}`)
  const st = await r.json()
  if (current.kind === 'chess') drawChess(st.size, st.board, st.last)
  else drawBoard(st.size, st.board, st.last)
  document.getElementById('step-label').textContent = `${st.step} / ${st.total}`
  document.getElementById('lastmove').textContent = lastMoveLabel(st)
  document.getElementById('slider').value = st.step
}

function lastMoveLabel(st) {
  const last = st.last
  if (!last) return '（开局）'
  if (st.kind === 'chess') {
    const fu = uciOf(last.from[1], last.from[0])
    const tu = uciOf(last.to[1], last.to[0])
    const color = last.color === 'w' ? '白' : '黑'
    const letter = last.piece ? last.piece.toUpperCase() : ''
    const san = ({ K: '王', Q: '后', R: '车', B: '象', N: '马', P: '兵' })[letter] || ''
    return `第 ${last.step} 手：${color}${san} ${fu}→${tu}${last.annotation || ''}`
  }
  if (last.vertex) {
    return `第 ${last.step} 手：${last.color === 'B' ? '黑' : '白'} ${last.vertex}`
  }
  return '（过手 / 开局）'
}

function uciOf(col, row) {
  return FILES[col] + (8 - row)
}

function hoshiPoints(size) {
  if (size === 9) return [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]]
  if (size === 13) return [[3, 3], [9, 3], [3, 9], [9, 9], [6, 6]]
  if (size >= 19) return [[3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15]]
  return []
}

// ---------- 围棋盘 ----------
function drawBoard(size, board, last) {
  const dpr = window.devicePixelRatio || 1
  const px = 40
  const margin = px
  const dim = margin * 2 + (size - 1) * px
  canvas.width = dim * dpr
  canvas.height = dim * dpr
  canvas.style.width = dim + 'px'
  canvas.style.height = dim + 'px'
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, dim, dim)

  ctx.fillStyle = '#dbb377'
  ctx.fillRect(0, 0, dim, dim)

  ctx.strokeStyle = '#282828'
  ctx.lineWidth = 1
  for (let i = 0; i < size; i++) {
    const c = margin + i * px
    ctx.beginPath(); ctx.moveTo(c, margin); ctx.lineTo(c, margin + (size - 1) * px); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(margin, c); ctx.lineTo(margin + (size - 1) * px, c); ctx.stroke()
  }

  ctx.fillStyle = '#282828'
  for (const [hx, hy] of hoshiPoints(size)) {
    const cx = margin + hx * px
    const cy = margin + hy * px
    const r = Math.max(3, px / 8)
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill()
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = board[y][x]
      if (!v) continue
      const cx = margin + x * px
      const cy = margin + y * px
      const r = px * 0.46
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
      if (v === 1) {
        ctx.fillStyle = '#1e1e1e'; ctx.fill()
      } else {
        ctx.fillStyle = '#f3f3f3'; ctx.fill()
        ctx.strokeStyle = '#999'; ctx.lineWidth = 1; ctx.stroke()
      }
    }
  }

  if (last && last.x != null && last.y != null) {
    const cx = margin + last.x * px
    const cy = margin + last.y * px
    ctx.strokeStyle = '#e23b3b'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(cx, cy, px * 0.22, 0, Math.PI * 2); ctx.stroke()
  }
}

// ---------- 国际象棋盘 ----------
function drawChess(size, board, last) {
  size = size || 8
  const dpr = window.devicePixelRatio || 1
  const px = 52
  const margin = 26 // 留给坐标标注
  const dim = margin * 2 + (size - 1) * px
  canvas.width = dim * dpr
  canvas.height = dim * dpr
  canvas.style.width = dim + 'px'
  canvas.style.height = dim + 'px'
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, dim, dim)

  // 棋盘格（r=0 顶端=第8横线；浅色 a1 在左下）
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const isLight = (r + c) % 2 === 1 // 让 a8(0,0) 深色，h1(7,7) 浅色 -> 标准棋盘
      ctx.fillStyle = isLight ? '#f0d9b5' : '#b58863'
      const x = margin + c * px
      const y = margin + r * px
      ctx.fillRect(x, y, px, px)
    }
  }

  // 坐标标注：底端文件 a-h，左端横线 8..1
  ctx.fillStyle = '#5b4636'
  ctx.font = '12px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let c = 0; c < size; c++) {
    ctx.fillText(FILES[c], margin + c * px + px / 2, dim - margin / 2)
  }
  ctx.textAlign = 'right'
  for (let r = 0; r < size; r++) {
    ctx.fillText(String(8 - r), margin / 2, margin + r * px + px / 2)
  }
  ctx.textAlign = 'center'

  // 最后一手：from / to 高亮
  if (last && last.from && last.to) {
    for (const [rr, cc] of [last.from, last.to]) {
      ctx.fillStyle = (rr === last.to[0] && cc === last.to[1]) ? 'rgba(255,214,10,0.55)' : 'rgba(255,214,10,0.30)'
      ctx.fillRect(margin + cc * px, margin + rr * px, px, px)
    }
  }

  // 棋子：圆盘 + 字母（大写；颜色区分敌我）
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const p = board[r][c]
      if (!p || p === '.') continue
      const white = p === p.toUpperCase()
      const cx = margin + c * px + px / 2
      const cy = margin + r * px + px / 2
      const rad = px * 0.4
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2)
      ctx.fillStyle = white ? '#f8f8f8' : '#2b2b2b'
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = white ? '#9a9a9a' : '#000'
      ctx.stroke()
      const letter = p.toUpperCase()
      ctx.fillStyle = white ? '#1c1c1c' : '#f3f3f3'
      ctx.font = 'bold ' + Math.round(px * 0.5) + 'px system-ui, sans-serif'
      ctx.fillText(letter, cx, cy + 1)
    }
  }

  // 终局后在最后的子外圈红环（与围棋一致）
  if (last && last.to) {
    const cx = margin + last.to[1] * px + px / 2
    const cy = margin + last.to[0] * px + px / 2
    ctx.strokeStyle = '#e23b3b'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(cx, cy, px * 0.44, 0, Math.PI * 2); ctx.stroke()
  }
}

// 控件
document.getElementById('prev').onclick = () => { step = Math.max(0, step - 1); render() }
document.getElementById('next').onclick = () => { if (current) step = Math.min(current.total, step + 1); render() }
document.getElementById('first').onclick = () => { step = 0; render() }
document.getElementById('last').onclick = () => { if (current) step = current.total; render() }
document.getElementById('slider').oninput = (e) => { step = Number(e.target.value); render() }
document.getElementById('print').onclick = async () => {
  if (!current) return
  const r = await fetch('/api/print', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: current.id, step, kind: current.kind }),
  })
  const j = await r.json()
  if (j.file) alert('已生成：' + j.file)
  else alert('出图失败：' + (j.error || '未知'))
}

loadGames()
