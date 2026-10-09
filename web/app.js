'use strict'

const canvas = document.getElementById('board')
const ctx = canvas.getContext('2d')
let current = null // { id, size, total, ...meta }
let step = 0

async function loadGames() {
  const r = await fetch('/api/games')
  const data = await r.json()
  const ul = document.getElementById('games')
  ul.innerHTML = ''
  for (const g of data.games) {
    const li = document.createElement('li')
    li.textContent = `${g.id} · ${g.pb || '黑'} vs ${g.pw || '白'} · ${g.result || ''}`
    li.title = `${g.size}×${g.size} · 贴目 ${g.km || '-'} · ${g.ru || ''}`
    li.onclick = () => selectGame(g.id, li)
    ul.appendChild(li)
  }
}

async function selectGame(id, li) {
  document.querySelectorAll('#games li').forEach((e) => e.classList.remove('active'))
  if (li) li.classList.add('active')
  const r = await fetch('/api/games/' + encodeURIComponent(id))
  const meta = await r.json()
  current = { id, size: meta.size, total: meta.total, ...meta }
  document.getElementById('meta').textContent =
    `${meta.pb || '黑'}（黑） vs ${meta.pw || '白'}（白） · ${meta.size}×${meta.size} · ` +
    `结果 ${meta.result || '?'} · 贴目 ${meta.km || '-'} · ${meta.ru || ''}`
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
  drawBoard(st.size, st.board, st.last)
  document.getElementById('step-label').textContent = `${st.step} / ${st.total}`
  document.getElementById('lastmove').textContent =
    st.last && st.last.vertex
      ? `第 ${st.last.step} 手：${st.last.color === 'B' ? '黑' : '白'} ${st.last.vertex}`
      : '（过手 / 开局）'
  document.getElementById('slider').value = st.step
}

function hoshiPoints(size) {
  if (size === 9) return [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]]
  if (size === 13) return [[3, 3], [9, 3], [3, 9], [9, 9], [6, 6]]
  if (size >= 19) return [[3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15]]
  return []
}

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

  // 盘底
  ctx.fillStyle = '#dbb377'
  ctx.fillRect(0, 0, dim, dim)

  // 网格
  ctx.strokeStyle = '#282828'
  ctx.lineWidth = 1
  for (let i = 0; i < size; i++) {
    const c = margin + i * px
    ctx.beginPath(); ctx.moveTo(c, margin); ctx.lineTo(c, margin + (size - 1) * px); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(margin, c); ctx.lineTo(margin + (size - 1) * px, c); ctx.stroke()
  }

  // 星位
  ctx.fillStyle = '#282828'
  for (const [hx, hy] of hoshiPoints(size)) {
    const cx = margin + hx * px
    const cy = margin + hy * px
    const r = Math.max(3, px / 8)
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill()
  }

  // 棋子
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

  // 最后一手标记
  if (last && last.x != null && last.y != null) {
    const cx = margin + last.x * px
    const cy = margin + last.y * px
    ctx.strokeStyle = '#e23b3b'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(cx, cy, px * 0.22, 0, Math.PI * 2); ctx.stroke()
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
    body: JSON.stringify({ id: current.id, step }),
  })
  const j = await r.json()
  if (j.file) alert('已生成：' + j.file)
  else alert('出图失败：' + (j.error || '未知'))
}

loadGames()
