// src/core/chess_engine.mjs
// VENORED VERBATIM from lab/tournament/engine.mjs (the cross-language chess
// tournament runner's authoritative rules engine). Replay positions produced
// here are therefore BIT-IDENTICAL to the runner. Only the top-level
// `if (process.argv[2] === 'test')` auto-run guard was removed so this file is
// import-safe; `runPerftSelfTest()` is kept exported for board-replay's smoke
// test. Do NOT edit the rules below — re-sync from the lab source instead.
//
// Independent, zero-dependency chess rules engine used by the cross-language
// tournament runner. It is intentionally SEPARATE from the 10 language engines:
// it maintains the authoritative board, applies the moves the engines pick, and
// decides terminal/draw outcomes.
//
// Design follows port_spec.txt exactly (board model, offset tables, castling /
// en-passant / halfmove rules). The legal-move filter (make-then-check) is the
// single source of truth, so pinned pieces and en-passant check reveals are
// handled generically.
//
// Correctness is backed by a perft self-test against perft_spec.txt golden
// values: `node engine.mjs test`.

// ---- move special enum ----
export const SPECIAL = {
  NONE: 0,
  DOUBLE_PAWN: 1,
  EN_PASSANT: 2,
  CASTLE_KINGSIDE: 3,
  CASTLE_QUEENSIDE: 4,
  PROMOTION: 5,
};

const KNIGHT = [[-2,-2,-1,-1,1,1,2,2],[-1,1,-2,2,-2,2,-1,1]];
const KING = [[-1,-1,-1,0,0,1,1,1],[-1,0,1,-1,1,-1,0,1]];
const ROOK_DIRS = [[-1,0],[1,0],[0,-1],[0,1]];
const BISHOP_DIRS = [[-1,-1],[-1,1],[1,-1],[1,1]];

export function inBoard(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
export function isUpper(p) { return p >= 'A' && p <= 'Z'; }
export function isLower(p) { return p >= 'a' && p <= 'z'; }
export function isWhitePiece(p) { return p !== '.' && isUpper(p); }
export function isBlackPiece(p) { return p !== '.' && isLower(p); }
function isEnemy(p, isWhite) { return p !== '.' && (isWhite ? isLower(p) : isUpper(p)); }

// ---- FEN ----
export function parseFen(fen) {
  const parts = fen.trim().split(/\s+/);
  const placement = parts[0];
  const side = parts[1] || 'w';
  const castling = parts[2] || '-';
  const ep = parts[3] || '-';
  const halfmove = parts[4] !== undefined ? parseInt(parts[4], 10) : 0;
  const fullmove = parts[5] !== undefined ? parseInt(parts[5], 10) : 1;

  const board = [];
  for (let r = 0; r < 8; r++) board.push(new Array(8).fill('.'));
  let r = 0, c = 0;
  for (const ch of placement) {
    if (ch === '/') { r++; c = 0; continue; }
    if (ch >= '1' && ch <= '9') { c += parseInt(ch, 10); continue; }
    board[r][c] = ch;
    c++;
  }
  const state = {
    board,
    whiteToMove: side === 'w',
    castling: {
      wk: castling.includes('K'),
      wq: castling.includes('Q'),
      bk: castling.includes('k'),
      bq: castling.includes('q'),
    },
    ep: null,
    halfmove,
    fullmove,
    keys: [],
  };
  if (ep !== '-' && ep.length === 2) {
    state.ep = { col: ep.charCodeAt(0) - 97, row: 8 - parseInt(ep[1], 10) };
  }
  state.keys = [getPositionKey(state)];
  return state;
}

export function serializeFen(state) {
  const b = state.board;
  let placement = '';
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = b[r][c];
      if (p === '.') empty++;
      else { if (empty) { placement += empty; empty = 0; } placement += p; }
    }
    if (empty) placement += empty;
    if (r < 7) placement += '/';
  }
  const ca = state.castling;
  let cast = '';
  if (ca.wk) cast += 'K';
  if (ca.wq) cast += 'Q';
  if (ca.bk) cast += 'k';
  if (ca.bq) cast += 'q';
  if (!cast) cast = '-';
  let ep = '-';
  if (state.ep) {
    ep = String.fromCharCode(97 + state.ep.col) + (8 - state.ep.row);
  }
  return `${placement} ${state.whiteToMove ? 'w' : 'b'} ${cast} ${ep} ${state.halfmove} ${state.fullmove}`;
}

export function getPositionKey(state) {
  let s = '';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) s += state.board[r][c];
  s += state.whiteToMove ? 'w' : 'b';
  const ca = state.castling;
  s += (ca.wk ? 'K' : '') + (ca.wq ? 'Q' : '') + (ca.bk ? 'k' : '') + (ca.bq ? 'q' : '');
  s += state.ep ? `${state.ep.row},${state.ep.col}` : '-1,-1';
  return s;
}

export function cloneState(state) {
  return {
    board: state.board.map((row) => row.slice()),
    whiteToMove: state.whiteToMove,
    castling: { ...state.castling },
    ep: state.ep ? { ...state.ep } : null,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
    keys: state.keys ? state.keys.slice() : [],
  };
}

export function findKing(board, isWhite) {
  const target = isWhite ? 'K' : 'k';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === target) return [r, c];
  return [-1, -1];
}

// Is square (r,c) attacked by side `byWhite`?
export function isAttacked(board, r, c, byWhite) {
  // pawn attacks
  const pr = byWhite ? r + 1 : r - 1;
  if (inBoard(pr, c - 1) && board[pr][c - 1] === (byWhite ? 'P' : 'p')) return true;
  if (inBoard(pr, c + 1) && board[pr][c + 1] === (byWhite ? 'P' : 'p')) return true;
  // knight
  for (let i = 0; i < 8; i++) {
    const tr = r + KNIGHT[0][i], tc = c + KNIGHT[1][i];
    if (inBoard(tr, tc) && board[tr][tc] === (byWhite ? 'N' : 'n')) return true;
  }
  // king
  for (let i = 0; i < 8; i++) {
    const tr = r + KING[0][i], tc = c + KING[1][i];
    if (inBoard(tr, tc) && board[tr][tc] === (byWhite ? 'K' : 'k')) return true;
  }
  // sliding: rook/queen (straight)
  for (const [dr, dc] of ROOK_DIRS) {
    let tr = r + dr, tc = c + dc;
    while (inBoard(tr, tc)) {
      const p = board[tr][tc];
      if (p !== '.') {
        if (byWhite ? (p === 'R' || p === 'Q') : (p === 'r' || p === 'q')) return true;
        break;
      }
      tr += dr; tc += dc;
    }
  }
  // sliding: bishop/queen (diagonal)
  for (const [dr, dc] of BISHOP_DIRS) {
    let tr = r + dr, tc = c + dc;
    while (inBoard(tr, tc)) {
      const p = board[tr][tc];
      if (p !== '.') {
        if (byWhite ? (p === 'B' || p === 'Q') : (p === 'b' || p === 'q')) return true;
        break;
      }
      tr += dr; tc += dc;
    }
  }
  return false;
}

function generatePawnMoves(state, r, c, isWhite) {
  const b = state.board;
  const dir = isWhite ? -1 : 1;
  const startRow = isWhite ? 6 : 1;
  const promoRow = isWhite ? 0 : 7;
  const promos = isWhite ? ['Q', 'R', 'B', 'N'] : ['q', 'r', 'b', 'n'];
  const moves = [];
  const from = { r, c };
  // forward 1
  const fr = r + dir;
  if (inBoard(fr, c) && b[fr][c] === '.') {
    if (fr === promoRow) {
      for (const pp of promos) moves.push({ fromR: r, fromC: c, toR: fr, toC: c, piece: b[r][c], captured: '.', special: SPECIAL.PROMOTION, promotion: pp });
    } else {
      moves.push({ fromR: r, fromC: c, toR: fr, toC: c, piece: b[r][c], captured: '.', special: SPECIAL.NONE, promotion: '.' });
    }
  }
  // forward 2
  if (r === startRow) {
    const fr2 = r + 2 * dir;
    if (b[fr][c] === '.' && b[fr2][c] === '.') {
      moves.push({ fromR: r, fromC: c, toR: fr2, toC: c, piece: b[r][c], captured: '.', special: SPECIAL.DOUBLE_PAWN, promotion: '.' });
    }
  }
  // captures + en passant
  for (const dc of [-1, 1]) {
    const tr = r + dir, tc = c + dc;
    if (!inBoard(tr, tc)) continue;
    const target = b[tr][tc];
    if (target !== '.' && isEnemy(target, isWhite)) {
      if (tr === promoRow) {
        for (const pp of promos) moves.push({ fromR: r, fromC: c, toR: tr, toC: tc, piece: b[r][c], captured: target, special: SPECIAL.PROMOTION, promotion: pp });
      } else {
        moves.push({ fromR: r, fromC: c, toR: tr, toC: tc, piece: b[r][c], captured: target, special: SPECIAL.NONE, promotion: '.' });
      }
    } else if (state.ep && tr === state.ep.row && tc === state.ep.col) {
      moves.push({ fromR: r, fromC: c, toR: tr, toC: tc, piece: b[r][c], captured: isWhite ? 'p' : 'P', special: SPECIAL.EN_PASSANT, promotion: '.' });
    }
  }
  return moves;
}

function generateOffsetMoves(state, r, c, offsets, isWhite, piece) {
  const b = state.board;
  const moves = [];
  for (let i = 0; i < offsets[0].length; i++) {
    const tr = r + offsets[0][i], tc = c + offsets[1][i];
    if (!inBoard(tr, tc)) continue;
    const target = b[tr][tc];
    if (target === '.') {
      moves.push({ fromR: r, fromC: c, toR: tr, toC: tc, piece, captured: '.', special: SPECIAL.NONE, promotion: '.' });
    } else if (isEnemy(target, isWhite)) {
      moves.push({ fromR: r, fromC: c, toR: tr, toC: tc, piece, captured: target, special: SPECIAL.NONE, promotion: '.' });
    }
  }
  return moves;
}

function generateSlidingMoves(state, r, c, dirs, isWhite, piece) {
  const b = state.board;
  const moves = [];
  for (const [dr, dc] of dirs) {
    let tr = r + dr, tc = c + dc;
    while (inBoard(tr, tc)) {
      const target = b[tr][tc];
      if (target === '.') {
        moves.push({ fromR: r, fromC: c, toR: tr, toC: tc, piece, captured: '.', special: SPECIAL.NONE, promotion: '.' });
      } else {
        if (isEnemy(target, isWhite)) moves.push({ fromR: r, fromC: c, toR: tr, toC: tc, piece, captured: target, special: SPECIAL.NONE, promotion: '.' });
        break;
      }
      tr += dr; tc += dc;
    }
  }
  return moves;
}

function generateCastlingMoves(state, r, c, isWhite) {
  const b = state.board;
  const ca = state.castling;
  const moves = [];
  const enemy = !isWhite;
  if (isWhite) {
    if (ca.wk && b[7][7] === 'R' && b[7][5] === '.' && b[7][6] === '.' &&
        !isAttacked(b, 7, 4, enemy) && !isAttacked(b, 7, 5, enemy) && !isAttacked(b, 7, 6, enemy)) {
      moves.push({ fromR: 7, fromC: 4, toR: 7, toC: 6, piece: 'K', captured: '.', special: SPECIAL.CASTLE_KINGSIDE, promotion: '.' });
    }
    if (ca.wq && b[7][0] === 'R' && b[7][1] === '.' && b[7][2] === '.' && b[7][3] === '.' &&
        !isAttacked(b, 7, 4, enemy) && !isAttacked(b, 7, 3, enemy) && !isAttacked(b, 7, 2, enemy)) {
      moves.push({ fromR: 7, fromC: 4, toR: 7, toC: 2, piece: 'K', captured: '.', special: SPECIAL.CASTLE_QUEENSIDE, promotion: '.' });
    }
  } else {
    if (ca.bk && b[0][7] === 'r' && b[0][5] === '.' && b[0][6] === '.' &&
        !isAttacked(b, 0, 4, enemy) && !isAttacked(b, 0, 5, enemy) && !isAttacked(b, 0, 6, enemy)) {
      moves.push({ fromR: 0, fromC: 4, toR: 0, toC: 6, piece: 'k', captured: '.', special: SPECIAL.CASTLE_KINGSIDE, promotion: '.' });
    }
    if (ca.bq && b[0][0] === 'r' && b[0][1] === '.' && b[0][2] === '.' && b[0][3] === '.' &&
        !isAttacked(b, 0, 4, enemy) && !isAttacked(b, 0, 3, enemy) && !isAttacked(b, 0, 2, enemy)) {
      moves.push({ fromR: 0, fromC: 4, toR: 0, toC: 2, piece: 'k', captured: '.', special: SPECIAL.CASTLE_QUEENSIDE, promotion: '.' });
    }
  }
  return moves;
}

export function generatePseudoMoves(state, r, c) {
  const b = state.board;
  const p = b[r][c];
  if (p === '.') return [];
  const isWhite = isWhitePiece(p);
  const t = p.toUpperCase();
  switch (t) {
    case 'P': return generatePawnMoves(state, r, c, isWhite);
    case 'N': return generateOffsetMoves(state, r, c, KNIGHT, isWhite, p);
    case 'K': return [...generateOffsetMoves(state, r, c, KING, isWhite, p), ...generateCastlingMoves(state, r, c, isWhite)];
    case 'B': return generateSlidingMoves(state, r, c, BISHOP_DIRS, isWhite, p);
    case 'R': return generateSlidingMoves(state, r, c, ROOK_DIRS, isWhite, p);
    case 'Q': return generateSlidingMoves(state, r, c, [...ROOK_DIRS, ...BISHOP_DIRS], isWhite, p);
    default: return [];
  }
}

export function generateAllLegalMoves(state) {
  const b = state.board;
  const moverWhite = state.whiteToMove;
  const pseudo = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = b[r][c];
      if (p === '.') continue;
      if (moverWhite ? isWhitePiece(p) : isBlackPiece(p)) {
        pseudo.push(...generatePseudoMoves(state, r, c));
      }
    }
  }
  const legal = [];
  for (const m of pseudo) {
    const after = applyMove(state, m, false);
    const [kr, kc] = findKing(after.board, moverWhite);
    if (!isAttacked(after.board, kr, kc, !moverWhite)) legal.push(m);
  }
  return legal;
}

export function applyMove(state, m, recordHistory = true) {
  const s = cloneState(state);
  const b = s.board;
  const piece = m.piece;
  b[m.toR][m.toC] = piece;
  b[m.fromR][m.fromC] = '.';

  if (m.special === SPECIAL.EN_PASSANT) {
    const capRow = piece === 'P' ? m.toR + 1 : m.toR - 1;
    b[capRow][m.toC] = '.';
  } else if (m.special === SPECIAL.CASTLE_KINGSIDE) {
    b[m.fromR][5] = b[m.fromR][7];
    b[m.fromR][7] = '.';
  } else if (m.special === SPECIAL.CASTLE_QUEENSIDE) {
    b[m.fromR][3] = b[m.fromR][0];
    b[m.fromR][0] = '.';
  }
  if (m.special === SPECIAL.PROMOTION) {
    b[m.toR][m.toC] = m.promotion;
  }

  // castling rights
  if (piece === 'K') { s.castling.wk = false; s.castling.wq = false; }
  else if (piece === 'k') { s.castling.bk = false; s.castling.bq = false; }
  const clearCorner = (rr, cc) => {
    if (rr === 7 && cc === 0) s.castling.wq = false;
    if (rr === 7 && cc === 7) s.castling.wk = false;
    if (rr === 0 && cc === 0) s.castling.bq = false;
    if (rr === 0 && cc === 7) s.castling.bk = false;
  };
  clearCorner(m.fromR, m.fromC);
  clearCorner(m.toR, m.toC);

  // halfmove clock
  if (piece.toUpperCase() === 'P' || m.captured !== '.') s.halfmove = 0;
  else s.halfmove += 1;

  // en passant target
  s.ep = m.special === SPECIAL.DOUBLE_PAWN ? { row: (m.fromR + m.toR) / 2, col: m.fromC } : null;

  // fullmove + side
  if (!s.whiteToMove) s.fullmove += 1;
  s.whiteToMove = !s.whiteToMove;

  if (recordHistory) {
    s.keys.push(getPositionKey(s));
  }
  return s;
}

export function isCheck(state, isWhite) {
  const [kr, kc] = findKing(state.board, isWhite);
  return isAttacked(state.board, kr, kc, !isWhite);
}

export function isCheckmate(state) {
  const side = state.whiteToMove;
  return isCheck(state, side) && generateAllLegalMoves(state).length === 0;
}

export function isStalemate(state) {
  const side = state.whiteToMove;
  return !isCheck(state, side) && generateAllLegalMoves(state).length === 0;
}

export function isFiftyMoveDraw(state) { return state.halfmove >= 100; }

export function isThreefold(state) {
  if (!state.keys || state.keys.length === 0) return false;
  const last = state.keys[state.keys.length - 1];
  return state.keys.filter((k) => k === last).length >= 3;
}

export function isInsufficientMaterial(state) {
  const b = state.board;
  let w = 0, bl = 0;
  const pieces = { w: [], b: [] };
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = b[r][c];
    if (p === '.' || p === 'K' || p === 'k') continue;
    if (isWhitePiece(p)) { w++; pieces.w.push(p); }
    else { bl++; pieces.b.push(p); }
  }
  for (const p of [...pieces.w, ...pieces.b]) {
    if (p === 'P' || p === 'R' || p === 'Q' || p === 'p' || p === 'r' || p === 'q') return false;
  }
  const total = w + bl;
  if (total <= 1) return true;
  if (total === 2) {
    if (w === 1 && bl === 1) return true; // K+minor vs K+minor
    // same side has two pieces
    if (w === 2 || bl === 2) {
      const two = w === 2 ? pieces.w : pieces.b;
      if (two.length === 2 && two[0] === 'B' && two[1] === 'B') {
        // both bishops: draw only if same-colored squares
        // recompute square colors
        let sameColor = true;
        let first = -1;
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
          const p = b[r][c];
          if ((w === 2 && isWhitePiece(p) && p === 'B') || (bl === 2 && isBlackPiece(p) && p === 'b')) {
            const col = (r + c) % 2;
            if (first === -1) first = col; else if (col !== first) sameColor = false;
          }
        }
        return sameColor;
      }
      if (two.length === 2 && two[0] === 'N' && two[1] === 'N') return true; // NN
    }
  }
  return false;
}

export function isDraw(state) {
  return isFiftyMoveDraw(state) || isThreefold(state) || isInsufficientMaterial(state);
}

// Apply a UCI move (e.g. "e2e4" or "e7e8q") to a state; returns new state.
export function applyUci(state, uci) {
  const fromCol = uci.charCodeAt(0) - 97;
  const fromRow = 8 - parseInt(uci[1], 10);
  const toCol = uci.charCodeAt(2) - 97;
  const toRow = 8 - parseInt(uci[3], 10);
  const promoChar = uci.length > 4 ? uci[4].toUpperCase() : '.';
  const moves = generateAllLegalMoves(state);
  for (const m of moves) {
    if (m.fromR === fromRow && m.fromC === fromCol && m.toR === toRow && m.toC === toCol) {
      if (m.special === SPECIAL.PROMOTION) {
        if (m.promotion.toUpperCase() === promoChar) return applyMove(state, m, true);
      } else if (promoChar === '.') {
        return applyMove(state, m, true);
      }
    }
  }
  throw new Error(`illegal or unknown UCI move: ${uci} (from ${serializeFen(state)})`);
}

export function moveToUci(m) {
  const files = 'abcdefgh';
  let u = files[m.fromC] + (8 - m.fromR) + files[m.toC] + (8 - m.toR);
  if (m.special === SPECIAL.PROMOTION) u += m.promotion.toLowerCase();
  return u;
}

// ---- perft (for self-test) ----
export function perft(state, depth) {
  if (depth === 0) return 1;
  const moves = generateAllLegalMoves(state);
  if (depth === 1) return moves.length;
  let count = 0;
  for (const m of moves) {
    count += perft(applyMove(state, m, false), depth - 1);
  }
  return count;
}

// ---- self-test against perft_spec.txt golden values ----
const PERFT_TESTS = [
  { name: 'Start', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', depth: 3, expected: 8902 },
  { name: 'Start', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', depth: 4, expected: 197281 },
  { name: 'Kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', depth: 3, expected: 97862 },
  { name: 'Wiki3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', depth: 4, expected: 43238 },
  { name: 'Wiki5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 0 1', depth: 3, expected: 62379 },
];

export function runPerftSelfTest() {
  let pass = 0, fail = 0;
  const lines = ['=== tournament/engine.mjs perft self-test (perft_spec.txt golden values) ==='];
  for (const t of PERFT_TESTS) {
    const state = parseFen(t.fen);
    const start = Date.now();
    const got = perft(state, t.depth);
    const ms = Date.now() - start;
    const ok = got === t.expected;
    if (ok) pass++; else fail++;
    lines.push(`[${ok ? 'PASS' : 'FAIL'}] ${t.name} d${t.depth}  expected=${t.expected}  got=${got}  (${ms}ms)`);
  }
  lines.push(`${pass} passed, ${fail} failed`);
  return { pass, fail, text: lines.join('\n') };
}

// Self-test entry removed (this file is imported as a library module).
// Run via `node -e "import('./src/core/chess_engine.mjs').then(m=>{const r=m.runPerftSelfTest();console.log(r.text);process.exit(r.fail?1:0)})"`
// or through board-replay's smoke test.
