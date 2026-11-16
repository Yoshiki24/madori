// 家具台帳: 一覧(カード)・絞り込み・編集フォーム(<dialog>)
//   mountCatalog(el)              ui-shell が #catalog-pane に呼ぶ
//   openFurnitureForm(id | null)  null なら新しい家具
//   furnitureCardHtml(f, url, { usage, compact })  カードの中身(押せる部品を含まない。右の一覧・閲覧画面でも使う)
//     usage: furnitureUsage の結果(渡すと置き場所の行を出す)。compact: 種類を省く(狭い右の一覧)
import { store } from './store.js';
import { addFurniture, updateFurniture, removeFurniture, furnitureUsage } from './model.js';
import { importImage, dominantColor, PHOTO_MAX } from './blob.js';
import { putBlob, blobUrl } from './db.js';
import { KINDS } from './shapes.js';
import { formatMm } from './scale.js';
import { confirmDialog } from './dialog.js';
import { icon } from './icons.js';
import { furnitureCardHtml } from './fcard.js';
import { isUnreadableModel, onUnreadableModel } from './view3d.js';
import { getSetting, saveSetting, openSettings } from './ui-settings.js';
import {
  connectHub, startModelJob, jobState, runningJob, onJobChange, quotaState, refreshQuota, hubConfigured,
  MSG_HUB, remainingText,
} from './hub.js';
import {
  STATUSES, DEFAULT_COLOR, MSG, statusLabel, kindLabel, formatPrice, checkUrl,
  validateFurniture, usageLabels, deleteMessage, filterFurniture,
} from './catalog-logic.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c ?? '') ? c : DEFAULT_COLOR);
const FIELDS = ['name', 'width', 'depth', 'height', 'price', 'url'];   // 誤りを出す欄(上から順)

// ---- 写真の URL(取り出したものを覚える。取れたら知らせる) ----

const urls = {};
const loading = new Set();
const photoListeners = new Set();

export function photoUrl(hash) {
  if (!hash) return null;
  if (urls[hash]) return urls[hash];
  if (!loading.has(hash)) {
    loading.add(hash);
    blobUrl(hash)
      .then((u) => { if (u) { urls[hash] = u; for (const fn of photoListeners) fn(); } })
      .catch(() => {})
      .finally(() => loading.delete(hash));
  }
  return null;
}

export function onPhotoReady(fn) {
  photoListeners.add(fn);
  return () => photoListeners.delete(fn);
}

// ---- 立体モデル化(hub.js)。作成中の仕事はフォームを閉じても続く ----

connectHub({ getHouse: () => store.house, commit: (h) => store.commit(h), getSetting });
onJobChange(() => { renderList(); renderModelSlot(); });
onUnreadableModel(() => renderModelSlot());

const jobLine = (id) => (jobState(id)?.status === 'running'
  ? `<p class="cat-job" role="status">${icon('refresh', 16)}<span>${MSG_HUB.running}</span></p>` : '');

// ---- カード(fcard.js。ここからも使えるように出し直す) ----

export { furnitureCardHtml };

// ---- 一覧 ----

let root = null;
const filters = { status: '', kind: '', roomId: '', q: '' };
const $ = (sel) => root.querySelector(sel);

const option = (value, label, cur) => `<option value="${esc(value)}"${value === cur ? ' selected' : ''}>${esc(label)}</option>`;

export function mountCatalog(el) {
  root = el;
  root.innerHTML = `<div class="cat">
    <header class="cat-head">
      <h2 class="cat-title">家具台帳</h2>
      <p id="cat-count" class="cat-count" aria-live="polite"></p>
      <span class="spacer"></span>
      <button type="button" id="cat-add-btn" class="pill pill-accent" data-action="add-furniture">${icon('plus', 18)}<span>家具を追加</span></button>
    </header>
    <div class="cat-filters" role="search" aria-label="家具の絞り込み">
      <div class="cat-filter"><label for="cat-filter-status">状態</label>
        <select id="cat-filter-status" data-filter="status">${option('', 'すべて', '')}${STATUSES.map((s) => option(s.id, s.label, '')).join('')}</select></div>
      <div class="cat-filter"><label for="cat-filter-kind">種類</label>
        <select id="cat-filter-kind" data-filter="kind">${option('', 'すべて', '')}${KINDS.map((k) => option(k.id, k.label, '')).join('')}</select></div>
      <div class="cat-filter"><label for="cat-filter-room">置いてある部屋</label>
        <select id="cat-filter-room" data-filter="roomId"></select></div>
      <div class="cat-filter cat-filter-q"><label for="cat-filter-q">名前で探す</label>
        <input id="cat-filter-q" data-filter="q" type="search" autocomplete="off"></div>
    </div>
    <div class="cat-scroll">
      <ul id="cat-list" class="cat-list"></ul>
      <div id="cat-empty" class="cat-empty" hidden>
        ${icon('book', 32)}
        <p>家具台帳はまだ空です。持っている家具や、買うか考えている商品を登録しましょう。<br>写真はファイルを選ぶほか、ドラッグや、ネットの商品画像をコピーして貼り付けても入れられます。</p>
        <button type="button" class="pill pill-accent" data-action="add-furniture">${icon('plus', 18)}<span>家具を追加</span></button>
      </div>
      <div id="cat-nomatch" class="cat-empty" hidden>
        <p>条件に合う家具はありません。</p>
        <button type="button" class="pill pill-ghost-inline" data-action="clear-filters">絞り込みを解除</button>
      </div>
    </div>
  </div>`;
  root.addEventListener('click', onListClick);
  root.addEventListener('change', onFilter);
  root.addEventListener('input', onFilter);
  store.on('change', renderCatalog);
  store.on('change', renderModelSlot);
  onPhotoReady(renderCatalog);
  renderCatalog();
}

function onFilter(e) {
  const key = e.target?.dataset?.filter;
  if (!key) return;
  filters[key] = e.target.value;
  renderList();
}

function renderRoomOptions() {
  const sel = $('#cat-filter-room');
  const rooms = store.house.floors.flatMap((f) => f.rooms.map((r) => ({ id: r.id, label: store.house.floors.length > 1 ? `${f.name} ${r.name}` : r.name })));
  if (filters.roomId && filters.roomId !== '__none' && !rooms.some((r) => r.id === filters.roomId)) filters.roomId = '';
  sel.innerHTML = option('', 'すべて', filters.roomId) + rooms.map((r) => option(r.id, r.label, filters.roomId)).join('') + option('__none', 'どこにも置いていない', filters.roomId);
}

export function renderCatalog() {
  if (!root) return;
  renderRoomOptions();
  renderList();
}

function renderList() {
  if (!root) return;
  const { house } = store;
  const total = house.furniture.length;
  const list = filterFurniture(house, filters);
  $('#cat-count').textContent = total === list.length ? `${total}件` : `${total}件中 ${list.length}件`;
  $('#cat-empty').hidden = total > 0;
  $('#cat-nomatch').hidden = total === 0 || list.length > 0;
  // 描き直しのあともフォーカスを保つ(同じ家具の同じボタン)
  const a = document.activeElement;
  const keep = a && root.contains(a) && a.closest('#cat-list') ? { id: a.dataset.furnitureId, action: a.dataset.action } : null;
  $('#cat-list').innerHTML = list.map((f) => {
    const link = f.url && checkUrl(f.url).ok
      ? `<a class="pill pill-ghost-inline cat-link" href="${esc(f.url)}" rel="noopener noreferrer" target="_blank">${icon('external', 16)}<span>商品ページ</span><span class="sr-only">(新しいタブで開く)</span></a>` : '';
    return `<li class="cat-item" data-furniture-id="${esc(f.id)}">
      ${furnitureCardHtml(f, photoUrl(f.photo), { usage: furnitureUsage(house, f.id) })}
      ${jobLine(f.id)}
      <div class="cat-actions">
        ${link}
        <span class="spacer"></span>
        <button type="button" class="pill pill-ghost-inline" data-action="edit-furniture" data-furniture-id="${esc(f.id)}" aria-label="「${esc(f.name)}」を編集">${icon('edit', 16)}<span aria-hidden="true">編集</span></button>
        <button type="button" class="pill pill-danger-outline" data-action="delete-furniture" data-furniture-id="${esc(f.id)}" aria-label="「${esc(f.name)}」を削除">${icon('trash', 16)}<span aria-hidden="true">削除</span></button>
      </div>
    </li>`;
  }).join('');
  if (keep) root.querySelector(`#cat-list [data-action="${keep.action}"][data-furniture-id="${CSS.escape(keep.id ?? '')}"]`)?.focus();
}

function onListClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, furnitureId } = btn.dataset;
  if (action === 'add-furniture') openFurnitureForm(null);
  else if (action === 'edit-furniture') openFurnitureForm(furnitureId);
  else if (action === 'delete-furniture') deleteFurniture(furnitureId);
  else if (action === 'clear-filters') {
    Object.assign(filters, { status: '', kind: '', roomId: '', q: '' });
    for (const el of root.querySelectorAll('[data-filter]')) el.value = '';
    renderList();
    $('#cat-filter-status').focus();
  }
}

// 台帳から消す(置いてあれば部屋を示して確かめる)。消したら true
export async function deleteFurniture(id) {
  const f = store.house.furniture.find((x) => x.id === id);
  if (!f) return false;
  const ok = await confirmDialog({
    title: `「${f.name}」を削除しますか`,
    message: deleteMessage(furnitureUsage(store.house, id)),
    ok: '削除する',
    danger: true,
  });
  if (!ok) return false;
  store.commit(removeFurniture(store.house, id));
  return true;
}

// ---- 編集フォーム ----

let dlg = null;
let st = null;   // フォームの状態(開くたびに作り直す)

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.id = 'furniture-dialog';
  dlg.className = 'ff-dialog';
  dlg.setAttribute('aria-labelledby', 'ff-title');
  dlg.addEventListener('close', onClose);
  dlg.addEventListener('submit', onSubmit);
  dlg.addEventListener('click', onFormClick);
  dlg.addEventListener('input', onFormInput);
  dlg.addEventListener('change', onFormChange);
  dlg.addEventListener('focusout', onFormBlur);
  dlg.addEventListener('keydown', (e) => {
    // フォームの中では、入力欄の外でも ⌘Z で家を取り消さない(編集中の家具が消えないように)
    if ((e.metaKey || e.ctrlKey) && /^[zy]$/i.test(e.key)) e.preventDefault();
  });
  dlg.addEventListener('dragover', (e) => {
    if (!e.target.closest?.('#ff-photo') || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dlg.querySelector('#ff-photo').classList.add('drop');
  });
  dlg.addEventListener('dragleave', (e) => { if (e.target.closest?.('#ff-photo')) dlg.querySelector('#ff-photo').classList.remove('drop'); });
  dlg.addEventListener('drop', (e) => {
    const area = e.target.closest?.('#ff-photo');
    if (!area) return;
    e.preventDefault();
    area.classList.remove('drop');
    const file = e.dataTransfer?.files?.[0];
    if (file) importPhoto(file);
  });
  document.addEventListener('paste', onPaste);
  document.body.append(dlg);
  return dlg;
}

const field = (key, label, input, { hint = '', cls = '' } = {}) => `<div class="ff-field ${cls}">
  <label for="ff-${key}">${label}</label>
  ${input}
  ${hint ? `<p id="ff-${key}-hint" class="ff-hint">${hint}</p>` : ''}
  <p id="ff-${key}-err" class="ff-err"></p>
</div>`;
const desc = (key, hint = false) => `aria-describedby="${hint ? `ff-${key}-hint ` : ''}ff-${key}-err"`;
const textIn = (key, value, extra = '') => `<input id="ff-${key}" name="${key}" type="text" value="${esc(value)}" ${desc(key)} autocomplete="off" ${extra}>`;

export function openFurnitureForm(furnitureId = null) {
  const d = ensureDialog();
  if (d.open) d.close('cancel');
  const f = furnitureId ? store.house.furniture.find((x) => x.id === furnitureId) : null;
  if (furnitureId && !f) return;
  st = {
    id: f?.id ?? null,
    photo: f?.photo ?? null,
    pending: null,          // 取り込んだばかりの写真 { hash, type, bytes }(保存のときに IndexedDB へ)
    preview: null,          // pending のプレビューの blob: URL
    colorTouched: false,    // このフォームで色を手で変えたら true(写真で上書きしない)
    importing: null,
    submitted: false,
    returnFocus: document.activeElement,
  };
  const v = f ?? { name: '', kind: 'box', width: '', depth: '', height: '', status: 'owned', price: null, url: '', memo: '', color: DEFAULT_COLOR };
  d.innerHTML = `<form id="ff-form" class="ff-form" method="dialog" novalidate>
    <header class="ff-head">
      <h2 id="ff-title" class="ff-title">${f ? '家具を編集' : '家具を追加'}</h2>
      <button type="button" id="ff-close" class="icon-btn" data-ff="cancel" aria-label="閉じる">${icon('close')}</button>
    </header>
    <div class="ff-body">
      <div class="ff-side">
        <div id="ff-photo" class="ff-photo"></div>
        <div class="ff-photo-btns">
          <button type="button" id="ff-photo-pick" class="pill pill-ghost-inline" data-ff="pick">${icon('image', 18)}<span>写真を選ぶ</span></button>
          <button type="button" id="ff-photo-remove" class="pill pill-ghost-inline" data-ff="remove-photo">${icon('close', 18)}<span>写真を外す</span></button>
        </div>
        <input id="ff-photo-file" type="file" accept="image/*" hidden>
        <p id="ff-photo-msg" class="ff-err" role="status"></p>
        <div class="ff-field ff-color">
          <label for="ff-color">色</label>
          <span class="ff-color-in"><input id="ff-color" name="color" type="color" value="${esc(safeColor(v.color))}" aria-describedby="ff-color-hint"><span id="ff-color-hint" class="ff-hint">写真を入れると写真の色になります</span></span>
        </div>
        <div class="ff-slot" data-slot="model3d"></div>
      </div>
      <div class="ff-main">
        ${field('name', '名前', textIn('name', v.name, 'required aria-required="true"'))}
        <div class="ff-row">
          ${field('kind', '種類', `<select id="ff-kind" name="kind">${KINDS.map((k) => option(k.id, k.label, v.kind)).join('')}</select>`)}
          ${field('status', '状態', `<select id="ff-status" name="status">${STATUSES.map((s) => option(s.id, s.label, v.status)).join('')}</select>`)}
        </div>
        <div class="ff-row ff-row-3">
          ${field('width', '幅(mm)', textIn('width', v.width, 'inputmode="decimal" required aria-required="true"'))}
          ${field('depth', '奥行(mm)', textIn('depth', v.depth, 'inputmode="decimal" required aria-required="true"'))}
          ${field('height', '高さ(mm)', textIn('height', v.height, 'inputmode="decimal" required aria-required="true"'))}
        </div>
        ${field('price', '価格(円)', textIn('price', v.price ?? '', 'inputmode="numeric"'), { cls: 'ff-narrow' })}
        ${field('url', '商品ページの URL', `<input id="ff-url" name="url" type="url" value="${esc(v.url)}" ${desc('url')} autocomplete="off" placeholder="https://">`)}
        ${field('memo', 'メモ', `<textarea id="ff-memo" name="memo" rows="3" ${desc('memo')}>${esc(v.memo)}</textarea>`)}
      </div>
    </div>
    <p class="ff-paste-hint">${icon('image', 16)}<span>このフォームを開いている間は、コピーした画像を ⌘V で貼り付けると写真になります</span></p>
    <footer class="ff-foot">
      ${f ? `<button type="button" id="ff-delete" class="pill pill-danger-outline" data-ff="delete">${icon('trash', 18)}<span>台帳から削除</span></button>` : ''}
      <span class="spacer"></span>
      <button type="button" id="ff-cancel" class="pill pill-outline" data-ff="cancel">やめる</button>
      <button type="submit" id="ff-save" class="pill pill-accent">${icon('check', 18)}<span>保存</span></button>
    </footer>
  </form>`;
  d.querySelector('#ff-photo-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) importPhoto(file);
  });
  renderPhoto();
  d.querySelector('[data-slot="model3d"]').innerHTML = `<div class="ff-model">
    <h3 class="ff-model-cap">${icon('cube', 18)}<span>立体モデル</span></h3>
    <div id="ff-model-body" class="ff-model-body"></div>
    <p id="ff-model-msg" class="ff-model-msg" role="status" aria-live="polite"></p>
  </div>`;
  d.showModal();
  if (f && hubConfigured()) refreshQuota();
  renderModelSlot();
  d.querySelector('#ff-name').focus();
}

// 家具のフォームの「立体モデル」の欄。作成中・失敗・残り回数・モデルの有無で描き直す
function renderModelSlot() {
  if (!dlg?.open || !st) return;
  const body = dlg.querySelector('#ff-model-body'), msg = dlg.querySelector('#ff-model-msg');
  if (!body) return;
  const f = st.id ? store.house.furniture.find((x) => x.id === st.id) : null;
  const job = f ? jobState(f.id) : null;
  const q = quotaState();
  const focused = body.contains(document.activeElement) ? document.activeElement.id : null;
  const live = job?.status === 'running' ? `${MSG_HUB.running} ${MSG_HUB.keepOpen}` : job?.status === 'error' ? job.message : '';
  // 押せない理由(上から優先)
  let why = '';
  if (!f?.photo) why = st.photo ? MSG_HUB.savePhoto : MSG_HUB.noPhoto;
  else if (job?.status === 'running') why = '';
  else if (runningJob()) why = MSG_HUB.otherRunning;
  else if (q.blocked) why = q.blocked;
  const blocked = !!why || job?.status === 'running';
  const whyHtml = why && why !== live ? `<p id="ff-model-why" class="ff-model-why">${icon('warn', 16)}<span>${esc(why)}</span></p>` : '';
  const describedBy = whyHtml ? ' aria-describedby="ff-model-why"' : '';
  const quotaText = q.status === 'ok' ? remainingText(q.remaining)
    : q.status === 'error' ? `${MSG_HUB.quotaUnknown}(${q.message})` : MSG_HUB.checking;

  let html;
  if (job?.status === 'running') {
    html = `<p class="ff-model-run">${icon('refresh', 18)}<span>${MSG_HUB.running}<br><small>${MSG_HUB.keepOpen}</small></span></p>`;
  } else if (!hubConfigured()) {
    html = `<p class="ff-model-why">${esc(MSG_HUB.notConfigured)}</p>
      <button type="button" id="ff-model-settings" class="pill pill-ghost-inline" data-ff="model-settings">${icon('settings', 16)}<span>設定を開く</span></button>`;
  } else if (f?.model && isUnreadableModel(f.model.hash)) {
    // 3D で読めなかった GLB: 簡易な形で表示している。作り直すか、簡易な形に戻すかを選んでもらう
    html = `<p class="ff-model-state ff-model-bad">${icon('warn', 16)}<span>立体モデルを読めませんでした(簡易な形で表示中)</span></p>
      <div class="ff-model-btns">
        <button type="button" id="ff-model-remake" class="pill pill-ghost-inline" data-ff="model-make"${blocked ? ' disabled' : ''}${describedBy}>${icon('cube', 16)}<span>作り直す</span></button>
        <button type="button" id="ff-model-reset" class="pill pill-ghost-inline" data-ff="model-reset">${icon('square', 16)}<span>簡易な形に戻す</span></button>
      </div>
      <p class="ff-model-quota" id="ff-model-quota">${esc(quotaText)}</p>${whyHtml}`;
  } else if (f?.model) {
    html = `<p class="ff-model-state">${icon('check', 16)}<span>立体モデルあり(向き ${Number(f.model.yawDeg) || 0}度)</span></p>
      <div class="ff-model-btns">
        <button type="button" id="ff-model-rotate" class="pill pill-ghost-inline" data-ff="model-rotate">${icon('rotate', 16)}<span>向きを90度回す</span></button>
        <button type="button" id="ff-model-reset" class="pill pill-ghost-inline" data-ff="model-reset">${icon('square', 16)}<span>簡易な形に戻す</span></button>
        <button type="button" id="ff-model-remake" class="pill pill-ghost-inline" data-ff="model-make"${blocked ? ' disabled' : ''}${describedBy}>${icon('cube', 16)}<span>作り直す</span></button>
      </div>
      <p class="ff-model-quota" id="ff-model-quota">${esc(quotaText)}</p>${whyHtml}`;
  } else {
    html = `<div class="ff-model-row">
        <button type="button" id="ff-model-make" class="pill pill-accent" data-ff="model-make"${blocked ? ' disabled' : ''}${describedBy}>${icon('cube', 16)}<span>立体モデルにする</span></button>
        <span class="ff-model-quota" id="ff-model-quota">${esc(quotaText)}</span>
      </div>${whyHtml}`;
  }
  body.innerHTML = html;
  if (msg.textContent !== live) {
    msg.textContent = live;
    msg.dataset.kind = job?.status === 'error' ? 'error' : 'info';
  }
  if (focused) (body.querySelector(`#${focused}`) ?? body.querySelector('button:not([disabled])'))?.focus();
}

async function onModelAction(act) {
  const id = st?.id;
  const f = id ? store.house.furniture.find((x) => x.id === id) : null;
  if (act === 'model-settings') {
    dlg.close('cancel');
    openSettings('', { focus: 'hub' });
    return;
  }
  if (!f) return;
  if (act === 'model-rotate' && f.model) {
    store.commit(updateFurniture(store.house, id, { model: { ...f.model, yawDeg: ((Number(f.model.yawDeg) || 0) + 90) % 360 } }));
  } else if (act === 'model-reset') {
    store.commit(updateFurniture(store.house, id, { model: null }));
  } else if (act === 'model-make') {
    if (!getSetting('hubConsent')) {
      const ok = await confirmDialog({
        title: '写真を外部のサービスに送ります',
        message: '立体モデルを作るため、この家具の写真を、設定した中継役(imagegen-hub)を通して外部のサービス(Hugging Face)に送ります。よろしいですか(この確認は最初の1回だけです)',
        ok: '送って作る',
      });
      if (!ok) { dlg.querySelector('#ff-model-make, #ff-model-remake')?.focus(); return; }
      try { await saveSetting('hubConsent', true); } catch { /* 了承の保存に失敗しても、今回は作る */ }
    }
    startModelJob(id);
  }
}

function renderPhoto() {
  const url = st.pending ? st.preview : photoUrl(st.photo);
  const area = dlg.querySelector('#ff-photo');
  area.innerHTML = st.photo && url
    ? `<img src="${esc(url)}" alt="写真のプレビュー">`
    : `<span class="ff-photo-empty">${icon('image', 28)}<span>${st.photo ? '写真を読み込んでいます' : '写真をここにドラッグ<br>または ⌘V で貼り付け'}</span></span>`;
  dlg.querySelector('#ff-photo-remove').hidden = !st.photo;
  renderModelSlot();
}
onPhotoReady(() => { if (dlg?.open && st?.photo && !st.pending) renderPhoto(); });

function importPhoto(file) {
  const session = st;
  const msg = dlg.querySelector('#ff-photo-msg');
  msg.textContent = '写真を読み込んでいます…';
  msg.classList.add('pending');
  const job = (async () => {
    let r;
    try { r = await importImage(file, PHOTO_MAX); } catch { r = { ok: false }; }
    if (session !== st) return;
    msg.classList.remove('pending');
    if (!r.ok) { msg.textContent = MSG.unsupported; return; }
    msg.textContent = '';
    if (st.preview) URL.revokeObjectURL(st.preview);
    st.pending = { hash: r.hash, type: r.type, bytes: r.bytes };
    st.preview = URL.createObjectURL(new Blob([r.bytes], { type: r.type }));
    st.photo = r.hash;
    renderPhoto();
    if (!st.colorTouched) {
      try {
        const c = await dominantColor(r.bytes, r.type);
        if (session === st && !st.colorTouched) dlg.querySelector('#ff-color').value = c;
      } catch { /* 色は今のまま */ }
    }
  })();
  st.importing = job;
  job.finally(() => { if (session === st && st.importing === job) st.importing = null; });
}

function onPaste(e) {
  if (!dlg?.open || !st || e.defaultPrevented) return;
  if (document.getElementById('confirm-dialog')?.open) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;   // 文字の貼り付けはそのまま
  e.preventDefault();
  importPhoto(files.find((f) => f.type.startsWith('image/')) ?? files[0]);
}

const values = () => {
  const out = {};
  for (const k of ['name', 'kind', 'width', 'depth', 'height', 'status', 'price', 'url', 'memo', 'color']) out[k] = dlg.querySelector(`#ff-${k}`).value;
  return out;
};

function showError(key, message) {
  const input = dlg.querySelector(`#ff-${key}`);
  dlg.querySelector(`#ff-${key}-err`).textContent = message ?? '';
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

// 1つの欄だけ確かめ直す(全体を確かめ、その欄の誤りだけ出す)
function recheck(key) {
  if (!FIELDS.includes(key)) return;
  showError(key, validateFurniture(values()).errors[key]);
}

function onFormInput(e) {
  const key = e.target.id?.replace(/^ff-/, '');
  if (key === 'color') st.colorTouched = true;
  // 誤りが出ている欄は、直ったらすぐ消す
  if (e.target.getAttribute('aria-invalid') === 'true') recheck(key);
}

function onFormChange(e) {
  if (e.target.id === 'ff-color') st.colorTouched = true;
}

// 欄を離れたら確かめる(空の欄は、保存を押すまで責めない)
function onFormBlur(e) {
  const key = e.target.id?.replace(/^ff-/, '');
  if (!FIELDS.includes(key) || !st) return;
  if (st.submitted || e.target.value.trim() !== '') recheck(key);
}

async function onSubmit(e) {
  e.preventDefault();
  if (!st) return;
  const session = st;
  st.submitted = true;
  if (st.importing) await st.importing;
  if (session !== st) return;
  const r = validateFurniture(values());
  for (const k of FIELDS) showError(k, r.errors[k]);
  if (!r.ok) {
    dlg.querySelector(`#ff-${FIELDS.find((k) => r.errors[k])}`).focus();
    return;
  }
  const data = { ...r.data, photo: st.photo };
  if (st.pending && st.pending.hash === st.photo) {
    try {
      await putBlob(st.pending);
    } catch {
      dlg.querySelector('#ff-photo-msg').textContent = '写真を保存できませんでした。もう一度お試しください';
      return;
    }
    if (session !== st) return;
    if (!urls[st.photo]) { urls[st.photo] = st.preview; st.preview = null; }   // 一覧でそのまま使う
  }
  if (st.id) store.commit(updateFurniture(store.house, st.id, data));
  else store.commit(addFurniture(store.house, data).house);
  dlg.close('saved');
}

async function onFormClick(e) {
  const btn = e.target.closest('button[data-ff]');
  if (!btn) return;
  const act = btn.dataset.ff;
  if (act.startsWith('model-')) { onModelAction(act); return; }
  if (act === 'cancel') dlg.close('cancel');
  else if (act === 'pick') dlg.querySelector('#ff-photo-file').click();
  else if (act === 'remove-photo') {
    if (st.preview) URL.revokeObjectURL(st.preview);
    st.photo = null; st.pending = null; st.preview = null;
    dlg.querySelector('#ff-photo-msg').textContent = '';
    renderPhoto();
    dlg.querySelector('#ff-photo-pick').focus();
  } else if (act === 'delete') {
    const id = st.id;
    const back = st.returnFocus;
    if (await deleteFurniture(id)) {
      st.returnFocus = back?.isConnected ? back : document.getElementById('cat-add-btn');
      dlg.close('deleted');
    }
  }
}

function onClose() {
  if (!st) return;
  if (st.preview) URL.revokeObjectURL(st.preview);
  const back = st.returnFocus;
  st = null;
  // 開く前のボタンへ戻す。描き直しで消えていれば、同じ家具の同じボタンを探す
  if (back?.isConnected) back.focus();
  else if (back?.dataset?.furnitureId) document.querySelector(`[data-action="${back.dataset.action}"][data-furniture-id="${CSS.escape(back.dataset.furnitureId)}"]`)?.focus();
}
