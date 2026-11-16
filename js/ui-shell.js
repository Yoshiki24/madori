// Mac の枠: 上部(表示の切り替え・取り消し・設定・スマホに送る)、左(階と部屋)、中央(平面図・3D)、右(家具の一覧)
import { store } from './store.js';
import { findRoom } from './model.js';
import { renderFloorSvg, floorBounds, areaText } from './plan2d.js';
import { polygonArea } from './geom.js';
import { createViewport } from './view.js';
import { mountFloorEditor, startFloorEdit, finishFloorEdit, addFloorAndEdit } from './ui-floor.js';
import { blobUrl } from './db.js';
import { mountCatalog, openFurnitureForm } from './ui-catalog.js';
import { mountRoomEditor, onRoomLive } from './ui-room.js';
import { createView3d, sceneSpec } from './view3d.js';
import { icon } from './icons.js';
import { mountSettings, mountNudge, renderNudge, sendToPhones } from './ui-settings.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const VIEWS = [['split', '並べて表示'], ['plan', '平面図'], ['3d', '3D']];

const FRAME = `
<div class="shell">
  <header class="topbar">
    <button type="button" id="toggle-left" class="icon-btn pane-toggle" aria-controls="left-pane" aria-expanded="false" aria-label="階と部屋の一覧">${icon('menu')}</button>
    <button type="button" class="logo" data-action="home" title="家全体を表示">MADORI</button>
    <div class="tabs" role="group" aria-label="表示の切り替え">
      ${VIEWS.map(([v, label]) => `<button type="button" class="tab" data-view="${v}" aria-pressed="false">${label}</button>`).join('')}
    </div>
    <div class="history-btns" role="group" aria-label="取り消しとやり直し">
      <button type="button" id="undo-btn" class="icon-btn" aria-label="取り消し" title="取り消し(⌘Z)">${icon('undo')}</button>
      <button type="button" id="redo-btn" class="icon-btn" aria-label="やり直し" title="やり直し(⇧⌘Z)">${icon('redo')}</button>
    </div>
    <span class="spacer"></span>
    <p id="app-status" class="app-status" role="status" aria-live="polite"></p>
    <button type="button" id="settings-btn" class="icon-btn" data-mode="settings" aria-pressed="false" aria-label="設定" title="設定">${icon('settings')}</button>
    <button type="button" id="send-btn" class="pill pill-outline" data-action="send" aria-label="スマホに送る">${icon('phone', 18)}<span>スマホに送る</span></button>
    <button type="button" id="toggle-right" class="icon-btn pane-toggle" aria-controls="side-pane" aria-expanded="false" aria-label="家具の一覧">${icon('list')}</button>
  </header>
  <div class="main">
    <nav id="left-pane" class="pane-left" aria-label="階と部屋">
      <div id="floor-list" class="floor-list"></div>
      <div class="left-actions">
        <button type="button" id="add-floor-btn" class="pill pill-ghost" data-action="add-floor">${icon('plus', 18)}<span>階を追加</span></button>
        <button type="button" id="edit-floor-btn" class="pill pill-ghost" data-mode="floor-edit" aria-pressed="false">${icon('edit', 18)}<span>間取りを編集</span></button>
        <button type="button" id="catalog-btn" class="pill pill-ghost" data-mode="catalog" aria-pressed="false">${icon('book', 18)}<span>家具台帳</span></button>
      </div>
    </nav>
    <div class="center">
    <div id="backup-nudge" class="backup-nudge" role="region" aria-label="バックアップのおすすめ" hidden></div>
    <div id="house-bar" class="house-bar" hidden>
      <div id="floor-tabs" class="tabs floor-tabs" role="group" aria-label="階の切り替え"></div>
      <p id="house-sum" class="house-sum muted small"></p>
    </div>
    <div class="views">
      <section id="house-empty" class="house-empty" aria-labelledby="house-empty-cap" hidden></section>
      <section id="plan-pane" class="view-pane" aria-labelledby="plan-cap">
        <h2 id="plan-cap" class="cap">平面図</h2>
        <div id="plan-host" class="plan-host"></div>
      </section>
      <section id="floor-pane" class="floor-pane" aria-label="間取りの編集" hidden></section>
      <section id="catalog-pane" class="catalog-pane" aria-label="家具台帳" hidden></section>
      <section id="settings-pane" class="settings-pane" aria-label="設定" hidden></section>
      <section id="view3d-pane" class="view-pane" aria-labelledby="view3d-cap">
        <h2 id="view3d-cap" class="cap">3D</h2>
        <div id="view3d-host" class="view3d-host"></div>
      </section>
    </div>
    </div>
    <aside id="side-pane" class="pane-right" aria-labelledby="side-cap">
      <h2 id="side-cap" class="cap">家具</h2>
      <div id="side-body"></div>
    </aside>
  </div>
</div>`;

let root = null;
const $ = (sel) => root.querySelector(sel);
const urls = {};   // hash → blob: URL(取り出し済みのもの)
const loading = new Set();
let planVp = null;      // 平面図の拡大・移動(view.js)
let planKey = '';       // 表示している中身(部屋か階)。変わったら全体を表示し直す
let view3d = null;      // 3D表示(view3d.js)
let v3Sig = null;       // 3D に渡した中身(家・部屋・案・写真の数)。同じなら場面を作り直さない
let swallowClick = false;

export function mountShell(el) {
  root = el;
  root.innerHTML = FRAME;
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onRoomKey);
  document.addEventListener('keydown', onKey);
  store.on('change', render);
  store.on('select', render);
  store.on('view', renderView);
  // 平面図は viewBox で拡大・移動する。枠の大きさが変わったときの描き直しも view.js が受け持つ
  planVp = createViewport($('#plan-host'), { getBounds: planBounds, render: planSvg, label: '平面図', margin: 32 });
  mountFloorEditor($('#floor-pane'));
  mountCatalog($('#catalog-pane'));
  mountSettings($('#settings-pane'));
  mountNudge($('#backup-nudge'));
  // 部屋を選んでいるときは、平面図と右の一覧を家具の配置(ui-room.js)が受け持つ
  mountRoomEditor($('#plan-pane'), $('#side-body'));
  mountView3d();
  render();
  renderView();
}

// 今見ている部屋(なければ階)
function planTarget() {
  const { house, sel } = store;
  const found = sel.roomId ? findRoom(house, sel.roomId) : null;
  const floor = found?.floor ?? house.floors.find((f) => f.id === sel.floorId);
  return { found, floor };
}

function planBounds() {
  const { found, floor } = planTarget();
  if (found) return null;
  return floor ? floorBounds(store.house, floor.id, { blobUrls: urls }) : null;
}

function planSvg({ viewBox, size }) {
  const { house } = store;
  const { found, floor } = planTarget();
  if (found) return '';   // 部屋の図は ui-room.js
  // 家全体: 部屋名の下に広さ。部屋は Tab で選べ、Enter で開く
  if (floor) return renderFloorSvg(house, floor.id, { blobUrls: urls, size, viewBox: planBounds() ? viewBox : null, areas: true, focusable: true });
  return '<p class="placeholder">「階を追加」から間取りを作ります</p>';
}

// 画面全体を描き直す(フォーカスしていた一覧のボタンは描き直したあとも保つ)
export function render() {
  if (!root) return;
  const focusKey = keyOf(document.activeElement);
  renderLeft();
  renderHouseBar();
  renderCenter();
  renderPlan();
  renderSide();
  renderHistory();
  render3d();
  renderNudge();
  if (focusKey) root.querySelector(focusKey)?.focus();
}

function keyOf(el) {
  if (!el || !root.contains(el)) return null;
  const box = el.closest('#left-pane, #side-pane, #floor-tabs');
  if (!box) return null;
  for (const a of ['data-room-id', 'data-floor-id', 'data-floor-tab', 'data-placement-id', 'data-furniture-id']) {
    if (el.hasAttribute?.(a)) return `#${box.id} button[${a}="${CSS.escape(el.getAttribute(a))}"]`;
  }
  return null;
}

function renderLeft() {
  const { house, sel } = store;
  const html = house.floors.map((f) => {
    const floorCur = f.id === sel.floorId && !sel.roomId;
    const rooms = f.rooms.map((r) => {
      const cur = r.id === sel.roomId;
      return `<li><button type="button" class="room-btn" data-room-id="${esc(r.id)}"${cur ? ' aria-current="true"' : ''}>${esc(r.name)}</button></li>`;
    }).join('');
    return `<section class="floor-group">
      <h3 class="floor-head"><button type="button" class="floor-btn" data-floor-id="${esc(f.id)}"${floorCur ? ' aria-current="true"' : ''}>${esc(f.name)}</button></h3>
      ${rooms ? `<ul class="room-list">${rooms}</ul>` : '<p class="muted small">部屋はまだありません</p>'}
    </section>`;
  }).join('');
  $('#floor-list').innerHTML = html || '<p class="muted small empty-left">階がまだありません。「階を追加」から始めます</p>';
}

// 家全体の上の帯: 階のタブと、その階の部屋の数・広さの合計
function renderHouseBar() {
  const { house, sel } = store;
  $('#floor-tabs').innerHTML = house.floors.map((f) => `<button type="button" class="tab floor-tab" data-floor-tab="${esc(f.id)}" aria-pressed="${f.id === sel.floorId}">${esc(f.name)}</button>`).join('');
  const floor = house.floors.find((f) => f.id === sel.floorId);
  const sqm = floor ? floor.rooms.reduce((s, r) => s + polygonArea(r.polygon), 0) : 0;
  $('#house-sum').textContent = floor && floor.rooms.length ? `${floor.name} ・ 部屋 ${floor.rooms.length} ・ 合計 ${areaText(sqm)}` : '';
}

// 部屋が1つもない家: 中央に始め方の案内(平面図と3Dの代わり)
const houseIsEmpty = () => !store.house.floors.some((f) => f.rooms.length);
function renderCenter() {
  const empty = $('#house-empty');
  const show = store.mode === 'house' && houseIsEmpty();
  const hasFloor = store.house.floors.length > 0;
  const sig = show ? (hasFloor ? 'edit' : 'add') : '';
  if (empty.dataset.sig !== sig) {
    empty.dataset.sig = sig;
    empty.innerHTML = show ? `
      <div class="he-card">
        <h2 id="house-empty-cap" class="he-title">間取りを作りましょう</h2>
        <ol class="he-steps">
          <li><span class="he-num" aria-hidden="true">1</span><span>階を追加して図面の写真を取り込む</span></li>
          <li><span class="he-num" aria-hidden="true">2</span><span>縮尺を合わせて部屋をなぞる</span></li>
          <li><span class="he-num" aria-hidden="true">3</span><span>家具を登録して部屋に置く</span></li>
        </ol>
        ${hasFloor
          ? `<button type="button" class="pill pill-accent he-btn" data-action="edit-floor">${icon('edit', 18)}<span>間取りを編集</span></button>`
          : `<button type="button" class="pill pill-accent he-btn" data-action="add-floor">${icon('plus', 18)}<span>階を追加</span></button>`}
      </div>` : '';
  }
  applyPanes();
}

function renderPlan() {
  const { found, floor } = planTarget();
  if (floor?.image?.hash) ensureUrl(floor.image.hash);
  $('#plan-cap').textContent = found ? `平面図 ・ ${found.floor.name} ${found.room.name}` : floor ? `平面図 ・ ${floor.name}` : '平面図';
  // 部屋の図は ui-room.js が描く。階の図は隠して中身を空にする
  $('#plan-host').hidden = !!found;
  if (found) {
    if (planKey) { planKey = ''; planVp.canvas.innerHTML = ''; }
    return;
  }
  const key = found ? `room:${found.room.id}` : floor ? `floor:${floor.id}` : '';
  if (key !== planKey) { planKey = key; planVp.fit(); } else planVp.refresh();
}

// 画像の URL を取り出し、取れたら描き直す(図面は平面図、家具の写真は3D)
function ensureUrl(hash, then = renderPlan) {
  if (urls[hash] || loading.has(hash)) return;
  loading.add(hash);
  blobUrl(hash).then((u) => { if (u) { urls[hash] = u; then(); } }).catch(() => {}).finally(() => loading.delete(hash));
}

// ---- 3D表示: 選んでいる部屋・案を描く。平面図での選択・ドラッグを反映し、3Dで選んだ家具を store に伝える
function mountView3d() {
  view3d = createView3d($('#view3d-host'));
  if (window.__madori) window.__madori.view3d = view3d;
  view3d.onSelect((placementId) => store.select({ placementId }));
  // 階全体の3Dで部屋の床か家具を押すと、その部屋へ(家具なら、その家具を選んだ状態で)
  view3d.onRoomPick((roomId, placementId) => {
    if (store.mode !== 'house' || store.sel.roomId) return;
    const found = findRoom(store.house, roomId);
    const cur = found?.room.plans.find((p) => p.isCurrent);
    store.select({ roomId, placementId: placementId && cur?.placements.some((pl) => pl.id === placementId) ? placementId : null });
  });
  onRoomLive((p) => view3d.moveLive(p));
  // 「人の目線」の場所選びの間は、平面図のクリックで立つ位置を決める(家具の選択・ドラッグはしない)
  const plan = $('#plan-pane');
  plan.addEventListener('pointerdown', onPlanPick, true);
  for (const t of ['pointerup', 'click']) {
    plan.addEventListener(t, (e) => {
      if (!swallowClick) return;
      e.stopPropagation(); e.preventDefault();
      if (t === 'click') swallowClick = false;
    }, true);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view3d.picking) view3d.cancelPick(); });
}

function onPlanPick(e) {
  if (!view3d?.picking || e.button !== 0) return;
  const svg = e.target.closest?.('#room-host svg.plan-svg');
  if (!svg) return;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  e.stopPropagation(); e.preventDefault();
  swallowClick = true;
  view3d.setCamera('eye', { x: p.x, y: p.y });
}

function render3d() {
  if (!view3d) return;
  const { house, sel } = store;
  const found = sel.roomId ? findRoom(house, sel.roomId) : null;
  // 部屋を選んでいなければ、選んでいる階の全部屋(各部屋の「現状」)
  const floor = found ? null : house.floors.find((f) => f.id === sel.floorId) ?? null;
  $('#view3d-cap').textContent = found ? `3D ・ ${found.floor.name} ${found.room.name}` : floor ? `3D ・ ${floor.name} 全体` : '3D';
  const spec = found ? sceneSpec(house, { roomId: found.room.id, planId: sel.planId })
    : floor ? sceneSpec(house, { floorId: floor.id }) : { floors: [], walls: [], items: [] };
  for (const it of spec.items) if (it.photoHash) ensureUrl(it.photoHash, () => { v3Sig = null; render3d(); });
  const sig = [house, found?.room.id, sel.planId, floor?.id, Object.keys(urls).length];
  if (!v3Sig || sig.some((v, i) => v !== v3Sig[i])) {
    v3Sig = sig;
    view3d.show(spec, { blobUrls: urls, label: found ? found.room.name : floor ? `${floor.name}全体` : '' });
  }
  view3d.select(sel.placementId);
}

// 部屋を選んでいないときの案内だけ。部屋の家具の一覧と詳細は ui-room.js が描く
function renderSide() {
  if (store.sel.roomId) return;
  $('#side-body').innerHTML = '<p class="muted small">部屋を選ぶと、置いてある家具が並びます</p>';
}

function renderHistory() {
  $('#undo-btn').disabled = !store.canUndo;
  $('#redo-btn').disabled = !store.canRedo;
}

function renderView() {
  const shell = $('.shell');
  shell.dataset.view = store.view;
  shell.dataset.mode = store.mode;
  for (const b of root.querySelectorAll('button[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === store.view));
  for (const b of root.querySelectorAll('button[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === store.mode));
  renderCenter();
  const full = store.mode === 'floor-edit' || store.mode === 'catalog' || store.mode === 'settings';
  if (!full) { renderPlan(); render3d(); }   // 隠れていた間の変更を反映する
}

// 中央のどの画面を出すか(モードと表示の切り替え、空の家の案内)
function applyPanes() {
  const editing = store.mode === 'floor-edit';
  const catalog = store.mode === 'catalog';
  const settings = store.mode === 'settings';
  const full = editing || catalog || settings;   // 中央を1つの画面で使うモード
  const empty = store.mode === 'house' && houseIsEmpty();
  $('#house-empty').hidden = !empty;
  $('#house-bar').hidden = store.mode !== 'house' || empty;
  $('#plan-pane').hidden = full || empty || store.view === '3d';
  $('#view3d-pane').hidden = full || empty || store.view === 'plan';
  $('#catalog-pane').hidden = !catalog;
  $('#settings-pane').hidden = !settings;
  $('#side-pane').hidden = full;
  $('#toggle-right').hidden = full;
}

// 家全体に戻る(ロゴ・左の階の名前)。floorId を渡すとその階を見る
function goHouse(floorId) {
  if (store.mode === 'floor-edit') finishFloorEdit();
  store.select(floorId ? { floorId, roomId: null } : { roomId: null });
  store.setMode('house');
}

// 平面図の部屋にフォーカスして Enter / Space → その部屋へ
function onRoomKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const g = e.target.closest?.('#plan-host svg.floor-plan [data-room-id]');
  if (!g || store.sel.roomId) return;
  e.preventDefault();
  store.select({ roomId: g.dataset.roomId });
}

function togglePane(side) {
  const shell = $('.shell');
  const cls = side === 'left' ? 'left-open' : 'right-open';
  const open = !shell.classList.contains(cls);
  shell.classList.toggle(cls, open);
  $(side === 'left' ? '#toggle-left' : '#toggle-right').setAttribute('aria-expanded', String(open));
}

function onClick(e) {
  const btn = e.target.closest('button');
  if (btn && root.contains(btn)) {
    if (btn.id === 'toggle-left') return togglePane('left');
    if (btn.id === 'toggle-right') return togglePane('right');
    if (btn.id === 'undo-btn') return store.undo();
    if (btn.id === 'redo-btn') return store.redo();
    if (btn.dataset.view) return store.setView(btn.dataset.view);
    if (btn.id === 'edit-floor-btn') return store.mode === 'floor-edit' ? finishFloorEdit() : startFloorEdit();
    if (btn.dataset.mode) return store.setMode(store.mode === btn.dataset.mode ? 'house' : btn.dataset.mode);
    if (btn.dataset.action === 'add-floor') return addFloorAndEdit();
    if (btn.dataset.action === 'edit-floor') return startFloorEdit();
    if (btn.dataset.action === 'home') return goHouse();
    if (btn.dataset.action === 'edit-furniture' && btn.closest('#side-pane')) return openFurnitureForm(btn.dataset.furnitureId);
    if (btn.dataset.action === 'send') return sendToPhones();
    if (btn.dataset.action) return;   // バックアップのおすすめの帯のボタンは ui-settings.js が受け持つ
    if (btn.hasAttribute('data-room-id')) {
      store.select({ roomId: btn.dataset.roomId });
      if (store.mode === 'settings') store.setMode('room');   // 設定画面から部屋を選んだら、その部屋へ
      return;
    }
    if (btn.hasAttribute('data-floor-id')) return goHouse(btn.dataset.floorId);
    if (btn.hasAttribute('data-floor-tab')) return store.select({ floorId: btn.dataset.floorTab, roomId: null });
    if (btn.hasAttribute('data-placement-id')) {
      const id = btn.dataset.placementId;
      return store.select({ placementId: store.sel.placementId === id ? null : id });
    }
    return;
  }
  // 階の図の部屋を押すとその部屋へ(部屋の図のクリックは ui-room.js)
  if (!e.target.closest('#plan-host')) return;
  const room = e.target.closest('[data-room-id]');
  if (!store.sel.roomId && room) store.select({ roomId: room.dataset.roomId });
}

function onKey(e) {
  if (e.defaultPrevented || e.isComposing) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
  else if ((k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey && !e.metaKey)) { e.preventDefault(); store.redo(); }
}
