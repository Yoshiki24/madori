// ページの中の確認の窓(<dialog>)。alert / confirm / prompt は使わない。1つの <dialog> を使い回す
//   const ok = await confirmDialog({ title, message, ok: '削除する', cancel: 'やめる', danger: true });
import { icon } from './icons.js';

let dlg = null;
let pending = null;   // 開いている窓の resolve
let staleCloses = 0;  // 開き直しで閉じた前の窓の close(後から届く)。新しい窓の resolve に使わない

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function ensure() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'confirm-dialog';
  dlg.id = 'confirm-dialog';
  dlg.setAttribute('aria-labelledby', 'confirm-title');
  dlg.setAttribute('aria-describedby', 'confirm-msg');
  dlg.addEventListener('close', () => {
    if (staleCloses > 0) { staleCloses--; return; }
    const r = pending;
    pending = null;
    r?.(dlg.returnValue === 'ok');
  });
  document.body.append(dlg);
  return dlg;
}

export function confirmDialog({ title, message = '', ok = 'OK', cancel = 'やめる', danger = false } = {}) {
  const d = ensure();
  // 開いたまま別の確認を開く: 前の窓はその場で「やめる」として終える(close イベントは後から届くので数えて読み飛ばす)
  if (d.open) {
    const prev = pending;
    pending = null;
    staleCloses++;
    d.close('cancel');
    prev?.(false);
  }
  d.innerHTML = `<form method="dialog" class="confirm-form">
    <h2 id="confirm-title" class="confirm-title">${danger ? icon('warn', 20) : ''}<span>${esc(title)}</span></h2>
    <p id="confirm-msg" class="confirm-msg">${esc(message)}</p>
    <div class="confirm-actions">
      <button type="submit" value="cancel" class="pill pill-outline" data-confirm="cancel">${esc(cancel)}</button>
      <button type="submit" value="ok" class="pill ${danger ? 'pill-danger' : 'pill-accent'}" data-confirm="ok">${esc(ok)}</button>
    </div>
  </form>`;
  d.returnValue = '';
  return new Promise((resolve) => {
    pending = resolve;
    d.showModal();
    // 消す・変える確認では、うっかり Enter で進まないよう「やめる」にフォーカス
    d.querySelector(danger ? '[data-confirm="cancel"]' : '[data-confirm="ok"]').focus();
  });
}
