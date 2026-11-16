// 画像の取り込み: 読み込み → 長辺を縮める → WebP → SHA-256(16進)を名前にする
export const PHOTO_MAX = 1600;
export const PLAN_MAX = 3000;
const QUALITY = 0.85;

export async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function encode(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise(res => canvas.toBlob(res, type, quality));
}

// 読めない画像(HEIC・テキスト・壊れたデータ)は null。例外にしない
async function decode(blob) {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) return null;
  try {
    const bm = await createImageBitmap(blob);
    if (!bm.width || !bm.height) { bm.close?.(); return null; }
    return bm;
  } catch {
    return null;
  }
}

export async function importImage(fileOrBlob, maxSide) {
  const bm = await decode(fileOrBlob);
  if (!bm) return { ok: false, reason: 'unsupported' };
  try {
    const scale = Math.min(1, maxSide / Math.max(bm.width, bm.height)); // 拡大はしない
    const width = Math.max(1, Math.round(bm.width * scale));
    const height = Math.max(1, Math.round(bm.height * scale));
    const canvas = makeCanvas(width, height);
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bm, 0, 0, width, height);
    const out = await encode(canvas, 'image/webp', QUALITY);
    // WebP を作れないブラウザは対象外。PNG などへ黙って切り替えず、エラーにする
    if (!out || out.type !== 'image/webp') throw new Error('webp-unsupported');
    const bytes = new Uint8Array(await out.arrayBuffer());
    return { ok: true, hash: await sha256Hex(bytes), type: 'image/webp', bytes, width, height };
  } finally {
    bm.close?.();
  }
}

// 中央 60% の平均色('#rrggbb')
export async function dominantColor(bytes, type) {
  const bm = await createImageBitmap(new Blob([bytes], { type }));
  try {
    const sx = bm.width * 0.2, sy = bm.height * 0.2, sw = bm.width * 0.6, sh = bm.height * 0.6;
    // 大きな画像は縮めて数える(縮小の補間も平均なので結果はほぼ同じ)
    const k = Math.min(1, 256 / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
    const canvas = makeCanvas(w, h);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(bm, sx, sy, sw, sh, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a === 0) continue; // 透明な画素は数えない
      r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++;
    }
    if (n === 0) return '#000000';
    const hex = v => Math.round(v / n).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(gg)}${hex(b)}`;
  } finally {
    bm.close?.();
  }
}
