// 吸着(純粋)。長さは mm、角度は度。x は右、y は下。
import { dist, rectCorners } from './geom.js';

const PARALLEL = Math.sin((0.5 * Math.PI) / 180);   // 平行とみなす角度の差(0.5度)

// 部屋を描くときの点。既存の角を最優先、次に1つ前の点と水平・垂直
export function snapDrawPoint(p, { prev = null, vertices = [], tolerance = 0 } = {}) {
  let best = null, bestD = Infinity;
  for (const v of vertices) {
    const d = dist(p, v);
    if (d <= tolerance && d < bestD) { best = v; bestD = d; }
  }
  if (best) return { x: best.x, y: best.y, snapped: 'vertex' };
  if (prev) {
    const dx = Math.abs(p.x - prev.x), dy = Math.abs(p.y - prev.y);
    // 両方が範囲内なら、ずれの小さい方だけを合わせる
    if (dy <= tolerance && (dy <= dx || dx > tolerance)) return { x: p.x, y: prev.y, snapped: 'axis' };
    if (dx <= tolerance) return { x: prev.x, y: p.y, snapped: 'axis' };
  }
  return { x: p.x, y: p.y, snapped: null };
}

// 90度の倍数でぴったり 0 になるように丸めた cos・sin
function axes(rotationDeg) {
  const r = (rotationDeg * Math.PI) / 180;
  const clean = v => (Math.abs(v) < 1e-12 ? 0 : v);
  const c = clean(Math.cos(r)), s = clean(Math.sin(r));
  return { u: { x: c, y: s }, v: { x: -s, y: c } };   // u: 幅の方向、v: 奥行の方向
}

const dot = (a, b) => a.x * b.x + a.y * b.y;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });

// 四角の4辺(線分)
function rectEdges(rect) {
  const c = rectCorners(rect);
  return c.map((a, i) => ({ a, b: c[(i + 1) % 4] }));
}

// 家具の辺を、壁と他の家具の辺にぴったり付ける。
// 幅の方向(u)と奥行の方向(v)を別々に判定する(回転 0 なら x と y)
export function snapPlacement(rect, { room = [], others = [], tolerance = 0, enabled = true } = {}) {
  if (!enabled) return { x: rect.x, y: rect.y, guides: [] };
  const { u, v } = axes(rect.rotationDeg || 0);
  const hw = rect.width / 2, hd = rect.depth / 2;
  const center = { x: rect.x, y: rect.y };

  const targets = [];
  for (let i = 0; i < room.length; i++) targets.push({ a: room[i], b: room[(i + 1) % room.length] });
  for (const o of others) targets.push(...rectEdges(o));

  // 1つの方向(axis)について、両側の辺から最も近い吸着先を探す
  function best(axis, half, along, halfAlong) {
    let pick = null;
    for (const sign of [-1, 1]) {
      const n = { x: axis.x * sign, y: axis.y * sign };            // 辺の外向き
      const mid = { x: center.x + n.x * half, y: center.y + n.y * half };
      const sMid = dot(mid, along);
      for (const t of targets) {
        const e = sub(t.b, t.a);
        const len = Math.hypot(e.x, e.y);
        if (len === 0) continue;
        if (Math.abs(e.x * n.x + e.y * n.y) / len > PARALLEL) continue;   // 辺と平行なものだけ
        const d = dot(sub(t.a, mid), n);                              // 外向きに測った距離
        if (Math.abs(d) > tolerance) continue;
        // 辺の方向に重なっていること
        const ta = dot(t.a, along), tb = dot(t.b, along);
        const overlap = Math.min(sMid + halfAlong, Math.max(ta, tb)) - Math.max(sMid - halfAlong, Math.min(ta, tb));
        if (overlap < 0) continue;
        if (!pick || Math.abs(d) < Math.abs(pick.shift)) pick = { shift: d * sign, guide: { a: t.a, b: t.b } };
      }
    }
    return pick;
  }

  const su = best(u, hw, v, hd);   // 左右の辺(u 方向に動かす)
  const sv = best(v, hd, u, hw);   // 前後の辺(v 方向に動かす)
  const du = su ? su.shift : 0, dv = sv ? sv.shift : 0;
  return {
    x: rect.x + du * u.x + dv * v.x,
    y: rect.y + du * u.y + dv * v.y,
    guides: [su, sv].filter(Boolean).map(s => s.guide),
  };
}

// 角度を step 刻みに丸め、0〜359 にそろえる
export function snapAngle(deg, step = 15) {
  const v = Math.round(deg / step) * step;
  return (((v % 360) + 360) % 360) || 0;
}
