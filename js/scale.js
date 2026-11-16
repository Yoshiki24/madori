// 縮尺と傾きの計算(DOM に触れない)。長さは mm、角度は度。

// 図面上の2点(px)と実寸(mm)から、1px あたりの mm を求める
export function calibrate(p1Px, p2Px, realMm) {
  const px = Math.hypot(p2Px.x - p1Px.x, p2Px.y - p1Px.y);
  if (px < 1e-9) return { ok: false, reason: 'same-point' };
  if (typeof realMm !== 'number' || !Number.isFinite(realMm) || realMm <= 0) {
    return { ok: false, reason: 'bad-length' };
  }
  return { ok: true, mmPerPx: realMm / px };
}

// 2点を結ぶ線を、最も近い水平か垂直にするための回転(度、-45〜45)
export function deskewAngle(p1Px, p2Px) {
  const deg = (Math.atan2(p2Px.y - p1Px.y, p2Px.x - p1Px.x) * 180) / Math.PI;
  return Math.round(deg / 90) * 90 - deg;
}

export function pxToMm(pPx, mmPerPx) {
  return { x: pPx.x * mmPerPx, y: pPx.y * mmPerPx };
}

export function mmToPx(pMm, mmPerPx) {
  return { x: pMm.x / mmPerPx, y: pMm.y / mmPerPx };
}

// 3桁区切りの整数。5400 → "5,400"
export function formatMm(mm) {
  return String(Math.round(mm)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// "5,400"・"5400"・全角数字を受ける。0以下・数値以外は null
export function parseMm(text) {
  if (typeof text !== 'string') return null;
  const s = text
    .replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，]/g, '')
    .trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}
