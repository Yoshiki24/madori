// QR コード(同梱の qrcode-generator を使う)。行列と、白い余白つきのインライン SVG
import qrcode from '../vendor/qrcode.js';

// text → 正方形の真偽の行列(true が暗いモジュール)。誤り訂正は M
export function qrMatrix(text) {
  const q = qrcode(0, 'M');
  q.addData(String(text), 'Byte');
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

// 余白 4 モジュール。色は CSS(.qr-bg・.qr-dark)で付ける
export function qrSvg(text, { size = 256, label = 'スマホ用のQRコード' } = {}) {
  const m = qrMatrix(text);
  const quiet = 4;
  const n = m.length + quiet * 2;
  let d = '';
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) d += `M${c + quiet} ${r + quiet}h1v1h-1z`; }));
  const esc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${n} ${n}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect class="qr-bg" width="${n}" height="${n}"/><path class="qr-dark" d="${d}"/></svg>`;
}
