// 家具のカード(純粋な HTML 文字列)。家具台帳・右の一覧・スマホの閲覧画面で共通に使う
// 編集の部品(store など)を読み込まないよう、ui-catalog.js から分けた
import { formatMm } from './scale.js';
import { DEFAULT_COLOR, statusLabel, kindLabel, formatPrice, usageLabels } from './catalog-logic.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c ?? '') ? c : DEFAULT_COLOR);

// 押せる部品を含まない <span class="fcard"> だけ(ボタンの中に入れられる)
//   usage: furnitureUsage の結果(渡すと置き場所の行を出す)。compact: 種類を省く(狭い一覧)
export function furnitureCardHtml(f, url, { usage, compact = false } = {}) {
  const thumb = url
    ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async">`
    : `<span class="fcard-swatch" style="background:${safeColor(f.color)}"></span>`;
  const price = formatPrice(f.price);
  const where = usage
    ? `<span class="fcard-usage">${usage.length ? `置き場所: ${esc(usageLabels(usage).join('、'))}` : 'まだ置いていません'}</span>`
    : '';
  return `<span class="fcard">
    <span class="fcard-photo" aria-hidden="true">${thumb}</span>
    <span class="fcard-body">
      <span class="fcard-name">${esc(f.name)}</span>
      <span class="fcard-meta">${compact ? '' : `${esc(kindLabel(f.kind))} ・ `}<span class="fcard-size">${formatMm(f.width)}×${formatMm(f.depth)}×${formatMm(f.height)}</span></span>
      <span class="fcard-tags"><span class="badge status-${esc(f.status)}">${esc(statusLabel(f.status))}</span>${price ? `<span class="fcard-price">${price}</span>` : ''}</span>
      ${where}
    </span>
  </span>`;
}
