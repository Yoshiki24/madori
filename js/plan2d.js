// 平面図の SVG(DOM に触れず、文字列を返す)。座標は mm(viewBox で表示の大きさに合わせる)。
// 色は style.css の .plan-svg の規則で付ける。ここで直接書く色は家具の色(データ)だけ。
// 線の太さ・文字の大きさは viewBox の大きさから決め、表示の大きさが変わってもほぼ同じに見えるようにする。
// 拡大・移動するときは、表示する範囲(viewBox)と枠の大きさ(size)を渡す(view.js の createViewport が作る)。
import { formatMm } from './scale.js';
import { rectCorners, wallOf, polygonArea } from './geom.js';
import { placementRect, NARROW_MM } from './check.js';

const GRID = 910;   // 方眼(半間)

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const n = (v) => (Math.round(v * 100) / 100).toString();   // 小数2桁まで
const safeColor = (c, fallback = '#7a4a2b') => (/^#[0-9a-fA-F]{6}$/.test(c ?? '') ? c : fallback);

export function viewBoxFor(points, padding = 400) {
  const pts = points && points.length ? points : [{ x: 0, y: 0 }];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { x: minX - padding, y: minY - padding, w: maxX - minX + padding * 2, h: maxY - minY + padding * 2 };
}

// 表示の 1px に相当する mm。size(表示する枠の px)があればそれに合わせ、なければ約 600px の枠を想定する
function unitOf(vb, size) {
  if (size && size.width > 0 && size.height > 0) return Math.max(vb.w / size.width, vb.h / size.height);
  return Math.max(vb.w, vb.h) / 600;
}

function svgOpen(vb, label, cls) {
  return `<svg xmlns="http://www.w3.org/2000/svg" class="plan-svg ${cls}" viewBox="${n(vb.x)} ${n(vb.y)} ${n(vb.w)} ${n(vb.h)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(label)}">`;
}

const pointsAttr = (poly) => poly.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');

// 多角形の向き(check.js と同じ)。内向きの法線を求めるのに使う
function orientation(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.sign(s) || 1;
}

function centroid(poly) {
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

// 方眼(910mm)。clipId の範囲(部屋)だけに描く。vb には部屋の範囲を渡す(表示の範囲によらない)
function grid(vb, u, clipId) {
  if (!vb) return '';
  let d = '';
  for (let x = Math.ceil(vb.x / GRID) * GRID; x <= vb.x + vb.w; x += GRID) d += `M${n(x)} ${n(vb.y)}V${n(vb.y + vb.h)}`;
  for (let y = Math.ceil(vb.y / GRID) * GRID; y <= vb.y + vb.h; y += GRID) d += `M${n(vb.x)} ${n(y)}H${n(vb.x + vb.w)}`;
  return `<path class="grid" d="${d}" stroke-width="${n(u)}" clip-path="url(#${esc(clipId)})"/>`;
}

// 図面の画像の 1px あたりの mm。縮尺がまだない階は、編集中だけ 1px = 1mm として表示する
const imageScale = (floor, editing) => floor.mmPerPx || (editing ? 1 : 0);

function floorImage(floor, blobUrls, showImage, editing = false) {
  const k = floor?.image ? imageScale(floor, editing) : 0;
  if (!showImage || !k) return '';
  const url = blobUrls?.[floor.image.hash];
  if (!url) return '';
  const w = floor.image.width * k, h = floor.image.height * k;
  const rot = floor.imageRotationDeg ? ` transform="rotate(${n(floor.imageRotationDeg)} ${n(w / 2)} ${n(h / 2)})"` : '';
  return `<image class="floor-image" href="${esc(url)}" x="0" y="0" width="${n(w)}" height="${n(h)}" opacity="${n(floor.imageOpacity ?? 0.5)}" preserveAspectRatio="none"${rot}/>`;
}

// 画像の4つの角(画像の中心で回転したあと)
function imagePoints(floor, showImage, blobUrls, editing = false) {
  const k = floor?.image ? imageScale(floor, editing) : 0;
  if (!showImage || !k || !blobUrls?.[floor.image.hash]) return [];
  const w = floor.image.width * k, h = floor.image.height * k;
  const r = ((floor.imageRotationDeg || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => {
    const dx = x - w / 2, dy = y - h / 2;
    return { x: w / 2 + dx * c - dy * s, y: h / 2 + dx * s + dy * c };
  });
}

// 点の範囲 { x, y, w, h }(余白なし)。点がなければ null
function boundsOf(points) {
  if (!points.length) return null;
  const b = viewBoxFor(points, 0);
  return b;
}

// 階の図の中身の範囲(部屋と、表示する図面の画像)。何もなければ null
export function floorBounds(house, floorId, { blobUrls = {}, showImage = true, editing = false } = {}) {
  const floor = house.floors.find((f) => f.id === floorId);
  if (!floor) return null;
  return boundsOf([...floor.rooms.flatMap((r) => r.polygon), ...imagePoints(floor, showImage, blobUrls, editing)]);
}

// 部屋の図の中身の範囲(部屋の多角形)。部屋がなければ null
export function roomBounds(house, roomId) {
  for (const f of house.floors) {
    const room = f.rooms.find((r) => r.id === roomId);
    if (room) return boundsOf(room.polygon);
  }
  return null;
}

// 開口部。壁の線の上に「すき間」を描き、種類ごとの記号を重ねる
function opening(room, o, u, wallW, { hit = false, selected = false } = {}) {
  const poly = room.polygon;
  if (!(o.wallIndex >= 0 && o.wallIndex < poly.length)) return '';
  const wall = wallOf(poly, o.wallIndex);
  if (!wall.length) return '';
  const t = { x: (wall.b.x - wall.a.x) / wall.length, y: (wall.b.y - wall.a.y) / wall.length };
  const ori = orientation(poly);
  const inward = { x: -t.y * ori, y: t.x * ori };
  const w = Math.min(o.width || 0, wall.length);
  const c = { x: wall.a.x + t.x * o.offset, y: wall.a.y + t.y * o.offset };
  const at = (s, k = 0) => ({ x: c.x + t.x * s + inward.x * k, y: c.y + t.y * s + inward.y * k });
  const line = (p, q, cls, sw) => `<line class="${cls}" x1="${n(p.x)}" y1="${n(p.y)}" x2="${n(q.x)}" y2="${n(q.y)}" stroke-width="${n(sw)}"/>`;
  const p1 = at(-w / 2), p2 = at(w / 2);
  let out = line(p1, p2, 'wall-gap', wallW + u * 2);
  const type = ['door', 'sliding', 'window', 'gap'].includes(o.type) ? o.type : 'gap';
  if (type === 'door') {
    const swing = String(o.swing || 'in-left');
    const side = swing.startsWith('out') ? -1 : 1;
    const hinge = swing.endsWith('right') ? p2 : p1;
    const other = hinge === p1 ? p2 : p1;
    const leaf = { x: hinge.x + inward.x * side * w, y: hinge.y + inward.y * side * w };
    const v1 = { x: leaf.x - hinge.x, y: leaf.y - hinge.y }, v2 = { x: other.x - hinge.x, y: other.y - hinge.y };
    const sweep = v1.x * v2.y - v1.y * v2.x > 0 ? 1 : 0;
    out += line(hinge, leaf, 'door-leaf', u * 1.5);
    out += `<path class="door-arc" d="M${n(leaf.x)} ${n(leaf.y)}A${n(w)} ${n(w)} 0 0 ${sweep} ${n(other.x)} ${n(other.y)}" stroke-width="${n(u)}"/>`;
  } else if (type === 'sliding') {
    const k = wallW / 4;
    out += line(at(-w / 2, k), at(w * 0.05, k), 'sliding-panel', u * 1.5);
    out += line(at(-w * 0.05, -k), at(w / 2, -k), 'sliding-panel', u * 1.5);
  } else if (type === 'window') {
    const k = wallW / 3;
    out += line(at(-w / 2, k), at(w / 2, k), 'window-line', u);
    out += line(at(-w / 2, -k), at(w / 2, -k), 'window-line', u);
  }
  if (selected) out += line(p1, p2, 'opening-sel', wallW + u * 6);
  // 編集中は、つかみやすいように透明な太い線を重ねる
  if (hit) out += line(p1, p2, 'opening-hit', Math.max(wallW + u * 10, u * 16));
  return `<g class="opening opening-${type}${selected ? ' selected' : ''}" data-opening-id="${esc(o.id)}">${out}</g>`;
}

// 壁(多角形の線)と、壁ごとのクリック用の太い透明な線
function walls(room, u, wallW, withHit) {
  let out = `<polygon class="walls" points="${pointsAttr(room.polygon)}" stroke-width="${n(wallW)}"/>`;
  if (withHit) {
    room.polygon.forEach((_, i) => {
      const { a, b } = wallOf(room.polygon, i);
      out += `<line class="wall-hit" data-wall-index="${i}" x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke-width="${n(u * 14)}"/>`;
    });
  }
  return out;
}

// 辺の長さ。壁の外側に、壁と同じ向きで書く
function dims(room, u, wallW) {
  const poly = room.polygon;
  const ori = orientation(poly);
  let out = '';
  poly.forEach((_, i) => {
    const wall = wallOf(poly, i);
    if (!wall.length) return;
    const t = { x: (wall.b.x - wall.a.x) / wall.length, y: (wall.b.y - wall.a.y) / wall.length };
    const outward = { x: t.y * ori, y: -t.x * ori };
    const k = wallW / 2 + u * 12;
    const m = { x: (wall.a.x + wall.b.x) / 2 + outward.x * k, y: (wall.a.y + wall.b.y) / 2 + outward.y * k };
    let ang = wall.angleDeg;
    if (ang > 90) ang -= 180;
    if (ang <= -90) ang += 180;
    out += `<text class="dim" data-wall-index="${i}" x="${n(m.x)}" y="${n(m.y)}" font-size="${n(u * 12)}" text-anchor="middle" dominant-baseline="central" transform="rotate(${n(ang)} ${n(m.x)} ${n(m.y)})">${formatMm(wall.length)}</text>`;
  });
  return `<g class="dims">${out}</g>`;
}

// 警告のアイコン(三角に「!」)。色だけに頼らない目印
function warnIcon(x, y, s) {
  const h = s * 0.9;
  return `<g class="warn-icon" transform="translate(${n(x)} ${n(y)})">`
    + `<path class="warn-tri" d="M0 ${n(-h / 2)}L${n(s / 2)} ${n(h / 2)}H${n(-s / 2)}Z" stroke-width="${n(s / 12)}"/>`
    + `<path class="warn-mark" d="M0 ${n(-h / 6)}V${n(h / 6)}M0 ${n(h / 3.2)}V${n(h / 3.1)}" stroke-width="${n(s / 9)}"/></g>`;
}

// ---- 家具の名前の文字の色 ----
// 文字の色は家具の面の色に合わせて、濃い色(--ink)か明るい色(--on-accent)のうち明暗差の大きい方を選ぶ。
// どちらも 4.5:1 に届かない中間の色のときは、面の色(--panel)の札を敷いて濃い文字にする。
// ここの値は style.css の変数と同じにする(計算にだけ使う。色は CSS で付ける)
const INK = '#3a2618', LIGHT = '#ffffff', PANEL = '#f8f0e1';
const CONSIDERING_ALPHA = 0.18;   // 検討中の面の濃さ(style.css の fill-opacity と同じ)

function rgbOf(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function luminance([r, g, b]) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

// 面の色(#rrggbb)と、検討中かどうか → 'on-light'(濃い文字)| 'on-dark'(明るい文字)| 'chip'(札を敷く)
export function labelTone(color, considering = false) {
  let rgb = rgbOf(safeColor(color));
  if (considering) {
    const p = rgbOf(PANEL);
    rgb = rgb.map((c, i) => c * CONSIDERING_ALPHA + p[i] * (1 - CONSIDERING_ALPHA));
  }
  const l = luminance(rgb);
  const dark = contrast(l, luminance(rgbOf(INK))), light = contrast(l, luminance(rgbOf(LIGHT)));
  if (Math.max(dark, light) < 4.5) return 'chip';
  return dark >= light ? 'on-light' : 'on-dark';
}

// 文字の幅のおおよそ(em)。かなと漢字は 1、英数字は 0.6
function textEm(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) < 0x2e80 ? 0.6 : 1;
  return w;
}

// 家具1つ。四角は中心で回転、文字は回転させない。文字が家具に収まらないときは出さない(名前は title で分かる)
function furniture(pl, f, u, { selected = false, warn = false, labels = true } = {}) {
  const r = placementRect(pl, f);
  const considering = f.status === 'considering';
  const cls = ['furniture', considering && 'considering', warn && 'warn', selected && 'selected'].filter(Boolean).join(' ');
  const hw = f.width / 2, hd = f.depth / 2;
  const sw = considering ? u * 2 : u;
  const dash = considering ? ` stroke-dasharray="${n(u * 6)} ${n(u * 4)}"` : '';
  let out = `<g class="${cls}" data-placement-id="${esc(pl.id)}" data-furniture-id="${esc(f.id)}"><title>${esc(f.name)}${considering ? '(検討中)' : ''}</title>`;
  out += `<g transform="translate(${n(r.x)} ${n(r.y)}) rotate(${n(r.rotationDeg)})">`;
  if (selected) {
    const g = u * 4;
    out += `<rect class="sel-ring" x="${n(-hw - g)}" y="${n(-hd - g)}" width="${n(f.width + g * 2)}" height="${n(f.depth + g * 2)}" rx="${n(u * 4)}" stroke-width="${n(u * 2)}"/>`;
  }
  out += `<rect class="body" x="${n(-hw)}" y="${n(-hd)}" width="${n(f.width)}" height="${n(f.depth)}" rx="${n(Math.min(u * 3, hw, hd))}" fill="${safeColor(f.color)}" stroke-width="${n(sw)}"${dash}/>`;
  out += '</g>';
  out += furnitureText(r, f, u, labels, considering);
  if (warn) {
    const cs = rectCorners(r);
    const x = Math.max(...cs.map((p) => p.x)), y = Math.min(...cs.map((p) => p.y));
    out += warnIcon(x, y, u * 16);
  }
  return out + '</g>';
}

// 家具の名前と「検討中」。両方 → 名前だけ → 「検討中」だけ → なし、の順に、家具の大きさに収まるものを選ぶ
function furnitureText(r, f, u, labels, considering) {
  const cs = rectCorners(r);
  const bw = Math.max(...cs.map((p) => p.x)) - Math.min(...cs.map((p) => p.x));
  const bh = Math.max(...cs.map((p) => p.y)) - Math.min(...cs.map((p) => p.y));
  const name = labels ? String(f.name ?? '') : '';
  const pad = u * 4;
  const fitsW = (t, size) => textEm(t) * size + pad <= bw;
  // 収まらなければ文字を少し小さくして試す(9.5px より小さくはしない)
  const pick = () => {
    for (const k of labels ? [1, 0.86] : [1]) {
      const fs = u * (labels ? 11 : 9) * k, ts = u * (labels ? 10 : 9) * k;
      if (name && considering && fitsW(name, fs) && fitsW('検討中', ts) && fs * 1.25 + ts * 1.25 + u * 2 <= bh) {
        return [{ text: name, size: fs, dy: -fs * 0.6, cls: 'label' }, { text: '検討中', size: ts, dy: fs * 0.7, cls: 'tag' }];
      }
      if (name && fitsW(name, fs) && fs * 1.3 <= bh) return [{ text: name, size: fs, dy: 0, cls: 'label' }];
    }
    for (const k of labels ? [1, 0.9] : [1]) {
      const ts = u * (labels ? 10 : 9) * k;
      if (considering && fitsW('検討中', ts) && ts * 1.3 <= bh) return [{ text: '検討中', size: ts, dy: 0, cls: 'tag' }];
    }
    return [];
  };
  const lines = pick();
  if (!lines.length) return '';
  const tone = labelTone(f.color, considering);
  let out = '';
  if (tone === 'chip') {
    const w = Math.max(...lines.map((l) => textEm(l.text) * l.size)) + u * 6;
    const top = Math.min(...lines.map((l) => l.dy - l.size * 0.65)), bottom = Math.max(...lines.map((l) => l.dy + l.size * 0.65));
    out += `<rect class="label-chip" x="${n(r.x - w / 2)}" y="${n(r.y + top)}" width="${n(w)}" height="${n(bottom - top)}" rx="${n(u * 3)}"/>`;
  }
  const cls = tone === 'on-dark' ? 'on-dark' : 'on-light';
  for (const l of lines) {
    out += `<text class="${l.cls} ${cls}" x="${n(r.x)}" y="${n(r.y + l.dy)}" font-size="${n(l.size)}" text-anchor="middle" dominant-baseline="central">${esc(l.text)}</text>`;
  }
  return out;
}

function placements(house, plan, u, opts = {}) {
  if (!plan) return '';
  const byId = new Map(house.furniture.map((f) => [f.id, f]));
  const warnIds = new Set((opts.warnings || []).map((w) => w.placementId));
  let out = '';
  for (const pl of plan.placements) {
    const f = byId.get(pl.furnitureId);
    if (!f) continue;
    out += furniture(pl, f, u, { selected: pl.id === opts.selectedId, warn: warnIds.has(pl.id), labels: opts.labels !== false });
  }
  return out;
}

// すき間: 点線と両端の短い印、数値。NARROW_MM 未満は narrow(警告の色)と「狭い」の文字(色だけに頼らない)
function clearanceLines(list, u) {
  let out = '';
  for (const c of list || []) {
    if (!(c.mm > 0) || !c.a || !c.b) continue;
    const m = { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 };
    const len = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) || 1;
    const k = u * 5;
    const nx = (-(c.b.y - c.a.y) / len) * k, ny = ((c.b.x - c.a.x) / len) * k;
    const tick = (p) => `<line class="tick" x1="${n(p.x - nx)}" y1="${n(p.y - ny)}" x2="${n(p.x + nx)}" y2="${n(p.y + ny)}" stroke-width="${n(u * 1.5)}"/>`;
    const narrow = c.mm < NARROW_MM;
    // 縦の線なら数値は右、横の線なら上に置く
    const vertical = Math.abs(c.b.y - c.a.y) >= Math.abs(c.b.x - c.a.x);
    const tx = vertical ? m.x + u * 6 : m.x, ty = vertical ? m.y : m.y - u * 9;
    const anchor = vertical ? 'start' : 'middle';
    out += `<g class="clearance${narrow ? ' narrow' : ''}"><line x1="${n(c.a.x)}" y1="${n(c.a.y)}" x2="${n(c.b.x)}" y2="${n(c.b.y)}" stroke-width="${n(u * (narrow ? 1.5 : 1))}" stroke-dasharray="${n(u * 3)} ${n(u * 3)}"/>`
      + tick(c.a) + tick(c.b)
      + `<text x="${n(tx)}" y="${n(ty)}" font-size="${n(u * 11)}" stroke-width="${n(u * 3)}" text-anchor="${anchor}" dominant-baseline="central">${formatMm(c.mm)}${narrow ? '<tspan class="narrow-tag"> 狭い</tspan>' : ''}</text></g>`;
  }
  return out;
}

// 部屋の広さの文字「19.4㎡(約12.0畳)」。㎡ は小数1桁、1畳 = 1.62㎡
export const TATAMI_SQM = 1.62;
export function areaLabel(polygon) {
  return areaText(polygon && polygon.length >= 3 ? polygonArea(polygon) : 0);
}
// 面積(mm²)→「19.4㎡(約12.0畳)」
export function areaText(mm2) {
  const sqm = (mm2 || 0) / 1e6;
  return `${sqm.toFixed(1)}㎡(約${(sqm / TATAMI_SQM).toFixed(1)}畳)`;
}

const currentPlan = (room) => room.plans.find((p) => p.isCurrent) || room.plans[0] || null;

function emptySvg(label, message) {
  const vb = { x: 0, y: 0, w: 6000, h: 4000 };
  const u = unitOf(vb);
  return svgOpen(vb, label, 'empty') + `<text class="empty-note" x="3000" y="2000" font-size="${n(u * 14)}" text-anchor="middle" dominant-baseline="central">${esc(message)}</text></svg>`;
}

// 階全体: 全部屋と、各部屋の「現状」の家具。
// 編集用(editing): 縮尺のない図面の画像も 1px = 1mm で出す。部屋がなくても空の図にせず、viewBox の範囲を描く
//   wallHits: 壁のクリック用の透明な線、showDims: 全部屋の辺の長さ、selectedOpeningId: 選んでいる開口部
export function renderFloorSvg(house, floorId, {
  blobUrls = {}, highlightRoomId = null, showImage = true, size = null, viewBox = null,
  editing = false, wallHits = false, showDims = false, selectedOpeningId = null,
  areas = false, focusable = false,
} = {}) {
  const floor = house.floors.find((f) => f.id === floorId);
  if (!floor) return emptySvg('平面図', '階がありません');
  const pts = [...floor.rooms.flatMap((r) => r.polygon), ...imagePoints(floor, showImage, blobUrls, editing)];
  if (!pts.length && !viewBox) return emptySvg(`${floor.name}の平面図`, '部屋がまだありません');
  const vb = viewBox || viewBoxFor(pts, 600);
  const u = unitOf(vb, size);
  const wallW = u * 4;
  const clipId = `clip-floor-${floor.id}`;
  let out = svgOpen(vb, `${floor.name}の平面図`, `floor-plan${editing ? ' editing' : ''}`);
  out += `<defs><clipPath id="${esc(clipId)}">${floor.rooms.map((r) => `<polygon points="${pointsAttr(r.polygon)}"/>`).join('')}</clipPath></defs>`;
  out += floorImage(floor, blobUrls, showImage, editing);
  out += floor.rooms.map((r) => `<polygon class="room-floor" points="${pointsAttr(r.polygon)}"/>`).join('');
  out += grid(boundsOf(floor.rooms.flatMap((r) => r.polygon)), u, clipId);
  for (const room of floor.rooms) {
    const c = centroid(room.polygon);
    const area = areas || focusable ? areaLabel(room.polygon) : '';
    const focus = focusable ? ` tabindex="0" role="button" aria-label="${esc(`${room.name} ${area}を開く`)}"` : '';
    out += `<g class="room${room.id === highlightRoomId ? ' highlight' : ''}" data-room-id="${esc(room.id)}"${focus}>`;
    out += `<polygon class="room-hit" points="${pointsAttr(room.polygon)}"/>`;
    out += placements(house, currentPlan(room), u, { labels: false });
    out += walls(room, u, wallW, wallHits);
    out += (room.openings || []).map((o) => opening(room, o, u, wallW, { hit: editing, selected: o.id === selectedOpeningId })).join('');
    const nameY = areas ? c.y - u * 8 : c.y;
    if (areas) {   // 家具の上でも読めるよう、名前と広さの下に面の色の札を敷く
      const w = Math.max(textEm(room.name) * u * 14, textEm(area) * u * 12) + u * 12;
      out += `<rect class="room-label-chip" x="${n(c.x - w / 2)}" y="${n(nameY - u * 11)}" width="${n(w)}" height="${n(u * 39)}" rx="${n(u * 6)}"/>`;
    }
    out += `<text class="room-name" x="${n(c.x)}" y="${n(nameY)}" font-size="${n(u * 14)}" stroke-width="${n(u * 4)}" text-anchor="middle" dominant-baseline="central">${esc(room.name)}</text>`;
    if (areas) out += `<text class="room-area" x="${n(c.x)}" y="${n(c.y + u * 10)}" font-size="${n(u * 12)}" stroke-width="${n(u * 4)}" text-anchor="middle" dominant-baseline="central">${area}</text>`;
    if (showDims) out += dims(room, u, wallW);
    out += '</g>';
  }
  return out + '</svg>';
}

// 部屋1つ: 指定の案の家具、壁・開口部・寸法・警告・すき間
// wallHits: 壁のクリック用の透明な線(壁を選ぶ編集のときだけ。ふだんは家具のクリックを優先する)
export function renderRoomSvg(house, roomId, planId, {
  blobUrls = {}, selectedId = null, warnings = [], clearances = [], showImage = false, showDims = true, size = null,
  viewBox = null, wallHits = false,
} = {}) {
  const found = house.floors.flatMap((f) => f.rooms.map((room) => ({ floor: f, room }))).find((x) => x.room.id === roomId);
  if (!found) return emptySvg('平面図', '部屋を選んでください');
  const { floor, room } = found;
  const plan = room.plans.find((p) => p.id === planId) || currentPlan(room);
  const vb = viewBox || viewBoxFor(room.polygon, 700);
  const u = unitOf(vb, size);
  const wallW = u * 5;
  const clipId = `clip-room-${room.id}`;
  let out = svgOpen(vb, `${room.name}の平面図`, 'room-plan');
  out += `<defs><clipPath id="${esc(clipId)}"><polygon points="${pointsAttr(room.polygon)}"/></clipPath></defs>`;
  if (showImage) out += `<g clip-path="url(#${esc(clipId)})">${floorImage(floor, blobUrls, true)}</g>`;
  out += `<g class="room" data-room-id="${esc(room.id)}">`;
  out += `<polygon class="room-floor" points="${pointsAttr(room.polygon)}"/>`;
  out += grid(boundsOf(room.polygon), u, clipId);
  out += placements(house, plan, u, { selectedId, warnings });
  out += clearanceLines(clearances, u);
  out += walls(room, u, wallW, wallHits);
  out += (room.openings || []).map((o) => opening(room, o, u, wallW)).join('');
  if (showDims) out += dims(room, u, wallW);
  out += '</g>';
  return out + '</svg>';
}
