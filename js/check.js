// 重なり・はみ出し・ドアの警告と、すき間の計算(純粋)。長さは mm、角度は度。
import { rectCorners, rectsOverlap, rectInsidePolygon, wallOf } from './geom.js';

const EPS = 1e-6;
export const NARROW_MM = 600;   // これより狭いすき間は「狭い」と示す(通路の目安の最小幅)

// 配置の四角(中心・回転は配置、寸法は家具)
export function placementRect(placement, furniture) {
  return {
    x: placement.x, y: placement.y,
    width: furniture.width, depth: furniture.depth,
    rotationDeg: placement.rotationDeg || 0,
  };
}

// 多角形の向き(靴ひも公式の符号)。正なら内側は進行方向の左(y 下向きの座標で)
function orientation(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.sign(s) || 1;
}

// 開き戸が開く範囲。幅 × 幅 の四角を、開く側(in-*: 部屋の内側、out-*: 外側)に置く
export function doorSwingRect(room, opening) {
  if (!opening || opening.type !== 'door') return null;
  const poly = room.polygon;
  if (!poly || poly.length < 3 || opening.wallIndex < 0 || opening.wallIndex >= poly.length) return null;
  const wall = wallOf(poly, opening.wallIndex);
  if (wall.length === 0) return null;
  const t = { x: (wall.b.x - wall.a.x) / wall.length, y: (wall.b.y - wall.a.y) / wall.length };
  const o = orientation(poly);
  const inward = { x: -t.y * o, y: t.x * o };
  const side = String(opening.swing || 'in-left').startsWith('out') ? -1 : 1;
  const w = opening.width;
  const c = { x: wall.a.x + t.x * opening.offset, y: wall.a.y + t.y * opening.offset };
  return {
    x: c.x + inward.x * side * (w / 2),
    y: c.y + inward.y * side * (w / 2),
    width: w, depth: w,
    rotationDeg: wall.angleDeg,
  };
}

// 案の配置のうち、家具が台帳にあるものだけ
function resolved(house, plan) {
  const byId = new Map(house.furniture.map(f => [f.id, f]));
  const out = [];
  for (const pl of plan.placements) {
    const f = byId.get(pl.furnitureId);
    if (f) out.push({ pl, f, rect: placementRect(pl, f) });
  }
  return out;
}

const isRug = f => f.kind === 'rug';
const bottom = e => e.pl.elevation || 0;
const top = e => bottom(e) + (e.f.height || 0);

// 警告の一覧。配置ごと・種類ごと(・相手ごと)に1件
export function checkPlan(house, room, plan) {
  const items = resolved(house, plan);
  const out = [];
  const swings = (room.openings || [])
    .filter(o => o.type === 'door' && !String(o.swing || '').startsWith('out'))
    .map(o => ({ o, rect: doorSwingRect(room, o) }))
    .filter(s => s.rect);

  for (const e of items) {
    if (!rectInsidePolygon(e.rect, room.polygon)) out.push({ placementId: e.pl.id, type: 'outside' });
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (isRug(a.f) || isRug(b.f)) continue;
      if (a.f.status === 'fixed' && b.f.status === 'fixed') continue;
      if (bottom(a) >= top(b) || bottom(b) >= top(a)) continue;   // 上下に離れている
      if (!rectsOverlap(a.rect, b.rect)) continue;
      out.push({ placementId: a.pl.id, type: 'overlap', withId: b.pl.id });
      out.push({ placementId: b.pl.id, type: 'overlap', withId: a.pl.id });
    }
  }
  for (const e of items) {
    if (isRug(e.f)) continue;
    for (const s of swings) {
      if (s.o.height != null && bottom(e) >= s.o.height) continue;   // ドアより上に浮いている
      if (rectsOverlap(e.rect, s.rect)) out.push({ placementId: e.pl.id, type: 'door', withId: s.o.id });
    }
  }
  return out;
}

const cross = (a, b) => a.x * b.y - a.y * b.x;

// 点 p から方向 d へ伸ばした線が、線分 a-b に当たる距離(当たらなければ null)
function rayHit(p, d, a, b) {
  const e = { x: b.x - a.x, y: b.y - a.y };
  const denom = cross(d, e);
  if (Math.abs(denom) < EPS) return null;   // 平行
  const w = { x: a.x - p.x, y: a.y - p.y };
  const s = cross(w, e) / denom;
  const t = cross(w, d) / denom;
  if (s < -EPS || t < -EPS || t > 1 + EPS) return null;
  return Math.max(0, s);
}

const SIDES = [
  { side: 'front', u: 0, v: -1 },
  { side: 'back', u: 0, v: 1 },
  { side: 'left', u: -1, v: 0 },
  { side: 'right', u: 1, v: 0 },
];

// 各辺の中点から外向きに伸ばし、最初に当たる壁か家具までの距離
export function clearances(house, room, plan, placementId) {
  const items = resolved(house, plan);
  const me = items.find(e => e.pl.id === placementId);
  if (!me) return [];
  const r = (me.rect.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const hw = me.rect.width / 2, hd = me.rect.depth / 2;

  const segs = [];
  const poly = room.polygon;
  for (let i = 0; i < poly.length; i++) segs.push({ a: poly[i], b: poly[(i + 1) % poly.length], to: 'wall' });
  for (const e of items) {
    if (e === me || isRug(e.f)) continue;
    const c = rectCorners(e.rect);
    for (let i = 0; i < 4; i++) segs.push({ a: c[i], b: c[(i + 1) % 4], to: 'furniture' });
  }

  const out = [];
  for (const { side, u, v } of SIDES) {
    const d = { x: u * cos - v * sin, y: u * sin + v * cos };                 // 外向き
    const lu = u * hw, lv = v * hd;
    const a = { x: me.rect.x + lu * cos - lv * sin, y: me.rect.y + lu * sin + lv * cos };
    let best = null;
    for (const s of segs) {
      const hit = rayHit(a, d, s.a, s.b);
      if (hit != null && (!best || hit < best.mm)) best = { mm: hit, to: s.to };
    }
    if (best) out.push({ side, mm: best.mm, to: best.to, a, b: { x: a.x + d.x * best.mm, y: a.y + d.y * best.mm } });
  }
  return out;
}
