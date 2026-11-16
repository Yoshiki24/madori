// 間取りの編集で使う形の計算(純粋)。長さは mm。x は右、y は下
import { isSimplePolygon, wallOf } from './geom.js';

// 開口部の既定値(幅・高さ・床からの高さ)
export const OPENING_DEFAULTS = {
  door: { width: 800, height: 2000, sill: 0 },
  sliding: { width: 1600, height: 2000, sill: 0 },
  window: { width: 1650, height: 1100, sill: 900 },
  gap: { width: 900, height: 2000, sill: 0 },
};
export const OPENING_TYPES = [
  { id: 'door', label: 'ドア' },
  { id: 'sliding', label: '引き戸' },
  { id: 'window', label: '窓' },
  { id: 'gap', label: '開口' },
];

// 対角の2点 → 四角(左上から時計回り)
export function rectFromCorners(a, b) {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
}

const PERP = Math.sin((0.5 * Math.PI) / 180);   // 直角とみなすずれ(0.5度)

// i 番目の辺(polygon[i] → polygon[i+1])を length にする。終点側の角を辺の方向に動かす。
// 次の辺が直角なら、その辺の終点も同じだけ動かす(四角が四角のままになる)。
// 戻り値 { ok: true, polygon } | { ok: false, reason: 'bad-length' | 'bad-polygon' }
export function setEdgeLength(polygon, i, length) {
  if (typeof length !== 'number' || !Number.isFinite(length) || length <= 0) return { ok: false, reason: 'bad-length' };
  const n = polygon.length;
  const bi = (i + 1) % n, ci = (i + 2) % n;
  const { a, b, length: len } = wallOf(polygon, i);
  if (!len) return { ok: false, reason: 'bad-polygon' };
  const t = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const d = { x: t.x * (length - len), y: t.y * (length - len) };
  const next = polygon.map((p) => ({ x: p.x, y: p.y }));
  const move = (k) => { next[k] = { x: next[k].x + d.x, y: next[k].y + d.y }; };
  move(bi);
  if (ci !== i) {
    const e = wallOf(polygon, bi);
    if (e.length && Math.abs((e.b.x - e.a.x) * t.x + (e.b.y - e.a.y) * t.y) / e.length < PERP) move(ci);
  }
  for (let k = 0; k < n; k++) if (wallOf(next, k).length < 1) return { ok: false, reason: 'bad-polygon' };
  if (!isSimplePolygon(next)) return { ok: false, reason: 'bad-polygon' };
  return { ok: true, polygon: next };
}

// 点を i 番目の壁に投影する。offset: 壁の始点からの距離(壁の範囲に収める)、d: 壁までの距離
export function projectToWall(polygon, i, p) {
  const { a, b, length } = wallOf(polygon, i);
  if (!length) return { offset: 0, d: Math.hypot(p.x - a.x, p.y - a.y) };
  const t = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const s = (p.x - a.x) * t.x + (p.y - a.y) * t.y;
  const offset = Math.min(length, Math.max(0, s));
  const f = { x: a.x + t.x * offset, y: a.y + t.y * offset };
  return { offset, d: Math.hypot(p.x - f.x, p.y - f.y) };
}

// 開口部の中心の位置を、壁の端からはみ出さない範囲に収める
export function clampOffset(wallLength, width, offset) {
  const w = Math.min(width, wallLength);
  return Math.min(wallLength - w / 2, Math.max(w / 2, offset));
}

// 壁に新しく置く開口部の値(幅は壁の長さまで)
export function newOpening(type, wallIndex, offset, wallLength) {
  const def = OPENING_DEFAULTS[type] ?? OPENING_DEFAULTS.gap;
  const width = Math.min(def.width, wallLength);
  return { type, wallIndex, offset: clampOffset(wallLength, width, offset), width, height: def.height, sill: def.sill, swing: 'in-left' };
}

// 部屋の形を変えたあと、開口部を壁に収める。無くなった壁の開口部は外す。変わらないものは同じオブジェクト
export function fitOpenings(openings, polygon) {
  const out = [];
  for (const o of openings) {
    if (!(o.wallIndex >= 0 && o.wallIndex < polygon.length)) continue;
    const len = wallOf(polygon, o.wallIndex).length;
    const width = Math.min(o.width, len);
    const offset = clampOffset(len, width, o.offset);
    out.push(width === o.width && offset === o.offset ? o : { ...o, width, offset });
  }
  return out;
}

// 「部屋1」「2階」のような名前で、使われていない一番小さい番号
export function nextName(names, prefix, suffix) {
  const used = new Set(names);
  for (let k = 1; ; k++) if (!used.has(`${prefix}${k}${suffix}`)) return `${prefix}${k}${suffix}`;
}
