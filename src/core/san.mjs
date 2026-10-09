// src/core/san.mjs
// 国际象棋 SAN（Standard Algebraic Notation）着法格式化 + PGN 文本组装。
// 依赖 vendored chess_engine（generateAllLegalMoves / applyMove / SPECIAL 等），
// 与 lab 规则引擎同源，保证符号与赛事记录口径一致。
//
// 约定：formatSan 只产出「基础着法串」（不含 +/# 后缀）；后缀由调用方在 applyMove 后
// 依据新局面的将/将死状态追加（与 chess.mjs 的 annotation 计算同源）。
import { SPECIAL } from './chess_engine.mjs'

const FILES = 'abcdefgh'

function square(r, c) {
  return FILES[c] + (8 - r)
}

// 由合法着法对象生成 SAN 基础串（不含 +/-# 后缀）
//   state  : 走子前的局面
//   mv     : generateAllLegalMoves 产出的着法对象 {fromR,fromC,toR,toC,piece,captured,special,promotion}
//   all    : 同一局面下的全部合法着法（用于同兵种多子到达同格时的消歧）
export function formatSan(state, mv, all) {
  if (mv.special === SPECIAL.CASTLE_KINGSIDE) return 'O-O'
  if (mv.special === SPECIAL.CASTLE_QUEENSIDE) return 'O-O-O'

  const isPawn = mv.piece.toUpperCase() === 'P'
  let s = ''

  if (!isPawn) {
    s += mv.piece.toUpperCase() // K / Q / R / B / N
    // 消歧：同兵种还有别的子能走到同一格
    const others = all.filter(
      (o) => o.piece === mv.piece && o.toR === mv.toR && o.toC === mv.toC &&
        !(o.fromR === mv.fromR && o.fromC === mv.fromC)
    )
    if (others.length) {
      const sameFile = others.every((o) => o.fromC === mv.fromC)
      const sameRank = others.every((o) => o.fromR === mv.fromR)
      if (!sameFile) s += FILES[mv.fromC]
      else if (!sameRank) s += String(8 - mv.fromR)
      else s += FILES[mv.fromC] + String(8 - mv.fromR)
    }
  }

  if (mv.captured && mv.captured !== '.') {
    if (isPawn) s += FILES[mv.fromC] // 兵吃子带起点文件，如 exd5
    s += 'x'
  }

  s += square(mv.toR, mv.toC)

  if (mv.special === SPECIAL.PROMOTION) s += '=' + mv.promotion.toUpperCase()

  return s
}

// 组装 PGN 文本（7 标签头 + 着法正文 + 结果）
//   meta      : { event, date, white, black }
//   sanMoves  : 已含 +/-# 后缀的 SAN 着法数组
//   result    : '1-0' / '0-1' / '1/2-1/2' / '*'
export function buildPgn(meta, sanMoves, result) {
  const headers = [
    ['Event', meta.event || 'board-replay'],
    ['Site', 'board-replay'],
    ['Date', meta.date || '????.??.??'],
    ['White', meta.white || '?'],
    ['Black', meta.black || '?'],
    ['Result', result],
  ]
  let h = ''
  for (const [k, v] of headers) h += `[${k} "${v}"]\n`

  let text = ''
  let n = 1
  for (let i = 0; i < sanMoves.length; i += 2) {
    const w = sanMoves[i]
    const b = sanMoves[i + 1]
    text += `${n}. ${w}${b ? ' ' + b : ''} `
    n++
  }
  text += result

  return h + '\n' + text.trimEnd() + '\n'
}
