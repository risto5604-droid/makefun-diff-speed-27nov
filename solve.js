// A faster drop-in for makefun-diff 1.0.0 (MIT): run(input) returns make.fun's own
// patch of { old, new } exactly as makefun-diff 1.0.0 does, but computed with an
// integer-id Myers search over typed arrays instead of jsdiff's linked path objects.
//
// The rule, restated from makefun-diff's header: lines are cut after every "\n"
// (a "\r" is part of its line; a last line with no "\n" is a line too). The common
// prefix of lines is kept, then the common suffix of what is left; between them
// Myers's greedy search from the first lines, keeping on each diagonal the path
// reaching furthest into the old text and, when a deletion and an insertion reach
// the same point, the deletion's; never moving past either text's end, pruning no
// edge diagonal, following every run of equal lines as far as it goes; the first
// path to reach both ends is the script. The patch header and hunks follow the
// same rule (3 kept lines of context, runs at most 6 kept lines apart share a
// hunk, deletions before insertions in a run, "%" after a line with no newline).
//
// Speed plan:
// - Lines are interned to small integer ids in one pass per text (line bounds
//   found with indexOf, ids from an open-addressing table keyed by an FNV-1a
//   hash of the line's code units, verified exactly by string comparison, so
//   two lines share an id exactly when they are the same code units). Every
//   comparison in the search is then an integer compare. Interning also counts
//   each id per text, giving a lower bound LB on the edit distance (the
//   multiset difference), which sits a stable ~1.7x below the true distance
//   on this generator's cases.
// - The search runs banded: the true path's diagonal k at depth d must satisfy
//   |k - (n-m)| <= D - d, where D is the edit distance, so with a cap D1 >= D
//   the diagonals outside [n-m-(D1-d), n-m+(D1-d)] can be skipped without
//   changing the path the search finds (every diagonal the reference path and
//   its decisions touch stays inside the band). The cap starts at 1.9 * LB
//   and grows on failure; an unbanded run is the final fallback, so the answer
//   is exact whatever the cap does.
// - Each depth's furthest-x values live in one Int32Array holding x+1 (0 means
//   no path), so a fresh array needs no fill, and only the band's width is
//   allocated. Backtracking re-decides each move with the same tie-break the
//   forward pass used, and the snake length is the difference between the
//   stored point and the post-move point, so the recovered script is the
//   forward search's script, line for line.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;
const CONTEXT = 3;

/**
 * Intern every line of both texts to a small integer id, shared across the two.
 * Returns the id arrays, the line boundaries, and LB, the multiset-difference
 * lower bound on the edit distance. Line equality is exact: a hash hit is
 * verified by comparing the two lines' code units (slice + ===).
 */
function intern(aText, bText) {
  const texts = [aText, bText];
  const counts = [];
  const starts = [];
  const ends = [];
  const ids = [];
  for (let t = 0; t < 2; t++) {
    const text = texts[t];
    // Count the lines first so the arrays are exact-sized.
    let n = 0;
    let s = 0;
    while (s < text.length) {
      const nl = text.indexOf('\n', s);
      if (nl === -1) break;
      n++;
      s = nl + 1;
    }
    if (s < text.length) n++;
    counts.push(n);
  }
  const total = counts[0] + counts[1];
  let size = 1;
  while (size < total * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size); // id+1, 0 = empty
  const idText = new Int8Array(total);
  const idStart = new Int32Array(total);
  const idEnd = new Int32Array(total);
  const ca = new Int32Array(total);
  const cb = new Int32Array(total);
  let next = 0;
  for (let t = 0; t < 2; t++) {
    const text = texts[t];
    const n = counts[t];
    const st = new Int32Array(n);
    const en = new Int32Array(n);
    const out = new Int32Array(n);
    const cnt = t === 0 ? ca : cb;
    let i = 0;
    let s = 0;
    while (s < text.length) {
      const nl = text.indexOf('\n', s);
      const e = nl === -1 ? text.length : nl + 1;
      st[i] = s;
      en[i] = e;
      let h = 2166136261;
      for (let j = s; j < e; j++) {
        h ^= text.charCodeAt(j);
        h = Math.imul(h, 16777619);
      }
      let slot = (h >>> 0) & mask;
      for (;;) {
        const found = table[slot];
        if (found === 0) {
          const id = next++;
          table[slot] = id + 1;
          idText[id] = t;
          idStart[id] = s;
          idEnd[id] = e;
          out[i] = id;
          cnt[id]++;
          break;
        }
        const id = found - 1;
        const rs = idStart[id];
        const re = idEnd[id];
        if (re - rs === e - s && text.slice(s, e) === texts[idText[id]].slice(rs, re)) {
          out[i] = id;
          cnt[id]++;
          break;
        }
        slot = (slot + 1) & mask;
      }
      i++;
      s = e;
    }
    starts.push(st);
    ends.push(en);
    ids.push(out);
  }
  let lb = 0;
  for (let id = 0; id < next; id++) lb += ca[id] > cb[id] ? ca[id] - cb[id] : cb[id] - ca[id];
  return { aIds: ids[0], bIds: ids[1], aStart: starts[0], aEnd: ends[0], bStart: starts[1], bEnd: ends[1], na: counts[0], nb: counts[1], lb };
}

/**
 * The forward greedy search on the middle slices aIds[ao..ao+n) into
 * bIds[bo..bo+m), with an optional cap D1 on the edit distance: diagonals
 * outside the band the true path must stay in are skipped. Returns the
 * per-depth furthest-x arrays (x+1, 0 = no path), their low diagonals, and
 * the depth and diagonal where the search reached both ends; or null when the
 * cap is too small (the search ran out to the cap without reaching the end).
 * With cap null the search is unbanded, exactly makefun-diff's search.
 */
function myersSearch(aIds, ao, n, bIds, bo, m, cap) {
  const kend = n - m;
  const Vs = [];
  const Vlo = [];

  // d = 0: the initial snake from (0, 0); only diagonal 0 exists.
  let x = 0;
  while (x < n && x < m && aIds[ao + x] === bIds[bo + x]) x++;
  const V0 = new Int32Array(5);
  V0[2] = x + 1;
  Vs.push(V0);
  Vlo.push(0);
  if (x === n && x === m) return { Vs, Vlo, D: 0, kF: 0 };

  const maxD = cap === null ? n + m : cap;
  for (let d = 1; d <= maxD; d++) {
    let lo;
    let hi;
    if (cap === null) {
      lo = -d;
      hi = d;
    } else {
      const r = cap - d;
      lo = kend - r;
      if (lo < -d) lo = -d;
      if (((lo - d) & 1) !== 0) lo++;
      hi = kend + r;
      if (hi > d) hi = d;
      if (((hi - d) & 1) !== 0) hi--;
      if (lo > hi) return null;
    }
    const Vp = Vs[d - 1];
    const vpBase = 2 - Vlo[d - 1];
    const Vc = new Int32Array(hi - lo + 5);
    const vcBase = 2 - lo;
    for (let k = lo; k <= hi; k += 2) {
      const sDel = Vp[k - 1 + vpBase];
      const sIns = Vp[k + 1 + vpBase];
      const canRemove = sDel !== 0 && sDel <= n;
      const canAdd = sIns !== 0 && sIns - k - 2 < m;
      let xx;
      if (canRemove && (!canAdd || sDel >= sIns - 1)) {
        xx = sDel; // deletion: one old line past the k-1 path (stored x+1)
      } else if (canAdd) {
        xx = sIns - 1; // insertion: the k+1 path's old count, unchanged
      } else {
        continue; // no candidate on this diagonal
      }
      let y = xx - k;
      while (xx < n && y < m && aIds[ao + xx] === bIds[bo + y]) {
        xx++;
        y++;
      }
      Vc[k + vcBase] = xx + 1;
      if (xx === n && y === m) {
        Vs.push(Vc);
        Vlo.push(lo);
        return { Vs, Vlo, D: d, kF: k };
      }
    }
    Vs.push(Vc);
    Vlo.push(lo);
  }
  return null;
}

/** Walk the depths backwards and recover the exact script the forward search chose. */
function backtrack(Vs, Vlo, D, kF, n, m) {
  const segs = [];
  let x = n;
  let k = kF;
  for (let d = D; d >= 1; d--) {
    const Vp = Vs[d - 1];
    const vpBase = 2 - Vlo[d - 1];
    const sDel = Vp[k - 1 + vpBase];
    const sIns = Vp[k + 1 + vpBase];
    const canRemove = sDel !== 0 && sDel <= n;
    const canAdd = sIns !== 0 && sIns - k - 2 < m;
    let isDel;
    if (canRemove && (!canAdd || sDel >= sIns - 1)) isDel = true;
    else if (canAdd) isDel = false;
    else throw new Error('makefun-diff: backtrack found no move');
    const xP = isDel ? sDel : sIns - 1; // the post-move point on diagonal k
    const snake = x - xP;
    if (snake > 0) segs.push([KEEP, snake]);
    if (isDel) {
      segs.push([DELETE, 1]);
      x = sDel - 1;
      k = k - 1;
    } else {
      segs.push([INSERT, 1]);
      x = sIns - 1;
      k = k + 1;
    }
  }
  if (x > 0) segs.push([KEEP, x]); // the initial snake at d = 0
  segs.reverse();
  return segs;
}

/**
 * The edit script of the middle slices: [kind, count] runs in order, exactly
 * the script makefun-diff's greedy search finds (same tie-break, same snakes).
 */
function editRuns(aIds, ao, n, bIds, bo, m, lb) {
  if (n === 0) return m === 0 ? [] : [[INSERT, m]];
  if (m === 0) return [[DELETE, n]];
  let cap = Math.ceil(lb * 1.9);
  if (cap < 128) cap = 128;
  for (let attempt = 0; attempt < 4; attempt++) {
    const found = myersSearch(aIds, ao, n, bIds, bo, m, cap);
    if (found !== null) {
      if (found.D === 0) return n > 0 ? [[KEEP, n]] : [];
      return backtrack(found.Vs, found.Vlo, found.D, found.kF, n, m);
    }
    cap = Math.ceil(cap * 1.6) + 32;
  }
  const found = myersSearch(aIds, ao, n, bIds, bo, m, null);
  if (found === null) throw new Error('makefun-diff: the search ended without reaching both ends');
  if (found.D === 0) return n > 0 ? [[KEEP, n]] : [];
  return backtrack(found.Vs, found.Vlo, found.D, found.kF, n, m);
}

/** A line as the patch writes it: its op, the line, a newline, "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const aText = input.old;
  const bText = input.new;
  const { aIds, bIds, aStart, aEnd, bStart, bEnd, na, nb, lb } = intern(aText, bText);
  const n = na;
  const m = nb;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  const mid = editRuns(aIds, prefix, n - prefix - suffix, bIds, prefix, m - prefix - suffix, lb);
  for (let i = 0; i < mid.length; i++) runs.push(mid[i]);
  if (suffix > 0) runs.push([KEEP, suffix]);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < runs.length; i++) {
    const kind = runs[i][0];
    const count = runs[i][1];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes.length === 0 ? undefined : changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const h = hunks.length === 0 ? undefined : hunks[hunks.length - 1];
    const prev = h === undefined ? undefined : h[h.length - 1];
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  const aLine = (i) => aText.slice(aStart[i], aEnd[i]);
  const bLine = (j) => bText.slice(bStart[j], bEnd[j]);
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi];
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (let ci = 0; ci < h.length; ci++) {
      const c = h[ci];
      for (; at < c.o; at++) out.push(written('=', aLine(at)));
      for (let i = 0; i < c.dels; i++) out.push(written('-', aLine(c.o + i)));
      for (let i = 0; i < c.ins; i++) out.push(written('+', bLine(c.p + i)));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', aLine(at)));
  }
  return out.join('');
}
