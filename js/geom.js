// 形の計算(DOM に触れない)。長さは mm、角度は度。x は右、y は下。

const EPS = 1e-6;

export function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// 符号なしの面積(靴ひも公式)
export function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

// 点から線分への最短距離とその足
export function pointToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { d: dist(p, point), point };
}

// 辺の上は true。それ以外は交差数(偶奇)で判定
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (pointToSegment(p, a, b).d < EPS) return true;
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// 3点の向き(外積の符号)。ほぼ一直線なら 0
function orient(a, b, c) {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(v) < EPS ? 0 : Math.sign(v);
}

// 互いをまたいで交わるときだけ true(端点だけの接触・一直線上の重なりは false)
export function segmentsIntersect(a1, a2, b1, b2) {
  const d1 = orient(b1, b2, a1), d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1), d4 = orient(a1, a2, b2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// 3点以上・面積>0・隣り合わない辺どうしが交差しない
export function isSimplePolygon(poly) {
  const n = poly.length;
  if (n < 3 || polygonArea(poly) < EPS) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // 最初と最後の辺は隣り合う
      if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

// 中心 x,y の四角の4つの角(回り順)。rotationDeg 0 で width が x 方向
export function rectCorners({ x, y, width, depth, rotationDeg }) {
  const r = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const hw = width / 2, hd = depth / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => ({
    x: x + u * cos - v * sin,
    y: y + u * sin + v * cos,
  }));
}

// 分離軸。どの軸でも重なりが 0.5mm を超えるときだけ重なりとみなす
export function rectsOverlap(r1, r2) {
  const c1 = rectCorners(r1), c2 = rectCorners(r2);
  for (const c of [c1, c2]) {
    for (let i = 0; i < 2; i++) {
      const ex = c[i + 1].x - c[i].x, ey = c[i + 1].y - c[i].y;
      const len = Math.hypot(ex, ey);
      if (len === 0) continue;
      const ax = -ey / len, ay = ex / len; // 辺に垂直な単位ベクトル
      const proj = (pts) => pts.map((p) => p.x * ax + p.y * ay);
      const p1 = proj(c1), p2 = proj(c2);
      const overlap = Math.min(Math.max(...p1), Math.max(...p2)) - Math.max(Math.min(...p1), Math.min(...p2));
      if (overlap <= 0.5) return false;
    }
  }
  return true;
}

const INSIDE_TOL = 0.5; // 壁にぴったり付けた家具をはみ出しとしない許容(mm)

// 多角形(凹んでいてもよい)を凸の多角形で切り取る(Sutherland–Hodgman)。
// 切り取った形の面積は「多角形 ∩ 凸の多角形」の面積に等しい(凹んだ多角形では幅0の辺が残ることがあるが面積は変わらない)
function clipByConvex(subject, convex) {
  // 凸の多角形の向き(回り順)に合わせて「内側」の符号を決める
  let s = 0;
  for (let i = 0; i < convex.length; i++) {
    const a = convex[i], b = convex[(i + 1) % convex.length];
    s += a.x * b.y - b.x * a.y;
  }
  const sign = s >= 0 ? 1 : -1;
  let out = subject;
  for (let i = 0; i < convex.length && out.length; i++) {
    const a = convex[i], b = convex[(i + 1) % convex.length];
    const side = (p) => sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
      }
    }
  }
  return out;
}

// 家具の四角が部屋の内側にあるか。四角を各辺 0.5mm ずつ内へ縮め、部屋で切り取った面積が四角の面積と等しければ内側。
// 角・辺が境界に接しているだけでも、四角の一部が部屋の外(柱の出っ張り・L字の欠け)を覆えば面積が減るので外になる
export function rectInsidePolygon(r, poly) {
  const w = r.width - 2 * INSIDE_TOL, d = r.depth - 2 * INSIDE_TOL;
  if (!(w > 0 && d > 0)) return pointInPolygon({ x: r.x, y: r.y }, poly); // 1mm 以下の大きさは中心だけで判断する
  const c = rectCorners({ ...r, width: w, depth: d });
  const area = w * d;
  const inter = polygonArea(clipByConvex(poly, c));
  return inter >= area * (1 - 1e-9) - 1e-6;
}

// i 番目の壁(i 番目の点から次の点まで)
export function wallOf(poly, i) {
  const a = poly[i], b = poly[(i + 1) % poly.length];
  return { a, b, length: dist(a, b), angleDeg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
}
