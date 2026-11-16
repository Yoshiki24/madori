// 家具の配置の計算(純粋。DOM に触れない)。長さは mm、角度は度。x は右、y は下
import { pointInPolygon, polygonArea, rectsOverlap, rectInsidePolygon, dist } from './geom.js';

export const SNAP_PX = 8;          // 吸着の許容(画面の px。拡大率で mm に直す)
export const CLICK_PX = 3;         // これより動かなければクリック(選ぶだけ)
export const NUDGE = 10;           // 矢印
export const NUDGE_BIG = 100;      // Shift + 矢印
export const DUP_OFFSET = 200;     // 複製をずらす量
export const PLACE_STEP = 200;     // 新しく置く場所がふさがっているときにずらす量
export const PLACE_TRIES = 10;     // ずらす回数
export const ROTATE_STEP = 15;     // 回転のハンドルの刻み

// 多角形の重心(面積が 0 なら点の平均)
export function centroidOf(poly) {
  const a = polygonArea(poly);
  if (!a) return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
  let cx = 0, cy = 0, s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const c = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * c; cy += (p.y + q.y) * c; s += c;
  }
  return { x: cx / (3 * s), y: cy / (3 * s) };
}

// 部屋の内側の点。重心が内側ならそれ、外(凹んだ形)なら粗い方眼で最初に見つかった内側の点
export function insidePoint(poly, step = 200) {
  const c = centroidOf(poly);
  if (pointInPolygon(c, poly)) return c;
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  for (let y = minY + step / 2; y < maxY; y += step) {
    for (let x = minX + step / 2; x < maxX; x += step) {
      if (pointInPolygon({ x, y }, poly)) return { x, y };
    }
  }
  return c;
}

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

// 新しく置く家具の中心。部屋の中央が空いていればそこ、ふさがっていれば 200mm ずつずらして空きを探す(10 回まで)
//   size: { width, depth }、others: 他の家具の四角(placementRect の形)
export function newPlacementSpot(poly, size, others = []) {
  const base = insidePoint(poly);
  const free = (p) => {
    const r = { x: p.x, y: p.y, width: size.width, depth: size.depth, rotationDeg: 0 };
    return rectInsidePolygon(r, poly) && !others.some((o) => rectsOverlap(r, o));
  };
  if (free(base)) return { x: base.x, y: base.y };
  for (let i = 0; i < PLACE_TRIES; i++) {
    const [dx, dy] = DIRS[i % 4];
    const k = PLACE_STEP * (Math.floor(i / 4) + 1);
    const p = { x: base.x + dx * k, y: base.y + dy * k };
    if (free(p)) return p;
  }
  return { x: base.x, y: base.y };
}

// 測る道具の点: 許容(mm)の中で最も近い角に付ける
export function snapToCorners(p, corners, tolerance) {
  let best = null, bestD = Infinity;
  for (const c of corners) {
    const d = dist(p, c);
    if (d <= tolerance && d < bestD) { best = c; bestD = d; }
  }
  return best ? { x: best.x, y: best.y, snapped: true } : { x: p.x, y: p.y, snapped: false };
}

// 配置案の既定の名前: 案A, 案B … 案Z、そのあとは 案27 …
export function nextPlanName(names) {
  const used = new Set(names);
  for (let i = 0; i < 26; i++) {
    const n = `案${String.fromCharCode(65 + i)}`;
    if (!used.has(n)) return n;
  }
  for (let i = 27; ; i++) if (!used.has(`案${i}`)) return `案${i}`;
}

// 警告の文(色だけに頼らず、右の一覧に文字で出す)
export function warningText(w, nameOf) {
  if (w.type === 'overlap') return `${nameOf(w.withId) || '他の家具'}と重なっています`;
  if (w.type === 'outside') return '部屋からはみ出しています';
  if (w.type === 'door') return 'ドアの開く範囲にあります';
  return '';
}

// その家具が置かれている「別の部屋の現状」の部屋名
export function otherCurrentRooms(house, furnitureId, roomId) {
  const out = [];
  for (const floor of house.floors) {
    for (const room of floor.rooms) {
      if (room.id === roomId) continue;
      const cur = room.plans.find((p) => p.isCurrent);
      if (cur && cur.placements.some((pl) => pl.furnitureId === furnitureId)) out.push(room.name);
    }
  }
  return out;
}

export function placedNotice(roomNames) {
  if (!roomNames.length) return '';
  return `${roomNames.map((n) => `${n}(現状)`).join('、')}にも置かれています`;
}

// 複製できるのは 検討中・備え付け だけ(手持ちの家具は実物が1つ)
export const canDuplicate = (f) => !!f && f.status !== 'owned';

// 数値の入力。"1,250"・全角・負の数・0 を受ける。数値でなければ null
export function parseNumber(text) {
  const s = String(text ?? '')
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－−ー]/g, '-')
    .replace(/[,，\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

// 角度を 0〜360 未満に
export function normDeg(d) {
  const v = ((d % 360) + 360) % 360;
  return Object.is(v, -0) ? 0 : v;
}

// 中心から点への向き(度)。家具の「前」(回転 0 で -y)を 0度、時計回り
export function angleFromCenter(c, p) {
  return normDeg((Math.atan2(p.x - c.x, -(p.y - c.y)) * 180) / Math.PI);
}
