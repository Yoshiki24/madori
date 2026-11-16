// スマホの閲覧画面(見るだけ)。保管場所から閲覧用の合言葉で家を受け取り、端末(IndexedDB)に保存して表示する
//   下部のタブ: 部屋(3D・平面図・家具)/ 家全体(階の平面図・階全体の3D)/ 家具(台帳)
//   家具をタップすると、下からの詳細(写真・寸法・状態・価格・置き場所・メモ・商品ページ)
//   家のデータを書き換えない(受け取った家を保存するだけ)。編集の部品(store・ui-*)は読み込まない
import { createSync, syncErrorMessage } from './sync.js';
import * as db from './db.js';
import { findRoom, planTotal, furnitureUsage } from './model.js';
import { renderFloorSvg, renderRoomSvg, floorBounds, roomBounds, areaText } from './plan2d.js';
import { polygonArea } from './geom.js';
import { createViewport } from './view.js';
import { createView3d, sceneSpec } from './view3d.js';
import { icon } from './icons.js';
import { formatMm } from './scale.js';
import { furnitureCardHtml, esc, safeColor } from './fcard.js';
import { STATUSES, statusLabel, kindLabel, formatPrice, checkUrl, usageLabels, filterFurniture } from './catalog-logic.js';

// ---- 文言 ----
export const MSG = {
  loading: '読み込んでいます…',
  offline: '電波がないため、前回の内容を表示しています',
  unauthorized: '合言葉が変わったようです。Mac の QRコードをもう一度読み取ってください',
  empty: 'まだ Mac から送られていません。Mac で「スマホに送る」を押してください',
  firstRun: '初回は通信が必要です',
  noLink: 'Mac の設定画面の QRコードを読み取ってください',
  noRooms: 'まだ部屋がありません。Mac で間取りを作り、「スマホに送る」を押してください',
};
const SYNC_INTERVAL = 60 * 1000;   // 戻ってきたときの確認は 1分に1回まで
const PARALLEL = 3;                // 画像の取得の並行数

const TABS = [['room', '部屋', 'room'], ['house', '家全体', 'house'], ['furniture', '家具', 'sofa']];
const FILTERS = [['', 'すべて'], ...STATUSES.map((s) => [s.id, s.label])];

// 「最終更新 11月15日 21:53」(その端末の時刻)
export function updatedText(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '最終更新 —';
  return `最終更新 ${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 「幅 2,000 × 奥行 850 × 高さ 750 mm」
export const sizeText = (f) => `幅 ${formatMm(f.width)} × 奥行 ${formatMm(f.depth)} × 高さ ${formatMm(f.height)} mm`;

// ---- 状態 ----
const S = {
  house: null,
  etag: null,
  tab: 'room',
  roomId: null,
  planId: null,
  houseFloorId: null,
  filter: '',
  q: '',
  sel: null,            // 選んでいる配置(平面図と3Dで強調)
  syncing: false,
  lastSync: 0,
  status: { kind: 'info', text: '' },
};
const urls = {};        // hash → blob: URL(端末に保存した画像)
const pendingUrls = new Set();
let root = null;
let roomVp = null, houseVp = null, view3d = null, host3d = null;
let v3Key = '';
let layer = null;       // 開いているシート { el, opener, onClose }
const layers = [];      // 重なっているシート(上が最後)
let renderTimer = null;
let saveTimer = null;
let ready = false;
let editorDevice = false;   // 編集用の合言葉がある端末(家・画像の保存を書き換えない)

const $ = (sel) => root.querySelector(sel);

// ---- 家の中を探す ----
const floors = () => S.house?.floors ?? [];
const allRooms = () => floors().flatMap((f) => f.rooms.map((r) => ({ floor: f, room: r })));
const currentRoom = () => (S.roomId && S.house ? findRoom(S.house, S.roomId) : null);
const currentPlan = (room) => room?.plans.find((p) => p.id === S.planId) ?? room?.plans.find((p) => p.isCurrent) ?? room?.plans[0] ?? null;
const furnitureOf = (id) => S.house?.furniture.find((f) => f.id === id) ?? null;
const placementOf = (plan, id) => plan?.placements.find((p) => p.id === id) ?? null;

// 選んでいる部屋・案・階が家にあるように直す(なければ最初の部屋)
function fixSelection() {
  const rooms = allRooms();
  if (!rooms.some((x) => x.room.id === S.roomId)) S.roomId = rooms[0]?.room.id ?? null;
  const room = currentRoom()?.room;
  if (!room?.plans.some((p) => p.id === S.planId)) S.planId = room ? currentPlan({ plans: room.plans }).id : null;
  if (!floors().some((f) => f.id === S.houseFloorId)) S.houseFloorId = currentRoom()?.floor.id ?? floors()[0]?.id ?? null;
  const plan = currentPlan(room);
  if (S.sel && !placementOf(plan, S.sel)) S.sel = null;
}

// ---- 画像 ----
function photoUrl(hash) {
  if (!hash) return null;
  if (urls[hash]) return urls[hash];
  if (!pendingUrls.has(hash)) {
    pendingUrls.add(hash);
    db.blobUrl(hash)
      .then((u) => { if (u) { urls[hash] = u; scheduleRender(); } })
      .catch(() => {})
      .finally(() => pendingUrls.delete(hash));
  }
  return null;
}

// 閲覧画面で表示する画像: 家具の写真と立体モデルだけ(図面の画像・部屋の写真は表示しないので受け取らない)
export function viewerHashes(house) {
  const set = new Set();
  for (const f of house?.furniture ?? []) {
    if (f.photo) set.add(f.photo);
    if (f.model?.hash) set.add(f.model.hash);
  }
  return [...set];
}

// 今の画面で使う画像(先に取る)
function screenHashes() {
  if (!S.house) return [];
  if (S.tab === 'room') {
    const plan = currentPlan(currentRoom()?.room);
    return (plan?.placements ?? []).flatMap((pl) => [furnitureOf(pl.furnitureId)?.photo, furnitureOf(pl.furnitureId)?.model?.hash]).filter(Boolean);
  }
  if (S.tab === 'furniture') return S.house.furniture.map((f) => f.photo).filter(Boolean);
  const floor = floors().find((f) => f.id === S.houseFloorId);
  const ids = new Set((floor?.rooms ?? []).flatMap((r) => (currentPlan(r)?.placements ?? []).map((pl) => pl.furnitureId)));
  return S.house.furniture.filter((f) => ids.has(f.id) && f.photo).map((f) => f.photo);
}

async function runParallel(items, n, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// 受け取った家の画像(表示するものだけ)を端末に保存する。今の画面の分を先に、残りは後で(3件ずつ)。ハッシュは fetchBlob が確かめる
// 端末にあるものは取らない。表示に使わなくなった画像(以前に受け取った図面なども)は消す
async function fetchBlobs(sync) {
  const house = S.house;
  if (!house) return;
  try {
    const need = viewerHashes(house);
    const have = new Set(await db.listBlobHashes());
    const first = new Set(screenHashes());
    const todo = need.filter((h) => !have.has(h)).sort((a, b) => Number(first.has(b)) - Number(first.has(a)));
    await runParallel(todo, PARALLEL, async (hash) => {
      try {
        const b = await sync.fetchBlob(hash);
        await db.putBlob({ hash, type: b.type, bytes: b.bytes });
        photoUrl(hash);
      } catch { /* 1枚の失敗で画面を壊さない。次の確認で取り直す */ }
    });
    if (S.house !== house) return;
    const keep = new Set(need);
    const drop = [...have].filter((h) => !keep.has(h));
    if (drop.length && !editorDevice) await db.deleteBlobs(drop);
  } catch (e) {
    console.warn('画像を受け取れませんでした', e?.name ?? 'Error');
  }
}

// ---- 保管場所との確認 ----
function setStatus(kind, text) {
  S.status = { kind, text };
  const el = $('#vw-status');
  if (!el) return;
  const ic = kind === 'error' ? icon('offline', 16) : kind === 'loading' ? icon('refresh', 16) : '';
  el.dataset.kind = kind;
  el.innerHTML = `${ic}<span>${esc(text)}</span>`;
  renderNoData();
}

async function sync() {
  if (S.syncing) return;
  const [baseUrl, token] = await Promise.all([db.getSetting('syncUrl'), db.getSetting('viewToken')]);
  if (!baseUrl || !token) { setStatus('error', MSG.noLink); return; }
  S.syncing = true;
  S.lastSync = Date.now();
  const btn = $('#vw-refresh');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  setStatus('loading', MSG.loading);
  try {
    const s = createSync({ baseUrl, token });
    const r = await s.pull(S.house ? S.etag : null);
    if (r.changed) {
      S.house = r.house;
      S.etag = r.etag ?? null;
      // 端末の保存(前回の内容として使う)。編集用の合言葉がある端末(Mac で QR のリンクを開いた)では、
      // 編集中の家と送信の印を上書きしないよう保存しない
      if (!editorDevice) {
        await db.saveHouse(r.house);
        await db.setSetting('etag', S.etag);
      }
      fixSelection();
      renderAll();
    }
    setStatus('ok', updatedText(S.house?.updatedAt));
    fetchBlobs(s);
  } catch (e) {
    const code = e?.code;
    if (code === 'unauthorized' || code === 'forbidden') setStatus('error', MSG.unauthorized);
    else if (code === 'empty') setStatus('error', MSG.empty);
    else if (code === 'unsupported' || code === 'corrupt') setStatus('error', syncErrorMessage(code));
    // 「電波がない」は本当に通信できなかったときだけ。保管場所の障害(503 など)は「一時的に使えません」
    else if (code === 'network') setStatus('error', S.house ? MSG.offline : MSG.firstRun);
    else setStatus('error', syncErrorMessage('server'));
  } finally {
    S.syncing = false;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

// ---- 前回の画面を覚える ----
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    db.setSetting('viewerState', { tab: S.tab, roomId: S.roomId, planId: S.planId, houseFloorId: S.houseFloorId, filter: S.filter }).catch(() => {});
  }, 200);
}

// ---- 枠 ----
const FRAME = `
<div class="vw" id="vw">
  <header class="vw-head">
    <div class="vw-bar">
      <div class="vw-title" id="vw-title"></div>
      <button type="button" id="vw-refresh" class="pill pill-ghost-inline vw-refresh" aria-label="更新(保管場所を確認する)">${icon('refresh', 18)}<span>更新</span></button>
    </div>
    <p id="vw-status" class="vw-status" role="status" aria-live="polite"></p>
  </header>
  <main class="vw-main" id="vw-main">
    <div id="vw-nodata" class="vw-nodata" hidden></div>
    <section id="vw-tab-room" class="vw-page" aria-label="部屋">
      <div id="vw-plans" class="vw-chips" role="group" aria-label="配置案" hidden></div>
      <div class="vw-card vw-3d-card"><div id="vw-3d" class="vw-3d-slot"></div></div>
      <div class="vw-card vw-plan-card"><div id="vw-room-plan" class="vw-plan"></div></div>
      <div class="vw-sec-head">
        <h2 class="vw-h2">家具</h2>
        <p id="vw-room-total" class="vw-total"></p>
      </div>
      <ul id="vw-room-list" class="vw-list" aria-label="この部屋の家具"></ul>
    </section>
    <section id="vw-tab-house" class="vw-page" aria-label="家全体" hidden>
      <div id="vw-floors" class="vw-chips" role="group" aria-label="階の切り替え"></div>
      <p id="vw-house-sum" class="vw-sum"></p>
      <div class="vw-card vw-plan-card"><div id="vw-house-plan" class="vw-plan"></div></div>
      <p class="vw-hint">部屋をタップすると、その部屋を開きます</p>
      <div class="vw-card vw-3d-card"><div id="vw-house-3d" class="vw-3d-slot"></div></div>
    </section>
    <section id="vw-tab-furniture" class="vw-page" aria-label="家具" hidden>
      <div class="vw-search">
        <label for="vw-furn-q" class="vw-search-label">${icon('search', 18)}<span class="sr-only">名前で探す</span></label>
        <input id="vw-furn-q" type="search" placeholder="名前で探す" autocomplete="off" enterkeyhint="search">
      </div>
      <div id="vw-furn-filters" class="vw-chips" role="group" aria-label="状態で絞り込む"></div>
      <p id="vw-furn-count" class="vw-sum" aria-live="polite"></p>
      <ul id="vw-furn-list" class="vw-list" aria-label="家具の一覧"></ul>
    </section>
  </main>
  <nav id="vw-tabs" class="vw-tabs" aria-label="画面の切り替え">
    ${TABS.map(([id, label, ic]) => `<button type="button" class="vw-tab" data-tab="${id}">${icon(ic, 24)}<span>${label}</span></button>`).join('')}
  </nav>
  <div id="vw-backdrop" class="vw-backdrop" hidden></div>
  <section id="vw-picker" class="vw-sheet" role="dialog" aria-modal="true" aria-labelledby="vw-picker-title" hidden></section>
  <section id="vw-sheet" class="vw-sheet" role="dialog" aria-modal="true" aria-labelledby="vw-sheet-title" hidden></section>
  <div id="vw-photo" class="vw-photo-view" role="dialog" aria-modal="true" aria-label="写真" hidden></div>
</div>`;

// ---- 描画 ----
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderTimer = null; renderAll({ keepViews: true }); }, 80);
}

function renderAll({ keepViews = false } = {}) {
  if (!root) return;
  renderTabs();
  renderTitle();
  renderNoData();
  if (S.tab === 'room') renderRoom(keepViews);
  else if (S.tab === 'house') renderHouse(keepViews);
  else renderFurniture();
  if (layer?.el.id === 'vw-sheet' && layer.furnitureId) fillDetail(layer.furnitureId);
}

function renderTabs() {
  for (const b of root.querySelectorAll('#vw-tabs .vw-tab')) {
    const on = b.dataset.tab === S.tab;
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  for (const [id] of TABS) $(`#vw-tab-${id}`).hidden = id !== S.tab || (id !== 'furniture' && noRooms());
}

const noRooms = () => !allRooms().length;

function renderTitle() {
  const el = $('#vw-title');
  if (S.tab === 'room' && !noRooms()) {
    const found = currentRoom();
    const label = found ? `${found.floor.name} ・ ${found.room.name}` : '部屋';
    el.innerHTML = `<button type="button" id="vw-room-btn" class="vw-room-btn" aria-haspopup="dialog" aria-label="部屋を選ぶ(今は ${esc(label)})"><span class="vw-room-name">${esc(label)}</span>${icon('chevronDown', 20)}</button>`;
  } else {
    el.innerHTML = `<h1 class="vw-h1">${S.tab === 'room' ? '部屋' : S.tab === 'house' ? '家全体' : '家具'}</h1>`;
  }
}

// 家がない・部屋がないときの案内
function renderNoData() {
  const el = $('#vw-nodata');
  if (!el) return;
  const show = S.tab !== 'furniture' ? noRooms() : !S.house;
  el.hidden = !show;
  if (!show) return;
  const text = S.house ? MSG.noRooms : (S.status.text || MSG.loading);
  el.innerHTML = `<img src="icon.svg" alt="" width="72" height="72"><p>${esc(text)}</p>`;
}

// ---- 部屋 ----
function renderRoom(keepViews) {
  const found = currentRoom();
  if (!found) return;
  const { room } = found;
  const plan = currentPlan(room);
  // 配置案(2つ以上のとき)
  const chips = $('#vw-plans');
  chips.hidden = room.plans.length < 2;
  chips.innerHTML = room.plans.map((p) => {
    const on = p.id === plan.id;
    const mark = p.isCurrent && p.name !== '現状' ? '<span class="vw-chip-mark">現状</span>' : '';
    return `<button type="button" class="vw-chip" data-plan-id="${esc(p.id)}" aria-pressed="${on}">${on ? icon('check', 16) : ''}<span>${esc(p.name)}</span>${mark}</button>`;
  }).join('');
  // 家具の一覧と、検討中の合計
  const items = plan.placements.map((pl) => ({ pl, f: furnitureOf(pl.furnitureId) })).filter((x) => x.f);
  const total = planTotal(S.house, plan);
  $('#vw-room-total').textContent = `${items.length}点${total ? ` ・ 検討中の合計 ${formatPrice(total)}` : ''}`;
  $('#vw-room-list').innerHTML = items.length
    ? items.map(({ pl, f }) => `<li><button type="button" class="vw-item" data-placement-id="${esc(pl.id)}" data-furniture-id="${esc(f.id)}" aria-pressed="${pl.id === S.sel}">${furnitureCardHtml(f, photoUrl(f.photo), { compact: true })}</button></li>`).join('')
    : '<li class="vw-empty">この案には家具がありません</li>';
  place3d('room');
  if (!roomVp) {
    roomVp = createViewport($('#vw-room-plan'), {
      getBounds: () => (currentRoom() ? roomBounds(S.house, S.roomId) : null),
      render: ({ viewBox, size }) => (currentRoom() ? renderRoomSvg(S.house, S.roomId, currentPlan(currentRoom().room).id, { selectedId: S.sel, size, viewBox, showDims: true }) : ''),
      onTap: onRoomPlanTap,
      label: '平面図',
      margin: 16,
      touchScroll: true,
    });
  }
  if (keepViews) roomVp.refresh(); else roomVp.fit();
  show3d();
}

function onRoomPlanTap(e, p) {
  if (view3d?.picking) { view3d.setCamera('eye', p); return; }
  const g = e.target?.closest?.('[data-placement-id]');
  if (g) openDetail(g.dataset.furnitureId, g.dataset.placementId, g);
  else select(null);
}

function select(placementId) {
  if (S.sel === placementId) return;
  S.sel = placementId;
  roomVp?.refresh();
  view3d?.select(placementId);
  for (const b of root.querySelectorAll('#vw-room-list .vw-item')) b.setAttribute('aria-pressed', String(b.dataset.placementId === placementId));
}

// ---- 3D(1つを部屋と家全体で使い回す) ----
function ensure3d() {
  if (view3d) return;
  host3d = document.createElement('div');
  host3d.id = 'vw-3d-host';
  host3d.className = 'vw-3d-host';
  view3d = createView3d(host3d);
  view3d.onSelect((pid) => {
    if (S.tab !== 'room') return;
    if (!pid) { select(null); return; }
    const pl = placementOf(currentPlan(currentRoom()?.room), pid);
    if (pl) openDetail(pl.furnitureId, pid, host3d.querySelector('canvas'));
  });
  view3d.onRoomPick((roomId) => {
    if (S.tab === 'house' && roomId) goRoom(roomId, { push: true });
  });
  // 画面の外・隠れたタブでは描かない
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) visible3d = en.isIntersecting;
    view3d.setActive(visible3d && document.visibilityState === 'visible');
  });
  io.observe(host3d);
}
let visible3d = true;

function place3d(tab) {
  ensure3d();
  const slot = $(tab === 'room' ? '#vw-3d' : '#vw-house-3d');
  if (host3d.parentElement !== slot) slot.append(host3d);
}

function show3d() {
  if (!view3d || !S.house) return;
  const n = Object.keys(urls).length;
  let key, spec, label;
  if (S.tab === 'room') {
    const found = currentRoom();
    if (!found) return;
    const plan = currentPlan(found.room);
    key = `room|${found.room.id}|${plan.id}`;
    spec = () => sceneSpec(S.house, { roomId: found.room.id, planId: plan.id });
    label = found.room.name;
  } else {
    const floor = floors().find((f) => f.id === S.houseFloorId);
    if (!floor) return;
    key = `floor|${floor.id}`;
    spec = () => sceneSpec(S.house, { floorId: floor.id });
    label = `${floor.name}全体`;
  }
  // 立体モデル(GLB)は端末に届いてから読む。届いたら(URL の数が変わって)場面を作り直す
  const s = spec();
  for (const it of s.items) if (it.modelHash) photoUrl(it.modelHash);
  const full = `${key}|${S.house.updatedAt}|${S.etag}|${n}`;
  if (full !== v3Key) {
    v3Key = full;
    view3d.show(s, { blobUrls: urls, label });   // 床の形が変わると、view3d が俯瞰に合わせ直す
  }
  view3d.select(S.tab === 'room' ? S.sel : null);
}

// ---- 家全体 ----
function renderHouse(keepViews) {
  const fl = floors();
  $('#vw-floors').innerHTML = fl.map((f) => `<button type="button" class="vw-chip" data-floor-id="${esc(f.id)}" aria-pressed="${f.id === S.houseFloorId}">${f.id === S.houseFloorId ? icon('check', 16) : ''}<span>${esc(f.name)}</span></button>`).join('');
  $('#vw-floors').hidden = fl.length < 2;
  const floor = fl.find((f) => f.id === S.houseFloorId);
  const area = (floor?.rooms ?? []).reduce((s, r) => s + polygonArea(r.polygon), 0);
  $('#vw-house-sum').textContent = floor ? `${floor.name} ・ 部屋 ${floor.rooms.length} ・ 合計 ${areaText(area)}` : '';
  place3d('house');
  if (!houseVp) {
    houseVp = createViewport($('#vw-house-plan'), {
      getBounds: () => (S.houseFloorId ? floorBounds(S.house, S.houseFloorId, { showImage: false }) : null),
      render: ({ viewBox, size }) => (S.houseFloorId ? renderFloorSvg(S.house, S.houseFloorId, { size, viewBox, showImage: false, areas: true, focusable: true }) : ''),
      onTap: (e) => {
        const g = e.target?.closest?.('[data-room-id]');
        if (g) goRoom(g.dataset.roomId, { push: true });
      },
      label: '家全体の平面図',
      margin: 16,
      touchScroll: true,
    });
    $('#vw-house-plan').addEventListener('keydown', (e) => {
      const g = e.target.closest?.('[data-room-id]');
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goRoom(g.dataset.roomId, { push: true }); }
    });
  }
  if (keepViews) houseVp.refresh(); else houseVp.fit();
  show3d();
}

// ---- 家具 ----
function renderFurniture() {
  if (!S.house) return;
  $('#vw-furn-filters').innerHTML = FILTERS.map(([id, label]) => `<button type="button" class="vw-chip" data-filter="${id}" aria-pressed="${id === S.filter}">${id === S.filter ? icon('check', 16) : ''}<span>${label}</span></button>`).join('');
  const list = filterFurniture(S.house, { status: S.filter, q: S.q });
  const total = S.house.furniture.length;
  $('#vw-furn-count').textContent = list.length === total ? `${total}件` : `${total}件中 ${list.length}件`;
  $('#vw-furn-list').innerHTML = list.length
    ? list.map((f) => `<li><button type="button" class="vw-item" data-furniture-id="${esc(f.id)}">${furnitureCardHtml(f, photoUrl(f.photo), { usage: furnitureUsage(S.house, f.id) })}</button></li>`).join('')
    : `<li class="vw-empty">${total ? '当てはまる家具がありません' : 'まだ家具がありません'}</li>`;
}

// ---- 画面の移動 ----
function setTab(tab, { scroll = true } = {}) {
  if (S.tab === tab) return;
  S.tab = tab;
  if (tab !== 'room') select(null);
  if (tab === 'house' && currentRoom()) S.houseFloorId = currentRoom().floor.id;
  renderAll();
  if (scroll) window.scrollTo(0, 0);
  history.replaceState({ vw: 'nav', tab: S.tab, roomId: S.roomId }, '');
  saveState();
}

function goRoom(roomId, { push = false } = {}) {
  if (push) history.replaceState({ vw: 'nav', tab: S.tab, roomId: S.roomId, houseFloorId: S.houseFloorId }, '');
  S.roomId = roomId;
  S.planId = null;
  S.sel = null;
  fixSelection();
  S.tab = 'room';
  renderAll();
  window.scrollTo(0, 0);
  if (push) history.pushState({ vw: 'nav', tab: 'room', roomId }, '');
  saveState();
}

// ---- シート(下から出る窓) ----
const FOCUSABLE = 'button:not([disabled]), a[href], input, [tabindex]:not([tabindex="-1"])';

function openLayer(el, { opener, furnitureId = null, focus } = {}) {
  const prev = layers.at(-1);
  const entry = { el, opener: opener ?? document.activeElement, furnitureId, at: performance.now() };
  layers.push(entry);
  layer = entry;
  el.hidden = false;
  if (el.classList.contains('vw-sheet')) {
    const bd = $('#vw-backdrop');
    bd.hidden = false;
    bd.style.zIndex = String(40 + layers.length * 2);
    el.style.zIndex = String(41 + layers.length * 2);
    requestAnimationFrame(() => { el.classList.add('open'); bd.classList.add('open'); });
  }
  if (!prev) root.querySelector('.vw-main').setAttribute('inert', '');
  for (const sel of ['.vw-head', '.vw-tabs']) root.querySelector(sel).setAttribute('inert', '');
  if (prev) prev.el.setAttribute('inert', '');
  history.pushState({ vw: 'layer' }, '');
  (focus ?? el.querySelector(FOCUSABLE))?.focus({ preventScroll: true });
}

// 上のシートを閉じる。fromHistory: 戻る操作で呼ばれた(履歴はもう戻っている)
function closeLayer({ fromHistory = false } = {}) {
  const top = layers.at(-1);
  if (!top) return;
  if (!fromHistory && history.state?.vw === 'layer') { history.back(); return; }   // popstate でここに戻る
  layers.pop();
  layer = layers.at(-1) ?? null;
  const el = top.el;
  if (el.classList.contains('vw-sheet')) {
    el.classList.remove('open');
    el.style.transform = '';
    const bd = $('#vw-backdrop');
    const anySheet = layers.some((l) => l.el.classList.contains('vw-sheet'));
    if (!anySheet) bd.classList.remove('open');
    setTimeout(() => {
      if (!layers.includes(top)) el.hidden = true;
      if (!layers.some((l) => l.el.classList.contains('vw-sheet'))) bd.hidden = true;
    }, 220);
  } else {
    el.hidden = true;
  }
  if (layer) {
    layer.el.removeAttribute('inert');
  } else {
    for (const sel of ['.vw-main', '.vw-head', '.vw-tabs']) root.querySelector(sel).removeAttribute('inert');
    if (top.el.id === 'vw-sheet') select(null);
  }
  const back = top.opener;
  if (back && back.isConnected) back.focus?.({ preventScroll: true });
  else if (top.furnitureId) $(`#vw-tab-${S.tab}`).querySelector(`[data-furniture-id="${CSS.escape(top.furnitureId)}"]`)?.focus?.({ preventScroll: true });
}

// 詳細
function openDetail(furnitureId, placementId, opener) {
  if (!furnitureOf(furnitureId)) return;
  if (placementId) select(placementId);
  fillDetail(furnitureId);
  openLayer($('#vw-sheet'), { opener, furnitureId, focus: $('#vw-sheet [data-action="close-sheet"]') });
}

function fillDetail(furnitureId) {
  const f = furnitureOf(furnitureId);
  const el = $('#vw-sheet');
  if (!f) { el.innerHTML = ''; return; }
  const url = photoUrl(f.photo);
  const photo = url
    ? `<button type="button" class="vw-photo" data-action="photo" aria-label="${esc(f.name)}の写真を大きく表示"><img class="vw-photo-img" src="${esc(url)}" alt="${esc(f.name)}の写真"></button>`
    : `<div class="vw-photo vw-photo-none" style="background:${safeColor(f.color)}">${f.photo ? '<span>写真を読み込んでいます</span>' : ''}</div>`;
  const usage = usageLabels(furnitureUsage(S.house, f.id));
  const price = formatPrice(f.price);
  const link = checkUrl(f.url ?? '');
  const row = (dt, dd) => `<div class="vw-row"><dt>${dt}</dt><dd>${dd}</dd></div>`;
  el.innerHTML = `
    <div class="vw-sheet-grip" data-drag aria-hidden="true"><span></span></div>
    <header class="vw-sheet-head" data-drag>
      <h2 id="vw-sheet-title" class="vw-sheet-title">${esc(f.name)}</h2>
      <button type="button" class="icon-btn vw-close" data-action="close-sheet" aria-label="閉じる">${icon('close', 22)}</button>
    </header>
    <div class="vw-sheet-body">
      ${photo}
      <p class="vw-kind"><span>${esc(kindLabel(f.kind))}</span><span class="badge status-${esc(f.status)}">${esc(statusLabel(f.status))}</span></p>
      <dl class="vw-dl">
        ${row('大きさ', `<span class="vw-size">${sizeText(f)}</span>`)}
        ${price ? row('価格', `<span class="vw-price">${price}</span>`) : ''}
        ${row('置き場所', usage.length ? esc(usage.join('、')) : 'まだ置いていません')}
        ${f.memo ? row('メモ', `<span class="vw-memo">${esc(f.memo)}</span>`) : ''}
      </dl>
      ${link.ok && link.value ? `<a class="pill pill-accent vw-link" href="${esc(link.value)}" target="_blank" rel="noopener noreferrer">${icon('external', 18)}<span>商品ページを開く</span></a>` : ''}
    </div>`;
}

// 部屋を選ぶシート
function openPicker(opener) {
  const el = $('#vw-picker');
  el.innerHTML = `
    <div class="vw-sheet-grip" data-drag aria-hidden="true"><span></span></div>
    <header class="vw-sheet-head" data-drag>
      <h2 id="vw-picker-title" class="vw-sheet-title">部屋を選ぶ</h2>
      <button type="button" class="icon-btn vw-close" data-action="close-sheet" aria-label="閉じる">${icon('close', 22)}</button>
    </header>
    <div class="vw-sheet-body">
      ${floors().filter((f) => f.rooms.length).map((f) => `
        <section class="vw-pick-floor" aria-label="${esc(f.name)}">
          <h3 class="vw-pick-h">${esc(f.name)}</h3>
          <ul class="vw-pick-list">${f.rooms.map((r) => {
            const on = r.id === S.roomId;
            return `<li><button type="button" class="vw-pick" data-room-id="${esc(r.id)}"${on ? ' aria-current="true"' : ''}><span>${esc(r.name)}</span><span class="vw-pick-area">${areaText(polygonArea(r.polygon))}</span>${on ? icon('check', 20) : ''}</button></li>`;
          }).join('')}</ul>
        </section>`).join('')}
    </div>`;
  openLayer(el, { opener, focus: el.querySelector('.vw-pick[aria-current]') ?? undefined });
}

// 写真を大きく
function openPhoto(furnitureId, opener) {
  const f = furnitureOf(furnitureId);
  const url = f && photoUrl(f.photo);
  if (!url) return;
  const el = $('#vw-photo');
  el.innerHTML = `<img src="${esc(url)}" alt="${esc(f.name)}の写真"><button type="button" class="icon-btn vw-photo-close" data-action="close-sheet" aria-label="閉じる">${icon('close', 24)}</button>`;
  openLayer(el, { opener, focus: el.querySelector('button') });
}

// シートを下へなぞって閉じる(つまみと見出しから)
function swipeToClose(sheet) {
  let start = null;
  sheet.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-drag]') || e.target.closest('button')) return;
    start = { y: e.clientY, t: performance.now(), id: e.pointerId };
    sheet.setPointerCapture?.(e.pointerId);
    sheet.classList.add('dragging');
  });
  sheet.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = Math.max(0, e.clientY - start.y);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = e.clientY - start.y, dt = performance.now() - start.t;
    start = null;
    sheet.classList.remove('dragging');
    if (dy > 90 || (dy > 30 && dy / dt > 0.6)) closeLayer();
    else sheet.style.transform = '';
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
}

// ---- 操作 ----
function onClick(e) {
  const t = e.target;
  const tab = t.closest('.vw-tab');
  if (tab) { setTab(tab.dataset.tab); return; }
  if (t.closest('#vw-refresh')) { sync(); return; }
  if (t.closest('#vw-room-btn')) { openPicker(t.closest('#vw-room-btn')); return; }
  if (t.closest('[data-action="close-sheet"]')) { closeLayer(); return; }
  // 指で開いた直後に届く click(開いたタップの続き)では閉じない
  const fresh = layer && performance.now() - layer.at < 400;
  if (t.closest('#vw-backdrop')) { if (!fresh) closeLayer(); return; }
  const photo = t.closest('[data-action="photo"]');
  if (photo) { openPhoto(layer?.furnitureId, photo); return; }
  if (t.closest('#vw-photo')) { if (!fresh) closeLayer(); return; }
  const pick = t.closest('.vw-pick');
  if (pick) {
    const roomId = pick.dataset.roomId;
    closeLayer();
    // 履歴が戻ってから部屋を変える(戻る操作の行き先が変わらないように)
    setTimeout(() => { goRoom(roomId); }, 0);
    return;
  }
  const plan = t.closest('[data-plan-id]');
  if (plan) {
    S.planId = plan.dataset.planId;
    S.sel = null;
    renderAll({ keepViews: true });
    saveState();
    return;
  }
  const fl = t.closest('[data-floor-id]');
  if (fl) {
    S.houseFloorId = fl.dataset.floorId;
    renderAll();
    saveState();
    return;
  }
  const filter = t.closest('[data-filter]');
  if (filter) {
    S.filter = filter.dataset.filter;
    renderFurniture();
    saveState();
    return;
  }
  const item = t.closest('.vw-item');
  if (item) openDetail(item.dataset.furnitureId, item.dataset.placementId || null, item);
}

function onKey(e) {
  if (e.key === 'Escape' && layers.length) { e.preventDefault(); closeLayer(); return; }
  // シートの中でフォーカスを回す
  if (e.key === 'Tab' && layer) {
    const items = [...layer.el.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

function onPop(e) {
  if (layers.length) { closeLayer({ fromHistory: true }); return; }
  const st = e.state;
  if (st?.vw === 'nav') {
    S.tab = st.tab ?? S.tab;
    if (st.roomId) S.roomId = st.roomId;
    if (st.houseFloorId) S.houseFloorId = st.houseFloorId;
    S.sel = null;
    fixSelection();
    renderAll();
    saveState();
  }
}

function onVisibility() {
  const vis = document.visibilityState === 'visible';
  view3d?.setActive(vis && visible3d);
  if (vis && Date.now() - S.lastSync >= SYNC_INTERVAL) sync();
}

// ---- 入口 ----
export async function startViewer(el) {
  root = el;
  document.body.classList.add('viewer-body');
  root.innerHTML = FRAME;
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  addEventListener('popstate', onPop);
  document.addEventListener('visibilitychange', onVisibility);
  $('#vw-furn-q').addEventListener('input', (e) => { S.q = e.target.value; renderFurniture(); });
  // 開いたタップの続きの mousedown で、シートに移したフォーカスが外れないように
  $('#vw-backdrop').addEventListener('mousedown', (e) => e.preventDefault());
  swipeToClose($('#vw-sheet'));
  swipeToClose($('#vw-picker'));

  const [house, etag, saved, editToken] = await Promise.all([
    db.loadHouse().catch(() => null), db.getSetting('etag').catch(() => null), db.getSetting('viewerState').catch(() => null),
    db.getSetting('editToken').catch(() => null),
  ]);
  editorDevice = !!editToken;
  S.house = editorDevice ? null : house;
  S.etag = S.house ? etag ?? null : null;
  if (saved && typeof saved === 'object') {
    if (['room', 'house', 'furniture'].includes(saved.tab)) S.tab = saved.tab;
    S.roomId = saved.roomId ?? null;
    S.planId = saved.planId ?? null;
    S.houseFloorId = saved.houseFloorId ?? null;
    if (FILTERS.some(([id]) => id === saved.filter)) S.filter = saved.filter;
  }
  fixSelection();
  setStatus('loading', MSG.loading);
  renderAll();
  history.replaceState({ vw: 'nav', tab: S.tab, roomId: S.roomId }, '');
  ready = true;
  sync();
}

// テスト用
const api = {
  get ready() { return ready; },
  get house() { return S.house; },
  get view3d() { return view3d; },
  get state() { return { tab: S.tab, roomId: S.roomId, planId: S.planId, houseFloorId: S.houseFloorId, sel: S.sel, status: S.status }; },
};
window.__madori = { viewer: api };
