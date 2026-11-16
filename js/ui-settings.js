// 設定(保管場所・スマホの QR・バックアップ)と、「スマホに送る」「書き出す」「読み込む」「保管場所から復元」
// 合言葉は入力欄(password)と、利用者が開いた QR の欄にだけ出す。状態の表示・エラーの文・ログには出さない
import { store } from './store.js';
import * as db from './db.js';
import { referencedHashes, normalize } from './model.js';
import { pack, unpack } from './container.js';
import { sha256Hex } from './blob.js';
import { createSync, SyncError, syncErrorMessage, viewerLink, normalizeSyncUrl, backupFileName } from './sync.js';
import { qrSvg } from './qr.js';
import { confirmDialog } from './dialog.js';
import { icon } from './icons.js';
import { createHub, normalizeHubUrl, hubErrorMessage, remainingText, resetHubState, QuotaExhaustedError } from './hub.js';

// 設定の保存先(db.setSetting のキー)。hubUrl・hubToken・hubConsent は立体モデル化(hub.js)が使う。
// hubToken は中継役への要求にだけ使い、保管場所・QR・バックアップ・家のデータには入れない
export const SETTING_KEYS = ['syncUrl', 'editToken', 'viewToken', 'hubUrl', 'hubToken', 'hubConsent', 'lastPushAt', 'lastBackupAt', 'etag'];
const NUDGE_DAYS = 14;
const NUDGE_KEY = 'madori-backup-nudge-dismissed';   // sessionStorage(このセッションの間だけ閉じる)

const settings = {};       // 読み込んだ設定の写し
let pane = null;           // #settings-pane
let busy = null;           // 'send' | 'export' | 'import' | 'restore'(同時に1つだけ)
let qrOpen = false;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const $ = (id) => document.getElementById(id);
const p2 = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${d.getHours()}:${p2(d.getMinutes())}`;
export function formatDateTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '不明';
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${hhmm(d)}`;
}
const roomCount = (h) => h.floors.reduce((s, f) => s + f.rooms.length, 0);
const hasContent = (h) => roomCount(h) > 0 || h.furniture.length > 0;
const summary = (h) => `「${h.name}」(更新 ${formatDateTime(h.updatedAt)}・部屋 ${roomCount(h)}・家具 ${h.furniture.length})`;

// ---- 設定の読み書き ----

export async function loadSettings() {
  for (const k of SETTING_KEYS) {
    try { settings[k] = await db.getSetting(k); } catch { settings[k] = undefined; }
  }
}

export const getSetting = (key) => settings[key];

export async function saveSetting(key, value) {
  settings[key] = value;
  await db.setSetting(key, value);
  renderNudge();
  renderTimes();
}

// ---- 状態の表示 ----

// 上部の状態の行(#app-status)。kind: 'info' | 'ok' | 'error'
export function setStatus(text, kind = 'info') {
  const el = $('app-status');
  if (!el) return;
  el.dataset.kind = kind;
  el.innerHTML = text ? `${kind === 'error' ? icon('warn', 16) : kind === 'ok' ? icon('check', 16) : ''}<span>${esc(text)}</span>` : '';
}

function setMsg(id, text, kind = 'info') {
  const el = $(id);
  if (!el) return;
  el.dataset.kind = kind;
  el.innerHTML = text ? `${kind === 'error' ? icon('warn', 16) : kind === 'ok' ? icon('check', 16) : ''}<span>${esc(text)}</span>` : '';
}

// バックアップの欄(読み込みの失敗の案内が出ていればその中、なければ設定画面の欄)
const backupMsgId = () => ($('load-error-msg') ? 'load-error-msg' : 'set-backup-msg');

// バックアップの結果: 読み込みの失敗の案内か設定画面を開いていればその欄、閉じていれば上部の状態の行
function backupMsg(text, kind) {
  if ($('load-error-msg')) setMsg('load-error-msg', text, kind);
  else if (store.mode === 'settings' && $('set-backup-msg')) setMsg('set-backup-msg', text, kind);
  else setStatus(text, kind);
}

const BUSY_IDS = ['send-btn', 'set-send', 'set-export', 'set-import', 'set-restore', 'nudge-export'];
function setBusy(v) {
  busy = v;
  for (const id of BUSY_IDS) { const b = $(id); if (b) b.disabled = !!v; }
  const send = $('send-btn');
  if (send) send.setAttribute('aria-busy', String(v === 'send'));
}

const errText = (e) => (e instanceof SyncError ? syncErrorMessage(e.code, { count: e.count }) : 'うまくいきませんでした。もう一度お試しください');

// ---- 使われなくなった画像の掃除(この Mac の IndexedDB) ----
// 残すもの: 今の家 + 取り消し・やり直しの履歴にある家が参照する画像、このページで最近保存した画像
// 消さないとき: 保存データを読めなかった(今の家は本物の家ではない)、最後の保存に失敗した(保存データが古い家を参照している)、
// このタブが編集の権利を持っていない(別のタブの家や、取り込んだばかりの画像を知らない)
export async function cleanupLocalBlobs() {
  if (store.loadError || store.saveError || store.stopped || !store.hasLock) return 0;
  try {
    const keep = new Set(db.recentBlobHashes());
    for (const h of [store.house, ...store.historyStates()]) for (const x of referencedHashes(h)) keep.add(x);
    const drop = (await db.listBlobHashes()).filter((h) => !keep.has(h));
    if (drop.length) await db.deleteBlobs(drop);
    return drop.length;
  } catch (e) {
    console.warn('使われなくなった画像を整理できませんでした', e?.name ?? 'Error');
    return 0;
  }
}

// ---- 家の差し替え(読み込み・復元)。取り消しの対象にせず、履歴も空にする ----
async function replaceHouse(house) {
  if (store.stopped) throw new Error('moved');
  if (store.loadError) store.allowOverwrite();   // 読めなかった保存データを、利用者の確認のうえで置き換える
  store.loadError = null;
  store.commit(house, { undoable: false });
  store.clearHistory();
  await store.flush();
  if (store.saveError) throw new Error('save-failed');
}

// ---- スマホに送る ----

export async function sendToPhones() {
  if (busy) return;
  const baseUrl = settings.syncUrl, token = settings.editToken;
  if (!baseUrl || !token) {
    openSettings('スマホに送るには、保管場所のアドレスと編集用の合言葉を設定してください');
    return;
  }
  if (store.loadError) {
    setStatus('保存されたデータを読めなかったため、送りません。バックアップの読み込みか、保管場所からの復元をお試しください', 'error');
    return;
  }
  setBusy('send');
  try {
    setStatus('送る準備をしています…');
    await store.flush();
    const house = store.house;
    const sync = createSync({ baseUrl, token });
    // この Mac の家が空なのに保管場所に家があれば、空の家で上書きしてよいか確かめる
    if (!hasContent(house)) {
      let remote = null;
      try { remote = (await sync.pull()).house; } catch (e) { if (!(e instanceof SyncError && e.code === 'empty')) throw e; }
      if (remote && hasContent(remote) && !(await confirmDialog({
        title: '空の家を送りますか',
        message: `この Mac の家は空です。送ると、保管場所の家${summary(remote)}が空の家に置き換わり、スマホでも見られなくなります。データが消えた場合は、設定の「保管場所から復元」を使ってください。`,
        ok: '空の家を送る', danger: true,
      }))) { setStatus('送るのをやめました'); return; }
    }
    const r = await sync.push(house, db.getBlob, ({ done, total, phase }) => {
      if (phase === 'blobs' && total) setStatus(`画像を送っています ${done} / ${total}`);
      else if (phase === 'blobs' || phase === 'manifest') setStatus('家のデータを送っています');
      else setStatus('使われなくなった画像を整理しています');
    });
    const at = new Date();
    await saveSetting('lastPushAt', at.toISOString());
    await saveSetting('etag', r.etag ?? null);
    const counts = `画像 新しく ${r.uploaded}件・送信済み ${r.skipped}件${r.deleted ? `・削除 ${r.deleted}件` : ''}`;
    setStatus(`送りました ${hhmm(at)}(${counts})${r.pruneFailed ? '。使われなくなった画像の整理は次の送信で行います' : ''}`, 'ok');
    await cleanupLocalBlobs();
  } catch (e) {
    setStatus(`送れませんでした。${errText(e)}`, 'error');
  } finally {
    setBusy(null);
  }
}

// ---- バックアップ ----

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const asBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

// 今の家と、参照している画像を .madori に書き出す。戻り値: { name, missing }
async function writeBackup() {
  const house = store.house;
  const blobs = [];
  let missing = 0;
  for (const hash of referencedHashes(house)) {
    const b = await db.getBlob(hash);
    if (b) blobs.push({ hash, type: b.type, bytes: asBytes(b.bytes) });
    else missing++;
  }
  const at = new Date();
  const name = backupFileName(at);
  download(pack(house, blobs), name);
  await saveSetting('lastBackupAt', at.toISOString());
  return { name, missing };
}

export async function exportBackup() {
  if (busy) return;
  // 読めなかったときの家は空の家(本物の家ではない)。書き出すと本物と取り違え、画像の掃除で本物の画像を消すので止める
  if (store.loadError) {
    backupMsg('保存データを読めなかったため、書き出せません。先にバックアップの読み込みか、保管場所からの復元をしてください', 'error');
    return;
  }
  setBusy('export');
  try {
    const { name, missing } = await writeBackup();
    backupMsg(`書き出しました: ${name}${missing ? `(画像 ${missing}件はこの Mac に見つからないため含めていません)` : ''}`, missing ? 'error' : 'ok');
    await cleanupLocalBlobs();
  } catch (e) {
    console.warn('バックアップを書き出せませんでした', e?.name ?? 'Error');
    backupMsg('バックアップを書き出せませんでした。もう一度お試しください', 'error');
  } finally {
    setBusy(null);
  }
}

const IMPORT_ERRORS = {
  'not-madori': 'MADORI のバックアップではありません',
  truncated: 'ファイルが途中で切れています。もう一度書き出したファイルを使ってください',
  version: 'このバックアップは新しい版のアプリで作られています',
  broken: 'ファイルの中の画像が壊れています。もう一度書き出したファイルを使ってください',
};

class ImportError extends Error {}

// ファイル → 確認 → 画像を保存 → 家を差し替え。失敗したら今のデータはそのまま
export async function importBackupFile(file) {
  if (busy || !file) return;
  setBusy('import');
  try {
    setMsg(backupMsgId(), 'ファイルを読んでいます…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let data;
    try { data = unpack(bytes); } catch (e) { throw new ImportError(e.message === 'truncated' ? 'truncated' : 'not-madori'); }
    let house;
    try { house = normalize(data.house); } catch { throw new ImportError((data.house.version ?? 1) !== 1 ? 'version' : 'not-madori'); }
    for (const b of data.blobs) if ((await sha256Hex(b.bytes)) !== b.hash) throw new ImportError('broken');
    setMsg(backupMsgId(), '');
    const ok = await confirmDialog({
      title: 'バックアップを読み込みますか',
      message: `バックアップの家${summary(house)}で、${store.loadError ? '読めなかった保存データ' : `今の家${summary(store.house)}`}を置き換えます。この操作は取り消せません。`,
      ok: '読み込む', danger: true,
    });
    if (!ok) { setMsg(backupMsgId(), '読み込みをやめました'); return; }
    for (const b of data.blobs) await db.putBlob({ hash: b.hash, type: b.type, bytes: b.bytes });
    await replaceHouse(house);
    setMsg(backupMsgId(), `読み込みました: ${summary(house)}`, 'ok');
  } catch (e) {
    const msg = e instanceof ImportError ? IMPORT_ERRORS[e.message]
      : e?.message === 'save-failed' ? '読み込みましたが、保存できませんでした。空き容量を確かめてください'
        : 'バックアップを読み込めませんでした。もう一度お試しください';
    setMsg(backupMsgId(), msg, 'error');
  } finally {
    setBusy(null);
  }
}

// ---- 保管場所から復元 ----
export async function restoreFromStore() {
  if (busy) return;
  const baseUrl = settings.syncUrl, token = settings.editToken;
  if (!baseUrl || !token) {
    openSettings('保管場所から復元するには、保管場所のアドレスと編集用の合言葉を設定してください');
    return;
  }
  setBusy('restore');
  try {
    setMsg(backupMsgId(), '保管場所を確かめています…');
    const sync = createSync({ baseUrl, token });
    const r = await sync.pull();
    const remote = r.house;
    const local = store.house;
    const backup = !store.loadError && hasContent(local);
    setMsg(backupMsgId(), '');
    const ok = await confirmDialog({
      title: '保管場所から復元しますか',
      message: `保管場所の家${summary(remote)}で、${store.loadError ? '読めなかった保存データ' : `この Mac の家${summary(local)}`}を置き換えます。${backup ? '置き換える前に、今のデータをバックアップとして書き出します。' : ''}`,
      ok: '復元する', danger: true,
    });
    if (!ok) { setMsg(backupMsgId(), '復元をやめました'); return; }
    if (backup) {
      try { await writeBackup(); } catch {
        setMsg(backupMsgId(), '今のデータを書き出せなかったため、復元をやめました', 'error');
        return;
      }
    }
    const have = new Set(await db.listBlobHashes());
    const need = referencedHashes(remote).filter((h) => !have.has(h));
    let done = 0;
    const progress = () => setMsg(backupMsgId(), `画像を受け取っています ${done} / ${need.length}`);
    if (need.length) progress();
    let next = 0;
    let failure = null;
    await Promise.all(Array.from({ length: Math.min(4, need.length) }, async () => {
      while (!failure && next < need.length) {
        const hash = need[next++];
        try {
          const b = await sync.fetchBlob(hash);
          await db.putBlob({ hash, type: b.type, bytes: b.bytes });
          done++;
          progress();
        } catch (e) { failure ??= e; }
      }
    }));
    if (failure) throw failure;
    await replaceHouse(remote);
    await saveSetting('etag', r.etag ?? null);
    setMsg(backupMsgId(), `復元しました: ${summary(remote)}`, 'ok');
  } catch (e) {
    const msg = e?.message === 'save-failed' ? '復元しましたが、保存できませんでした。空き容量を確かめてください' : `復元できませんでした。${errText(e)}`;
    setMsg(backupMsgId(), msg, 'error');
  } finally {
    setBusy(null);
  }
}

// ---- バックアップのおすすめ(上部の帯) ----

const daysSince = (iso) => {
  const t = new Date(iso ?? '').getTime();
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 864e5;
};

function nudgeDismissed() {
  try { return sessionStorage.getItem(NUDGE_KEY) === '1'; } catch { return false; }
}

export function shouldNudge(house = store.house) {
  if (roomCount(house) < 1 || nudgeDismissed()) return false;
  return daysSince(settings.lastPushAt) > NUDGE_DAYS && daysSince(settings.lastBackupAt) > NUDGE_DAYS;
}

export function renderNudge() {
  const el = $('backup-nudge');
  if (!el) return;
  const show = shouldNudge();
  el.hidden = !show;
  if (!show) return;
  const never = !settings.lastPushAt && !settings.lastBackupAt;
  const text = never ? 'まだ一度もバックアップの書き出しも送信もしていません' : `最後の書き出し・送信から${NUDGE_DAYS}日以上たっています`;
  const sig = `${never}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.innerHTML = `${icon('warn', 18)}
    <p class="nudge-text"><strong>バックアップをおすすめします</strong><span>${esc(text)}</span></p>
    <button type="button" id="nudge-export" class="pill pill-accent" data-action="nudge-export"${busy ? ' disabled' : ''}>${icon('upload', 16)}<span>書き出す</span></button>
    <button type="button" id="nudge-close" class="icon-btn" data-action="nudge-close" aria-label="おすすめを閉じる" title="閉じる">${icon('close', 18)}</button>`;
}

export function mountNudge(el) {
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'nudge-export') exportBackup();
    if (btn.id === 'nudge-close') {
      try { sessionStorage.setItem(NUDGE_KEY, '1'); } catch { /* 保存できなくても今は閉じる */ }
      el.hidden = true;
    }
  });
  renderNudge();
}

// ---- 設定画面 ----

// focus: 'hub' なら立体モデル化の欄へ(家具のフォームの「設定を開く」から)
export function openSettings(message = '', { focus = null } = {}) {
  store.setMode('settings');
  renderSettings();
  setMsg('set-msg', message, message ? 'error' : 'info');
  if (focus === 'hub') {
    const el = (settings.hubUrl ? $('hub-token') : $('hub-url'));
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  } else if (message) (settings.syncUrl ? $('set-edit') : $('set-url'))?.focus();
}

const secretField = (id, label, hint) => `
  <div class="set-field">
    <label for="${id}">${label}</label>
    <div class="set-secret">
      <input id="${id}" type="password" autocomplete="off" spellcheck="false" aria-describedby="${id}-hint">
      <button type="button" class="pill pill-ghost-inline set-reveal" aria-controls="${id}" aria-pressed="false" aria-label="${label}を表示">表示</button>
    </div>
    <p id="${id}-hint" class="set-hint">${hint}</p>
  </div>`;

const TEMPLATE = `
<div class="set">
  <div class="set-head">
    <h2 class="set-title">設定</h2>
    <p id="set-msg" class="set-msg" role="status" aria-live="polite"></p>
  </div>
  <div class="set-grid">
    <section class="set-card" aria-labelledby="set-store-cap">
      <h3 id="set-store-cap" class="set-cap">保管場所</h3>
      <p class="set-hint">「スマホに送る」の送り先(madori-sync)です。</p>
      <form id="set-form" class="set-form" novalidate>
        <div class="set-field">
          <label for="set-url">アドレス</label>
          <input id="set-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://madori-sync.〇〇.workers.dev" aria-describedby="set-url-err">
          <p id="set-url-err" class="set-err"></p>
        </div>
        ${secretField('set-edit', '編集用の合言葉', 'この Mac から書き込むときに使います。')}
        ${secretField('set-view', '閲覧用の合言葉', 'スマホで見るときに使います(QRコードに入ります)。')}
        <div class="set-actions">
          <button type="submit" id="set-save" class="pill pill-accent">${icon('check', 16)}<span>保存する</span></button>
          <button type="button" id="set-check" class="pill pill-ghost-inline">接続を確認</button>
          <button type="button" id="set-send" class="pill pill-outline">${icon('phone', 16)}<span>スマホに送る</span></button>
        </div>
        <p id="set-store-msg" class="set-msg" role="status" aria-live="polite"></p>
      </form>
    </section>
    <section class="set-card" aria-labelledby="set-phone-cap">
      <h3 id="set-phone-cap" class="set-cap">スマホ</h3>
      <div id="set-phone"></div>
    </section>
    <section class="set-card" aria-labelledby="set-backup-cap">
      <h3 id="set-backup-cap" class="set-cap">バックアップ</h3>
      <p class="set-hint">この Mac のデータを1つのファイル(.madori)に書き出します。データが消えたときは、読み込むか保管場所から復元できます。</p>
      <div class="set-actions">
        <button type="button" id="set-export" class="pill pill-accent">${icon('upload', 16)}<span>バックアップを書き出す</span></button>
        <button type="button" id="set-import" class="pill pill-ghost-inline">バックアップを読み込む</button>
        <input id="set-import-file" type="file" accept=".madori,application/octet-stream" hidden>
        <button type="button" id="set-restore" class="pill pill-ghost-inline">保管場所から復元</button>
      </div>
      <dl class="set-times">
        <div><dt>最後の送信</dt><dd id="set-last-push"></dd></div>
        <div><dt>最後の書き出し</dt><dd id="set-last-backup"></dd></div>
      </dl>
      <p id="set-backup-msg" class="set-msg" role="status" aria-live="polite"></p>
    </section>
    <section class="set-card set-slot" data-slot="hub-settings" aria-labelledby="hub-cap">
      <h3 id="hub-cap" class="set-cap">立体モデル化</h3>
      <p class="set-hint">家具の写真から立体モデルを作る中継役(imagegen-hub)です。写真は中継役を通して外部のサービス(Hugging Face)に送られます。1日 3回まで。</p>
      <form id="hub-form" class="set-form" novalidate>
        <div class="set-field">
          <label for="hub-url">立体モデル化のアドレス</label>
          <input id="hub-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://imagegen-hub.〇〇.workers.dev" aria-describedby="hub-url-err">
          <p id="hub-url-err" class="set-err"></p>
        </div>
        ${secretField('hub-token', '合言葉', '中継役の合言葉(HUB_TOKEN)です。この Mac にだけ保存し、スマホやバックアップには入れません。')}
        <div class="set-actions">
          <button type="submit" id="hub-save" class="pill pill-accent">${icon('check', 16)}<span>保存する</span></button>
          <button type="button" id="hub-check" class="pill pill-ghost-inline">残り回数を確認</button>
        </div>
        <p id="hub-msg" class="set-msg" role="status" aria-live="polite"></p>
      </form>
    </section>
  </div>
</div>`;

export function mountSettings(el) {
  pane = el;
  el.addEventListener('click', onClick);
  el.addEventListener('submit', (e) => { e.preventDefault(); if (e.target.id === 'hub-form') saveHubForm(); else saveForm(); });
  el.addEventListener('change', (e) => {
    if (e.target.id !== 'set-import-file') return;
    const file = e.target.files?.[0];
    e.target.value = '';
    importBackupFile(file);
  });
  el.addEventListener('input', (e) => {
    if (e.target.id === 'set-url' || e.target.id === 'hub-url') { $(`${e.target.id}-err`).textContent = ''; e.target.removeAttribute('aria-invalid'); }
  });
  store.on('view', ({ mode }) => {
    if (mode === 'settings') { if (!pane.firstElementChild) renderSettings(); }
    else if (pane.firstElementChild) { pane.innerHTML = ''; qrOpen = false; }   // 閉じたら合言葉の入った欄を消す
  });
}

export function renderSettings() {
  if (!pane) return;
  qrOpen = false;
  pane.innerHTML = TEMPLATE;
  // 値は属性ではなくプロパティで入れる(合言葉を HTML に書かない)
  $('set-url').value = settings.syncUrl ?? '';
  $('set-edit').value = settings.editToken ?? '';
  $('set-view').value = settings.viewToken ?? '';
  $('hub-url').value = settings.hubUrl ?? '';
  $('hub-token').value = settings.hubToken ?? '';
  renderPhone();
  renderTimes();
  setBusy(busy);
}

function renderTimes() {
  const push = $('set-last-push'), backup = $('set-last-backup');
  if (push) push.textContent = settings.lastPushAt ? formatDateTime(settings.lastPushAt) : 'まだありません';
  if (backup) backup.textContent = settings.lastBackupAt ? formatDateTime(settings.lastBackupAt) : 'まだありません';
}

const appUrl = () => location.origin + location.pathname;

function renderPhone() {
  const el = $('set-phone');
  if (!el) return;
  if (!settings.syncUrl || !settings.viewToken) {
    qrOpen = false;
    el.innerHTML = '<p class="set-hint">保管場所のアドレスと閲覧用の合言葉を保存すると、スマホ用のQRコードを表示できます。</p>';
    return;
  }
  const link = qrOpen ? viewerLink(appUrl(), settings.syncUrl, settings.viewToken) : '';
  el.innerHTML = `
    <p class="set-hint">スマホのカメラで読み取ると、閲覧用の画面が開きます。</p>
    <button type="button" id="set-qr-btn" class="pill pill-ghost-inline" aria-expanded="${qrOpen}" aria-controls="set-qr-box">${qrOpen ? 'QRコードを隠す' : 'スマホ用のQRコードを表示'}</button>
    <div id="set-qr-box" class="set-qr-box"${qrOpen ? '' : ' hidden'}>
      ${qrOpen ? `
      <div id="set-qr" class="set-qr">${qrSvg(link, { size: 256 })}</div>
      <div class="set-field">
        <label for="set-link">リンク</label>
        <input id="set-link" type="text" readonly spellcheck="false">
      </div>
      <div class="set-actions"><button type="button" id="set-copy" class="pill pill-ghost-inline">${icon('copy', 16)}<span>リンクをコピー</span></button></div>
      <p class="set-hint">このQRコードとリンクには閲覧用の合言葉が入っています。家族以外に見せないでください。</p>
      <p id="set-copy-msg" class="set-msg" role="status" aria-live="polite"></p>` : ''}
    </div>`;
  if (qrOpen) $('set-link').value = link;
}

// 入力を確かめて保存する。戻り値: 保存できたか
async function saveForm({ quiet = false } = {}) {
  const raw = $('set-url').value;
  let url = '';
  if (raw.trim()) {
    const r = normalizeSyncUrl(raw);
    if (!r.ok) {
      const input = $('set-url');
      input.setAttribute('aria-invalid', 'true');
      $('set-url-err').textContent = 'アドレスは https:// で始まる形で入力してください(例: https://madori-sync.〇〇.workers.dev)';
      input.focus();
      return false;
    }
    url = r.url;
  }
  const edit = $('set-edit').value.trim();
  const view = $('set-view').value.trim();
  try {
    await saveSetting('syncUrl', url);
    await saveSetting('editToken', edit);
    await saveSetting('viewToken', view);
  } catch {
    setMsg('set-store-msg', '設定を保存できませんでした。もう一度お試しください', 'error');
    return false;
  }
  $('set-url').value = url;
  $('set-url-err').textContent = '';
  setMsg('set-msg', '');
  if (!quiet) setMsg('set-store-msg', '保存しました', 'ok');
  renderPhone();
  return true;
}

// 立体モデル化の設定を保存する。戻り値: 保存できたか
async function saveHubForm({ quiet = false } = {}) {
  const raw = $('hub-url').value;
  let url = '';
  if (raw.trim()) {
    const r = normalizeHubUrl(raw);
    if (!r.ok) {
      const input = $('hub-url');
      input.setAttribute('aria-invalid', 'true');
      $('hub-url-err').textContent = 'アドレスは https:// で始まる形で入力してください(例: https://imagegen-hub.〇〇.workers.dev)';
      input.focus();
      return false;
    }
    url = r.url;
  }
  try {
    await saveSetting('hubUrl', url);
    await saveSetting('hubToken', $('hub-token').value.trim());
  } catch {
    setMsg('hub-msg', '設定を保存できませんでした。もう一度お試しください', 'error');
    return false;
  }
  resetHubState();
  $('hub-url').value = url;
  $('hub-url-err').textContent = '';
  if (!quiet) setMsg('hub-msg', '保存しました', 'ok');
  return true;
}

async function checkHub() {
  if (!(await saveHubForm({ quiet: true }))) return;
  if (!settings.hubUrl || !settings.hubToken) {
    setMsg('hub-msg', '立体モデル化のアドレスと合言葉を入力してください', 'error');
    return;
  }
  const btn = $('hub-check');
  btn.disabled = true;
  setMsg('hub-msg', '確かめています…');
  try {
    const q = await createHub({ baseUrl: settings.hubUrl, token: settings.hubToken }).quota();
    const text = q.remaining > 0 ? `つながりました。${remainingText(q.remaining)}` : `つながりました。${remainingText(0)}(${new QuotaExhaustedError('model3d', q.resetAt).message})`;
    setMsg('hub-msg', text, 'ok');
  } catch (e) {
    setMsg('hub-msg', hubErrorMessage(e), 'error');
  } finally {
    if ($('hub-check')) $('hub-check').disabled = false;
  }
}

async function checkConnection() {
  const btn = $('set-check');
  if (!(await saveForm({ quiet: true }))) return;
  if (!settings.syncUrl || !settings.editToken) {
    setMsg('set-store-msg', 'アドレスと編集用の合言葉を入力してください', 'error');
    return;
  }
  btn.disabled = true;
  setMsg('set-store-msg', '確かめています…');
  try {
    const sync = createSync({ baseUrl: settings.syncUrl, token: settings.editToken });
    await sync.checkWrite();
    let text;
    try {
      const r = await sync.pull();
      text = `つながりました。保管場所の家${summary(r.house)}`;
    } catch (e) {
      if (!(e instanceof SyncError && e.code === 'empty')) throw e;
      text = 'つながりました。保管場所はまだ空です(「スマホに送る」で送れます)';
    }
    if (settings.viewToken) {
      try { await createSync({ baseUrl: settings.syncUrl, token: settings.viewToken }).pull(); } catch (e) {
        if (e instanceof SyncError && e.code === 'unauthorized') {
          setMsg('set-store-msg', `${text}。ただし、閲覧用の合言葉が違います。設定を確認してください`, 'error');
          return;
        }
        if (!(e instanceof SyncError && e.code === 'empty')) throw e;
      }
    }
    setMsg('set-store-msg', text, 'ok');
  } catch (e) {
    setMsg('set-store-msg', errText(e), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function copyLink() {
  const input = $('set-link');
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
    setMsg('set-copy-msg', 'リンクをコピーしました', 'ok');
  } catch {
    input.focus();
    input.select();
    setMsg('set-copy-msg', 'リンクを選びました。⌘C でコピーしてください');
  }
}

function onClick(e) {
  const btn = e.target.closest('button');
  if (!btn || !pane.contains(btn)) return;
  if (btn.classList.contains('set-reveal')) {
    const input = $(btn.getAttribute('aria-controls'));
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.textContent = show ? '隠す' : '表示';
    return;
  }
  switch (btn.id) {
    case 'set-check': return checkConnection();
    case 'hub-check': return checkHub();
    case 'set-send': return sendToPhones();
    case 'set-qr-btn': qrOpen = !qrOpen; renderPhone(); $('set-qr-btn')?.focus(); return;
    case 'set-copy': return copyLink();
    case 'set-export': return exportBackup();
    case 'set-import': return $('set-import-file').click();
    case 'set-restore': return restoreFromStore();
    default: return;
  }
}
