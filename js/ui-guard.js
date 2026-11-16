// 編集の画面を守る案内(Mac の編集だけ。スマホの閲覧画面は使わない)
//   claimEditor(root): 編集できるタブを1つにする(navigator.locks)。2つ目のタブには「別のタブで MADORI を開いています」
//   mountGuards(shell): 読み込みの失敗(全面の案内)・保存の失敗(上部の警告)・編集が別のタブに移った(全面の案内)・
//                       ブラウザが永続化を断った(一度だけのお知らせ)
import { store } from './store.js';
import * as db from './db.js';
import { icon } from './icons.js';
import { exportBackup, importBackupFile, restoreFromStore, getSetting, openSettings } from './ui-settings.js';

const LOCK = 'madori-editor';
const CHANNEL = 'madori-editor';
const PERSIST_KEY = 'persistNoticeDismissed';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 編集できるタブを1つにする ----

// 編集の権利を持つ(ページを閉じるまで返さない)。取れなければ false。奪われたら保存をやめる
function holdLock(opts) {
  return new Promise((resolve) => {
    let held = false;
    navigator.locks.request(LOCK, opts, (lock) => {
      if (!lock) { resolve(false); return null; }
      held = true;
      store.hasLock = true;
      resolve(true);
      return new Promise(() => {});
    }).catch(() => {
      if (!held) { resolve(false); return; }
      // 別のタブが「このタブで編集する」を押した: すぐに保存をやめる
      store.hasLock = false;
      store.stopSaving('moved');
    });
  });
}

// 編集の権利を持っている間、移る前に保存してほしいという別のタブの頼みに応える
function listenFlush() {
  if (typeof BroadcastChannel !== 'function') return;
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = async (e) => {
    if (e.data !== 'flush' || !store.hasLock) return;
    try { await store.flush(); } catch { /* 保存の失敗は store が扱う */ }
    ch.postMessage('flushed');
  };
}

// 持っているタブに、待っている保存を済ませてもらう(返事がなければ 1.5秒で進む)
async function askFlush() {
  if (typeof BroadcastChannel !== 'function') return;
  const ch = new BroadcastChannel(CHANNEL);
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 1500);
    ch.onmessage = (e) => { if (e.data === 'flushed') { clearTimeout(t); resolve(); } };
    ch.postMessage('flush');
  });
  ch.close();
}

// 編集を始めてよくなるまで待つ。navigator.locks がなければすぐに戻る(保存の直前の確かめだけで守る)
export async function claimEditor(root) {
  if (!navigator.locks?.request) return;
  // 読み込み直した直後は、前のページが権利を手放すまで少し待つ
  for (let i = 0; i < 8; i++) {
    if (await holdLock({ ifAvailable: true })) { listenFlush(); return; }
    await sleep(200);
  }
  await new Promise((resolve) => {
    root.innerHTML = guardHtml('tab-lock', {
      title: '別のタブで MADORI を開いています',
      text: '編集できるのは1つのタブだけです。このタブで編集すると、もう一方のタブは保存をやめます。',
      buttons: [['take', 'このタブで編集する', 'pill-accent']],
    });
    const el = root.querySelector('#tab-lock');
    el.querySelector('[data-guard="take"]').focus();
    el.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-guard="take"]');
      if (!btn) return;
      btn.disabled = true;
      setGuardMsg(el, '切り替えています…');
      await askFlush();
      await holdLock({ steal: true });
      root.innerHTML = '';
      resolve();
    });
  });
  listenFlush();
}

// ---- 案内の部品 ----

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// 全面の案内(role=alertdialog)。buttons: [[id, 文言, 'pill-accent' など], …]
function guardHtml(id, { title, text, buttons, extra = '' }) {
  return `<div id="${id}" class="guard" role="alertdialog" aria-modal="true" aria-labelledby="${id}-title" aria-describedby="${id}-text">
    <div class="guard-card">
      <h2 id="${id}-title" class="guard-title">${icon('warn', 22)}<span>${esc(title)}</span></h2>
      <p id="${id}-text" class="guard-text">${esc(text)}</p>
      <div class="guard-actions">${buttons.map(([b, label, cls]) => `<button type="button" class="pill ${cls}" data-guard="${b}">${esc(label)}</button>`).join('')}</div>
      ${extra}
      <p id="${id}-msg" class="guard-msg" role="status" aria-live="polite"></p>
    </div>
  </div>`;
}

function setGuardMsg(el, text, kind = 'info') {
  const m = el.querySelector('.guard-msg');
  if (!m) return;
  m.dataset.kind = kind;
  m.textContent = text;
}

// ---- 編集の画面に付ける案内 ----

let shellEl = null;
let centerEl = null;

function setInert(on) {
  if (!shellEl) return;
  shellEl.inert = on;
  if (on) shellEl.setAttribute('aria-hidden', 'true'); else shellEl.removeAttribute('aria-hidden');
}

function showOverlay(id, opts, onClick) {
  let el = document.getElementById(id);
  if (el) return el;
  document.body.insertAdjacentHTML('beforeend', guardHtml(id, opts));
  el = document.getElementById(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-guard]');
    if (b) onClick(b.dataset.guard, el);
  });
  setInert(true);
  el.querySelector('[data-guard]')?.focus();
  return el;
}

function removeOverlay(id) {
  document.getElementById(id)?.remove();
  if (!document.querySelector('.guard')) setInert(false);
}

// 読み込みの失敗: 編集を止め、バックアップの読み込み・保管場所からの復元・読み込み直しだけを出す
function renderLoadError() {
  if (!store.loadError) { removeOverlay('load-error'); return; }
  if (store.stopped) return;
  showOverlay('load-error', {
    title: '保存データを読めませんでした',
    text: 'この端末に保存した家のデータを読み込めませんでした。保存データは上書きしません(この画面では何も保存されません)。バックアップを読み込むか、保管場所から復元してください。一時的な不具合なら、もう一度読み込むと開けることがあります。',
    buttons: [['import', 'バックアップを読み込む', 'pill-accent'], ['restore', '保管場所から復元', 'pill-outline'], ['reload', 'もう一度読み込む', 'pill-ghost-inline']],
    extra: '<input type="file" accept=".madori,application/octet-stream" hidden>',
  }, (action, el) => {
    if (action === 'import') el.querySelector('input[type=file]').click();
    else if (action === 'reload') location.reload();
    else if (action === 'restore') {
      if (getSetting('syncUrl') && getSetting('editToken')) { restoreFromStore(); return; }
      // 保管場所の設定がない: 設定画面で入力してから復元する(ほかの操作はできないまま)
      el.classList.add('guard-compact');
      setInert(false);
      for (const sel of ['.topbar', '#left-pane', '#side-pane', '#backup-nudge']) { const x = shellEl.querySelector(sel); if (x) x.inert = true; }
      openSettings('保管場所から復元するには、保管場所のアドレスと編集用の合言葉を入力して保存し、「保管場所から復元」を押してください');
    }
  });
  const el = document.getElementById('load-error');
  el.querySelector('input[type=file]').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    importBackupFile(file);
  });
}

// 読み込みの失敗が直った(バックアップの読み込み・復元)ら、案内を外して操作できるようにする
function clearLoadError() {
  if (store.loadError || !document.getElementById('load-error')) return;
  removeOverlay('load-error');
  for (const sel of ['.topbar', '#left-pane', '#side-pane', '#backup-nudge']) { const x = shellEl?.querySelector(sel); if (x) x.inert = false; }
}

function renderMoved() {
  if (store.stopped !== 'moved') return;
  removeOverlay('load-error');
  document.getElementById('save-alert')?.setAttribute('hidden', '');
  showOverlay('tab-moved', {
    title: '別のタブに編集が移りました',
    text: 'このタブでの変更は保存されません。再読み込みすると、保存されている最新の内容で開きます。',
    buttons: [['reload', '再読み込み', 'pill-accent']],
  }, (action) => { if (action === 'reload') location.reload(); });
}

function renderSaveAlert() {
  const el = document.getElementById('save-alert');
  if (!el) return;
  const show = !!store.saveError && !store.stopped;
  el.hidden = !show;
  if (show && !el.firstElementChild) {
    el.innerHTML = `${icon('warn', 18)}
      <p class="save-alert-text">保存できませんでした。このページを閉じる前に、バックアップを書き出してください</p>
      <button type="button" class="pill pill-accent" data-action="save-alert-export">${icon('upload', 16)}<span>書き出す</span></button>`;
  }
}

async function renderPersistNote() {
  if (db.persistGranted !== false || store.loadError) return;
  let dismissed = false;
  try { dismissed = !!(await db.getSetting(PERSIST_KEY)); } catch { /* 読めなければ出す */ }
  if (dismissed || !centerEl) return;
  const el = document.createElement('div');
  el.id = 'persist-note';
  el.className = 'persist-note';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `${icon('warn', 18)}
    <p class="nudge-text">ブラウザがデータを消すことがあります。こまめにバックアップを書き出してください</p>
    <button type="button" class="icon-btn" aria-label="お知らせを閉じる" title="閉じる">${icon('close', 18)}</button>`;
  el.querySelector('button').addEventListener('click', () => {
    el.remove();
    db.setSetting(PERSIST_KEY, true).catch(() => {});
  });
  centerEl.prepend(el);
}

export function mountGuards(root) {
  shellEl = root.querySelector('.shell');
  centerEl = root.querySelector('.center');
  const bar = document.createElement('div');
  bar.id = 'save-alert';
  bar.className = 'save-alert';
  bar.setAttribute('role', 'alert');
  bar.hidden = true;
  shellEl.querySelector('.topbar').after(bar);
  bar.addEventListener('click', (e) => { if (e.target.closest('[data-action="save-alert-export"]')) exportBackup(); });
  store.on('save', () => { renderSaveAlert(); renderMoved(); });
  store.on('change', clearLoadError);
  renderLoadError();
  renderSaveAlert();
  renderMoved();
  renderPersistNote();
}
