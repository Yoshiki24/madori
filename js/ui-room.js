// 家具の配置(部屋ごと)。中央に部屋の図(ドラッグ・回転・吸着・すき間・警告・測る道具)と配置案のタブ、
// 右に置く家具の一覧と、選んだ家具の詳細。
// ドラッグ中は SVG の要素の transform だけを変え(描き直さない・commit しない)、離したときに1回だけ commit する(1手)
import { store } from './store.js';
import {
  findRoom, place, updatePlacement, removePlacement, addPlan, setCurrentPlan, removePlan, planTotal, updateRoom,
} from './model.js';
import { snapPlacement, snapAngle } from './snap.js';
import { checkPlan, clearances, placementRect } from './check.js';
import { renderRoomSvg, roomBounds } from './plan2d.js';
import { createViewport } from './view.js';
import { confirmDialog } from './dialog.js';
import { furnitureCardHtml, photoUrl, onPhotoReady, openFurnitureForm } from './ui-catalog.js';
import { formatPrice, statusLabel } from './catalog-logic.js';
import { formatMm } from './scale.js';
import { rectCorners, dist } from './geom.js';
import { icon, iconPath } from './icons.js';
import {
  SNAP_PX, CLICK_PX, NUDGE, NUDGE_BIG, DUP_OFFSET, ROTATE_STEP,
  newPlacementSpot, snapToCorners, nextPlanName, warningText, otherCurrentRooms, placedNotice,
  canDuplicate, parseNumber, normDeg, angleFromCenter,
} from './room-logic.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const n2 = (v) => (Math.round(v * 100) / 100).toString();
const num1 = (v) => String(Math.round(v * 10) / 10);   // 入力欄の表示(小数1桁まで。データは丸めない)
const FULL_MODES = ['floor-edit', 'catalog', 'settings'];   // 中央を別の画面が使うモード
const NOTICE_MS = 6000;
const DRAG_TYPE = 'application/x-madori-furniture';

const MSG = {
  single: '同じ家具は1つです',
  locked: '固定されています。右の「固定」を外すと動かせます',
  number: '数値を入力してください',
  elevation: '0 以上の数値を入力してください',
};

let editor = null, side = null, host = null, vp = null;
let roomKey = '';
let focusPl = null;          // 描き直す前にフォーカスしていた家具(描き直したあとに戻す)
let measure = { on: false, pts: [], hover: null };
let menu = null;             // { kind: 'plan' | 'add', planId, trigger }
let renaming = null;         // 名前を変えている案の id
let noticeText = '', noticeTimer = null;
let dragFurnitureId = null;  // 右の一覧からドラッグしている家具
let dragging = false;
let lastWarnings = [];       // 最後に描いた図の警告(重ね書きで使い回す)
const liveListeners = new Set();

const $ = (sel) => editor.querySelector(sel);

// ---- 状態の取り出し ----

function ctx() {
  const { house, sel } = store;
  if (!sel.roomId) return null;
  const found = findRoom(house, sel.roomId);
  if (!found) return null;
  const plan = found.room.plans.find((p) => p.id === sel.planId) ?? found.room.plans.find((p) => p.isCurrent) ?? found.room.plans[0];
  if (!plan) return null;
  return { house, floor: found.floor, room: found.room, plan };
}

const furnitureOf = (house, pl) => house.furniture.find((f) => f.id === pl?.furnitureId) ?? null;
const selectedOf = (c) => (c && store.sel.placementId ? c.plan.placements.find((p) => p.id === store.sel.placementId) ?? null : null);
const editorOn = () => !!ctx() && !FULL_MODES.includes(store.mode);

// 他の家具の四角(吸着・空き場所の判定に使う)
function rectsOf(c, exceptId = null) {
  const out = [];
  for (const pl of c.plan.placements) {
    if (pl.id === exceptId) continue;
    const f = furnitureOf(c.house, pl);
    if (f) out.push(placementRect(pl, f));
  }
  return out;
}

// 3D などがドラッグ中の位置を知るための通知。fn({ placementId, x, y, rotationDeg }) / 終わったら fn(null)
export function onRoomLive(fn) {
  liveListeners.add(fn);
  return () => liveListeners.delete(fn);
}
function emitLive(v) {
  for (const fn of liveListeners) { try { fn(v); } catch (e) { console.error(e); } }
}

// ---- 枠 ----

export function mountRoomEditor(planEl, sideEl) {
  side = sideEl;
  editor = document.createElement('div');
  editor.id = 'room-editor';
  editor.className = 'room-editor';
  editor.hidden = true;
  editor.innerHTML = `
    <div id="room-bar" class="room-bar">
      <div id="plan-tabs" class="plan-tabs" role="group" aria-label="配置案"></div>
      <div class="pop-wrap">
        <button type="button" id="plan-add-btn" class="pill pill-ghost-inline" aria-haspopup="menu" aria-expanded="false" aria-controls="plan-add-menu">${icon('plus', 18)}<span>案を追加</span></button>
        <div id="plan-add-menu" class="pop-menu" role="menu" aria-label="案を追加" hidden>
          <button type="button" role="menuitem" data-plan-action="add-empty">空の案</button>
          <button type="button" role="menuitem" data-plan-action="add-copy">今の案を複製</button>
        </div>
      </div>
      <span id="plan-total" class="plan-total" hidden></span>
      <span class="spacer"></span>
      <button type="button" id="measure-btn" class="tool-btn" aria-pressed="false" title="2点の距離を測る(Esc で消す)">${icon('ruler', 18)}<span>測る</span></button>
      <div id="plan-menu" class="pop-menu" role="menu" hidden></div>
    </div>
    <div id="room-host" class="plan-host room-host"></div>
    <div class="room-status">
      <p id="measure-readout" class="measure-readout" aria-live="polite"></p>
      <p id="room-notice" class="room-notice" role="status" aria-live="polite"></p>
    </div>`;
  planEl.append(editor);
  host = $('#room-host');
  vp = createViewport(host, {
    getBounds: () => { const c = ctx(); return c ? roomBounds(c.house, c.room.id) : null; },
    render: renderSvg,
    afterRender: decorate,
    margin: 32,
    onTap,
    onDragStart,
    onHover,
    label: '部屋の平面図',
  });

  editor.addEventListener('click', onEditorClick);
  editor.addEventListener('keydown', onEditorKey);
  editor.addEventListener('focusout', (e) => { if (e.target.id === 'plan-rename-input') finishRename(true); });
  host.addEventListener('click', onCanvasClick);
  host.addEventListener('focusin', onCanvasFocus);
  host.addEventListener('dragover', onDragOver);
  host.addEventListener('drop', onDrop);
  side.addEventListener('click', onSideClick);
  side.addEventListener('change', onSideChange);
  side.addEventListener('dragstart', onSideDragStart);
  side.addEventListener('dragend', () => { dragFurnitureId = null; });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDocPointer, true);
  store.on('change', update);
  store.on('select', update);
  store.on('view', update);
  onPhotoReady(() => { const c = ctx(); if (c) renderSide(c); });
  update();
}

// store の通知ごとに描き直す
function update() {
  if (!editor) return;
  const c = ctx();
  const on = !!c && !FULL_MODES.includes(store.mode);
  editor.hidden = !on;
  if (!on) {
    if (roomKey) {
      roomKey = '';
      vp.canvas.innerHTML = '';
      setMeasure(false);
      closeMenu(false);
      renaming = null;
      clearNotice();
    }
  } else {
    if (c.room.id !== roomKey) {
      roomKey = c.room.id;
      measure.pts = []; measure.hover = null;
      renaming = null;
      closeMenu(false);
      clearNotice();
      vp.fit();
    } else vp.refresh();
    renderBar(c);
  }
  // 右の一覧は、部屋を選んでいれば(台帳のモードで隠れていても)作っておく
  if (c) renderSide(c);
}

// ---- 部屋の図 ----

function renderSvg({ viewBox, size }) {
  const c = ctx();
  if (!c) return '';
  const a = document.activeElement;
  focusPl = a && host.contains(a) && a.matches?.('g.furniture[data-placement-id]') ? a.dataset.placementId : null;
  const warnings = checkPlan(c.house, c.room, c.plan);
  lastWarnings = warnings;
  const sel = selectedOf(c);
  const cl = sel ? clearances(c.house, c.room, c.plan, sel.id) : [];
  return renderRoomSvg(c.house, c.room.id, c.plan.id, { selectedId: sel?.id ?? null, warnings, clearances: cl, size, viewBox });
}

// 描いたあと: 家具をキーボードで選べるようにし、鍵の印・回転のハンドル・吸着の線・測った線を重ねる
function decorate(svg) {
  const c = ctx();
  if (!c) return;
  const u = vp.unit;
  svg.setAttribute('role', 'group');
  const warnIds = new Set(lastWarnings.map((w) => w.placementId));
  for (const g of svg.querySelectorAll('g.furniture[data-placement-id]')) {
    const pl = c.plan.placements.find((p) => p.id === g.dataset.placementId);
    const f = furnitureOf(c.house, pl);
    if (!pl || !f) continue;
    const bits = [
      f.status === 'considering' ? '検討中' : '',
      `x ${formatMm(pl.x)}・y ${formatMm(pl.y)} mm`,
      pl.rotationDeg ? `${num1(pl.rotationDeg)}度` : '',
      pl.locked ? '固定' : '',
      warnIds.has(pl.id) ? '警告あり' : '',
    ].filter(Boolean);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-pressed', String(pl.id === store.sel.placementId));
    g.setAttribute('aria-label', `${f.name}(${bits.join('、')})`);
    if (pl.locked) g.classList.add('locked');
  }
  let over = '';
  for (const pl of c.plan.placements) {
    const f = furnitureOf(c.house, pl);
    if (f && pl.locked) over += lockIcon(placementRect(pl, f), u);
  }
  const sel = selectedOf(c);
  const sf = furnitureOf(c.house, sel);
  if (sel && sf && !sel.locked) over += rotHandle(sel, sf, u);
  over += '<g class="snap-guides"></g><g class="measure"></g>';
  svg.insertAdjacentHTML('beforeend', `<g class="room-overlay">${over}</g>`);
  drawMeasure();
  // 家具にフォーカスしていたら、描き直したあとは選んでいる家具へ(選択が別の所で変わったときも、選択とフォーカスをそろえる)
  if (focusPl) {
    const id = store.sel.placementId;
    const el = id ? svg.querySelector(`g.furniture[data-placement-id="${CSS.escape(id)}"]`) : null;
    (el ?? vp.canvas).focus({ preventScroll: true });
    focusPl = null;
  }
}

function lockIcon(r, u) {
  const cs = rectCorners(r);
  const x = Math.min(...cs.map((p) => p.x)), y = Math.min(...cs.map((p) => p.y));
  const s = (u * 16) / 24;
  return `<g class="lock-icon" transform="translate(${n2(x + u * 3)} ${n2(y + u * 3)}) scale(${n2(s)})" aria-hidden="true">`
    + '<rect class="lock-bg" x="0" y="0" width="24" height="24" rx="6"/>'
    + `<path d="${iconPath('lock')}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

// 回転のハンドル: 前の辺(回転 0 で上)の先の小さな丸
function rotHandle(pl, f, u) {
  const r = (pl.rotationDeg * Math.PI) / 180;
  const dir = { x: Math.sin(r), y: -Math.cos(r) };
  const a = { x: pl.x + dir.x * (f.depth / 2), y: pl.y + dir.y * (f.depth / 2) };
  const k = { x: a.x + dir.x * u * 26, y: a.y + dir.y * u * 26 };
  return `<g class="rot-handle" data-rot-id="${esc(pl.id)}" aria-hidden="true">`
    + `<line x1="${n2(a.x)}" y1="${n2(a.y)}" x2="${n2(k.x)}" y2="${n2(k.y)}" stroke-width="${n2(u * 1.5)}"/>`
    + `<circle class="rot-hit" cx="${n2(k.x)}" cy="${n2(k.y)}" r="${n2(u * 14)}"/>`
    + `<circle class="rot-knob" cx="${n2(k.x)}" cy="${n2(k.y)}" r="${n2(u * 7)}" stroke-width="${n2(u * 2)}"/>`
    + `<title>ドラッグで回す(15度刻み、Shift で自由)</title></g>`;
}

const svgEl = () => host.querySelector('svg.plan-svg');
const furnitureEl = (id) => svgEl()?.querySelector(`g.furniture[data-placement-id="${CSS.escape(id)}"]`) ?? null;

function drawGuides(guides) {
  const g = svgEl()?.querySelector('.snap-guides');
  if (!g) return;
  const u = vp.unit;
  g.innerHTML = (guides || []).map((s) => `<line x1="${n2(s.a.x)}" y1="${n2(s.a.y)}" x2="${n2(s.b.x)}" y2="${n2(s.b.y)}" stroke-width="${n2(u * 2.5)}"/>`).join('');
}

function focusFurniture(id) {
  furnitureEl(id)?.focus({ preventScroll: true });
}

// ---- ドラッグ・回転 ----

function onDragStart(e, p) {
  if (measure.on) return null;
  const c = ctx();
  if (!c) return null;
  const rot = e.target.closest?.('.rot-handle');
  if (rot) return rotateDrag(c, rot.dataset.rotId, e);
  const g = e.target.closest?.('g.furniture[data-placement-id]');
  if (!g) return null;
  const pl = c.plan.placements.find((x) => x.id === g.dataset.placementId);
  const f = furnitureOf(c.house, pl);
  if (!pl || !f) return null;
  clearNotice();
  closeMenu(false);
  const sx = e.clientX, sy = e.clientY;
  const id = pl.id;
  // 固定の家具は動かさない(押して離すと選ぶだけ)
  if (pl.locked) {
    let warned = false;
    return {
      move(q, ev) { if (!warned && Math.hypot(ev.clientX - sx, ev.clientY - sy) >= CLICK_PX) { warned = true; notice(MSG.locked); } },
      end() { store.select({ placementId: id }); focusFurniture(id); },
      cancel() {},
    };
  }
  const rect = placementRect(pl, f);
  const others = rectsOf(c, id);
  let moved = false, last = { x: pl.x, y: pl.y }, el = null;
  return {
    move(q, ev) {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < CLICK_PX) return;
      if (!moved) { moved = true; dragging = true; svgEl()?.classList.add('dragging'); el = furnitureEl(id); }
      const s = snapPlacement({ ...rect, x: pl.x + q.x - p.x, y: pl.y + q.y - p.y }, {
        room: c.room.polygon, others, tolerance: SNAP_PX * vp.unit, enabled: !ev.altKey,
      });
      last = { x: s.x, y: s.y };
      if (!el || !el.isConnected) el = furnitureEl(id);
      el?.setAttribute('transform', `translate(${n2(s.x - pl.x)} ${n2(s.y - pl.y)})`);
      drawGuides(s.guides);
      emitLive({ placementId: id, x: s.x, y: s.y, rotationDeg: pl.rotationDeg });
    },
    end() {
      dragging = false;
      if (!moved) { store.select({ placementId: id }); focusFurniture(id); return; }
      emitLive(null);
      store.select({ placementId: id });
      if (last.x === pl.x && last.y === pl.y) vp.refresh();
      else store.commit(updatePlacement(store.house, id, { x: last.x, y: last.y }));
      focusFurniture(id);
    },
    cancel() { dragging = false; emitLive(null); vp.refresh(); },
  };
}

function rotateDrag(c, id, e) {
  const pl = c.plan.placements.find((x) => x.id === id);
  if (!pl || pl.locked) return null;
  clearNotice();
  const center = { x: pl.x, y: pl.y };
  const sx = e.clientX, sy = e.clientY;
  let moved = false, deg = pl.rotationDeg || 0, inner = null;
  return {
    move(q, ev) {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < CLICK_PX) return;
      if (!moved) { moved = true; dragging = true; svgEl()?.classList.add('dragging'); inner = furnitureEl(id)?.querySelector(':scope > g[transform]'); }
      const a = angleFromCenter(center, q);
      deg = ev.shiftKey ? normDeg(a) : snapAngle(a, ROTATE_STEP);
      inner?.setAttribute('transform', `translate(${n2(pl.x)} ${n2(pl.y)}) rotate(${n2(deg)})`);
      showReadout(`回転 ${num1(deg)}度`);
      emitLive({ placementId: id, x: pl.x, y: pl.y, rotationDeg: deg });
    },
    end() {
      dragging = false;
      if (!moved) return;
      emitLive(null);
      showReadout('');
      if (deg === (pl.rotationDeg || 0)) { vp.refresh(); return; }
      store.select({ placementId: id });
      store.commit(updatePlacement(store.house, id, { rotationDeg: deg }));
      focusFurniture(id);
    },
    cancel() { dragging = false; emitLive(null); showReadout(''); vp.refresh(); },
  };
}

// 押して離しただけ(何もない所)。測る道具では点を足す。選択の解除は click で行う
function onTap(e, p) {
  if (!measure.on) return;
  const c = ctx();
  if (!c) return;
  const corners = [...c.room.polygon, ...rectsOf(c).flatMap((r) => rectCorners(r))];
  const q = snapToCorners(p, corners, SNAP_PX * vp.unit);
  const pt = { x: q.x, y: q.y };
  measure.pts = measure.pts.length >= 2 ? [pt] : [...measure.pts, pt];
  measure.hover = null;
  drawMeasure();
}

function onHover(p) {
  if (!measure.on || measure.pts.length !== 1) return;
  measure.hover = p;
  const line = svgEl()?.querySelector('.measure .measure-preview');
  if (line) { line.setAttribute('x2', p.x); line.setAttribute('y2', p.y); }
  else drawMeasure();
}

function drawMeasure() {
  const g = svgEl()?.querySelector('.measure');
  const u = vp?.unit ?? 1;
  const pts = measure.on ? measure.pts : [];
  let out = '';
  if (pts.length === 1 && measure.hover) {
    out += `<line class="measure-preview" x1="${n2(pts[0].x)}" y1="${n2(pts[0].y)}" x2="${n2(measure.hover.x)}" y2="${n2(measure.hover.y)}" stroke-width="${n2(u)}" stroke-dasharray="${n2(u * 4)} ${n2(u * 3)}"/>`;
  } else if (pts.length === 1) {
    out += `<line class="measure-preview" x1="${n2(pts[0].x)}" y1="${n2(pts[0].y)}" x2="${n2(pts[0].x)}" y2="${n2(pts[0].y)}" stroke-width="${n2(u)}"/>`;
  }
  if (pts.length === 2) {
    const [a, b] = pts;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    out += `<line class="measure-line" x1="${n2(a.x)}" y1="${n2(a.y)}" x2="${n2(b.x)}" y2="${n2(b.y)}" stroke-width="${n2(u * 2)}"/>`
      + `<text x="${n2(m.x)}" y="${n2(m.y - u * 12)}" font-size="${n2(u * 13)}" stroke-width="${n2(u * 4)}" text-anchor="middle" dominant-baseline="central">${formatMm(dist(a, b))} mm</text>`;
  }
  for (const p of pts) out += `<circle cx="${n2(p.x)}" cy="${n2(p.y)}" r="${n2(u * 4)}" stroke-width="${n2(u * 1.5)}"/>`;
  if (g) g.innerHTML = out;
  if (!measure.on) showReadout('');
  else if (pts.length === 2) showReadout(`距離 ${formatMm(dist(pts[0], pts[1]))} mm`);
  else showReadout(pts.length === 1 ? '2点目をクリックします(Esc で消す)' : '測りたい2点をクリックします(角に吸着します)');
}

function showReadout(t) {
  const el = editor && $('#measure-readout');
  if (el && el.textContent !== t) el.textContent = t;
}

function setMeasure(on) {
  measure = { on, pts: [], hover: null };
  if (!editor) return;
  $('#measure-btn').setAttribute('aria-pressed', String(on));
  host.classList.toggle('measuring', on);
  drawMeasure();
}

// 合成の click(キーボード・支援技術)と、何もない所のクリック
function onCanvasClick(e) {
  if (measure.on) return;
  const g = e.target.closest('g.furniture[data-placement-id]');
  if (g) store.select({ placementId: g.dataset.placementId });
  else if (e.target.closest('svg.plan-svg')) store.select({ placementId: null });
}

// Tab で家具にフォーカスしたら選ぶ
function onCanvasFocus(e) {
  const g = e.target.closest?.('g.furniture[data-placement-id]');
  if (g && !dragging && store.sel.placementId !== g.dataset.placementId) store.select({ placementId: g.dataset.placementId });
}

// 右の一覧からのドラッグ
function onSideDragStart(e) {
  const btn = e.target.closest?.('button[data-action="place"]');
  if (!btn) return;
  dragFurnitureId = btn.dataset.furnitureId;
  try { e.dataTransfer.setData(DRAG_TYPE, dragFurnitureId); e.dataTransfer.effectAllowed = 'copy'; } catch {}
}
function draggedId(e) {
  if (dragFurnitureId) return dragFurnitureId;
  try { return e.dataTransfer?.getData(DRAG_TYPE) || null; } catch { return null; }
}
function onDragOver(e) {
  if (!dragFurnitureId && !e.dataTransfer?.types?.includes(DRAG_TYPE)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}
function onDrop(e) {
  const id = draggedId(e);
  dragFurnitureId = null;
  if (!id || !vp.viewBox) return;
  e.preventDefault();
  placeFurniture(id, vp.toWorld(e.clientX, e.clientY));
}

// ---- 操作 ----

function notice(text) {
  noticeText = text;
  clearTimeout(noticeTimer);
  const el = editor && $('#room-notice');
  if (el) el.textContent = text;
  const m = side?.querySelector('#rd-msg');
  if (m) m.textContent = text;
  if (text) noticeTimer = setTimeout(() => notice(''), NOTICE_MS);
}
function clearNotice() { if (noticeText) notice(''); }

function placeFurniture(furnitureId, at = null) {
  const c = ctx();
  if (!c) return;
  clearNotice();
  const f = c.house.furniture.find((x) => x.id === furnitureId);
  if (!f) return;
  if (f.status === 'owned') {
    const here = c.plan.placements.find((p) => p.furnitureId === f.id);
    if (here) { store.select({ placementId: here.id }); notice(MSG.single); return; }
  }
  const spot = at ?? newPlacementSpot(c.room.polygon, f, rectsOf(c));
  const r = place(c.house, c.room.id, c.plan.id, f.id, spot);
  if (!r.placementId) return;
  store.commit(r.house);
  store.select({ placementId: r.placementId });
  if (f.status === 'owned') {
    const t = placedNotice(otherCurrentRooms(store.house, f.id, c.room.id));
    if (t) notice(t);
  }
}

function nudge(pl, dx, dy) {
  if (pl.locked) { notice(MSG.locked); return; }
  store.commit(updatePlacement(store.house, pl.id, { x: pl.x + dx, y: pl.y + dy }));
}

function rotate90(pl) {
  if (pl.locked) { notice(MSG.locked); return; }
  store.commit(updatePlacement(store.house, pl.id, { rotationDeg: normDeg((pl.rotationDeg || 0) + 90) }));
}

function duplicate(c, pl) {
  const f = furnitureOf(c.house, pl);
  if (!f) return;
  if (!canDuplicate(f)) { notice(MSG.single); return; }
  const r = place(c.house, c.room.id, c.plan.id, f.id, { x: pl.x + DUP_OFFSET, y: pl.y + DUP_OFFSET });
  if (!r.placementId) return;
  const h = updatePlacement(r.house, r.placementId, { rotationDeg: pl.rotationDeg || 0, elevation: pl.elevation || 0 });
  store.commit(h);
  store.select({ placementId: r.placementId });
}

function remove(pl, byKey) {
  if (byKey && pl.locked) { notice(MSG.locked); return; }
  store.commit(removePlacement(store.house, pl.id));
}

// ---- キー ----

// 文字を打つ欄にいるときはキーを奪わない(チェックボックスなどは対象外)
const NON_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'];
const editable = (t) => t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName)
  || (t.tagName === 'INPUT' && !NON_TEXT.includes(t.type)));
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function onKey(e) {
  if (e.defaultPrevented || e.isComposing || !editorOn()) return;
  if (document.querySelector('dialog[open]')) return;
  const t = e.target;
  if (editable(t) || t?.closest?.('[role="menu"]')) return;
  const consume = () => { e.preventDefault(); e.stopPropagation(); };
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  if (k === 'Escape' && !mod) {
    if (menu) { consume(); closeMenu(true); return; }
    if (measure.on && measure.pts.length) { consume(); measure.pts = []; measure.hover = null; drawMeasure(); return; }
    if (store.sel.placementId) { consume(); clearNotice(); store.select({ placementId: null }); return; }
    if (measure.on) { consume(); setMeasure(false); }
    return;
  }
  const c = ctx();
  const pl = selectedOf(c);
  if (!pl) return;
  if (mod && !e.altKey && !e.shiftKey && k.toLowerCase() === 'd') { consume(); clearNotice(); duplicate(c, pl); return; }
  if (mod || e.altKey) return;
  if (ARROWS[k]) {
    consume(); clearNotice();
    const s = e.shiftKey ? NUDGE_BIG : NUDGE;
    nudge(pl, ARROWS[k][0] * s, ARROWS[k][1] * s);
    return;
  }
  if (k === 'Delete' || k === 'Backspace') { consume(); clearNotice(); remove(pl, true); return; }
  if ((k === 'r' || k === 'R') && !e.shiftKey) { consume(); clearNotice(); rotate90(pl); }
}

// ---- 配置案のタブ ----

function renderBar(c) {
  const tabs = $('#plan-tabs');
  const focusKey = keyOf(tabs);
  tabs.innerHTML = c.room.plans.map((p) => {
    const sel = p.id === c.plan.id;
    if (p.id === renaming) {
      return `<span class="plan-tab-wrap renaming"><input id="plan-rename-input" class="plan-rename" value="${esc(p.name)}" aria-label="案の名前" maxlength="40"></span>`;
    }
    return `<span class="plan-tab-wrap${sel ? ' sel' : ''}">
      <button type="button" class="plan-tab" data-plan-id="${esc(p.id)}" aria-pressed="${sel}">${esc(p.name)}${p.isCurrent && p.name !== '現状' ? '<span class="cur-badge">現状</span>' : ''}</button>
      <button type="button" class="icon-btn plan-menu-btn" data-plan-id="${esc(p.id)}" aria-haspopup="menu" aria-expanded="${menu?.kind === 'plan' && menu.planId === p.id}" aria-label="「${esc(p.name)}」のメニュー" title="案のメニュー">${icon('more', 18)}</button>
    </span>`;
  }).join('');
  const total = planTotal(c.house, c.plan);
  const t = $('#plan-total');
  t.hidden = !(total > 0);
  t.textContent = total > 0 ? `検討中の合計 ${formatPrice(total)}` : '';
  if (renaming) {
    const input = $('#plan-rename-input');
    if (input && document.activeElement !== input) { input.focus(); input.select(); }
  } else if (focusKey) tabs.querySelector(focusKey)?.focus();
  if (menu?.kind === 'plan') renderPlanMenu(c);
}

function renderPlanMenu(c) {
  const p = c.room.plans.find((x) => x.id === menu.planId);
  const m = $('#plan-menu');
  if (!p) { closeMenu(false); return; }
  const last = c.room.plans.length <= 1;
  m.setAttribute('aria-label', `「${p.name}」のメニュー`);
  m.innerHTML = `
    <button type="button" role="menuitem" data-plan-action="rename">${icon('edit', 16)}<span>名前を変える</span></button>
    <button type="button" role="menuitem" data-plan-action="duplicate">${icon('copy', 16)}<span>複製</span></button>
    <button type="button" role="menuitem" data-plan-action="current"${p.isCurrent ? ' disabled aria-disabled="true"' : ''}>${icon('check', 16)}<span>現状にする</span></button>
    <button type="button" role="menuitem" data-plan-action="delete" class="danger"${last ? ' disabled aria-disabled="true" title="最後の1つの案は削除できません"' : ''}>${icon('trash', 16)}<span>削除</span></button>`;
}

function openMenu(kind, trigger, planId = null) {
  const c = ctx();
  if (!c) return;
  closeMenu(false);
  menu = { kind, planId, trigger };
  trigger.setAttribute('aria-expanded', 'true');
  let m;
  if (kind === 'add') m = $('#plan-add-menu');
  else {
    m = $('#plan-menu');
    renderPlanMenu(c);
    // メニューの位置: 押したボタンの下
    const bar = $('#room-bar').getBoundingClientRect(), r = trigger.getBoundingClientRect();
    m.style.left = `${Math.max(0, r.left - bar.left)}px`;
    m.style.top = `${r.bottom - bar.top + 4}px`;
  }
  m.hidden = false;
  m.querySelector('button:not(:disabled)')?.focus();
}

function closeMenu(returnFocus) {
  if (!editor || !menu) return;
  const { trigger, kind, planId } = menu;
  menu = null;
  $('#plan-add-menu').hidden = true;
  $('#plan-menu').hidden = true;
  if (kind === 'add') $('#plan-add-btn').setAttribute('aria-expanded', 'false');
  const t = kind === 'plan' ? $(`#plan-tabs .plan-menu-btn[data-plan-id="${CSS.escape(planId)}"]`) : trigger;
  t?.setAttribute('aria-expanded', 'false');
  if (returnFocus) t?.focus();
}

// メニューの外を押したら閉じる
function onDocPointer(e) {
  if (!menu) return;
  if (e.target.closest?.('.pop-menu') || e.target.closest?.('#plan-add-btn, .plan-menu-btn')) return;
  closeMenu(false);
}

function onEditorKey(e) {
  // メニューの中: 上下で移る、Esc で閉じる
  const m = e.target.closest?.('[role="menu"]');
  if (m) {
    const items = [...m.querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(e.target);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') closeMenu(false);
    return;
  }
  if (e.target.id === 'plan-rename-input') {
    if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishRename(false); }
  }
}

function startRename(planId) {
  renaming = planId;
  const c = ctx();
  if (c) renderBar(c);
}

function finishRename(save) {
  if (!renaming) return;
  const id = renaming;
  const input = $('#plan-rename-input');
  const name = (input?.value ?? '').trim();
  renaming = null;
  const c = ctx();
  if (save && c && name) {
    const p = c.room.plans.find((x) => x.id === id);
    if (p && p.name !== name) {
      store.commit(updateRoom(c.house, c.room.id, { plans: c.room.plans.map((x) => (x.id === id ? { ...x, name } : x)) }));
      $(`#plan-tabs .plan-tab[data-plan-id="${CSS.escape(id)}"]`)?.focus();
      return;
    }
  }
  if (c) renderBar(c);
  $(`#plan-tabs .plan-tab[data-plan-id="${CSS.escape(id)}"]`)?.focus();
}

async function planAction(action, planId) {
  const c = ctx();
  if (!c) return;
  clearNotice();
  const names = c.room.plans.map((p) => p.name);
  if (action === 'add-empty' || action === 'add-copy' || action === 'duplicate') {
    const from = action === 'add-copy' ? c.plan.id : action === 'duplicate' ? planId : null;
    const r = addPlan(c.house, c.room.id, nextPlanName(names), from);
    if (!r.planId) return;
    store.commit(r.house);
    store.select({ planId: r.planId, placementId: null });
    $(`#plan-tabs .plan-tab[data-plan-id="${CSS.escape(r.planId)}"]`)?.focus();
  } else if (action === 'rename') {
    startRename(planId);
  } else if (action === 'current') {
    store.commit(setCurrentPlan(c.house, c.room.id, planId));
  } else if (action === 'delete') {
    const p = c.room.plans.find((x) => x.id === planId);
    if (!p || c.room.plans.length <= 1) return;
    const ok = await confirmDialog({
      title: '配置案を削除',
      message: `「${p.name}」を削除します。この案の家具の配置も消えます(取り消しで戻せます)`,
      ok: '削除する', danger: true,
    });
    if (!ok) return;
    const now = ctx();
    if (!now) return;
    store.commit(removePlan(now.house, now.room.id, planId));
    // フォーカスが body に落ちないよう、残った案(選んでいる案)のタブへ送る
    const sel = store.sel.planId;
    ($(`#plan-tabs .plan-tab[data-plan-id="${CSS.escape(sel ?? '')}"]`) ?? $('#plan-tabs .plan-tab'))?.focus();
  }
}

function onEditorClick(e) {
  const btn = e.target.closest('button');
  if (!btn || !editor.contains(btn)) return;
  if (btn.id === 'measure-btn') { clearNotice(); setMeasure(!measure.on); return; }
  if (btn.id === 'plan-add-btn') { if (menu?.kind === 'add') closeMenu(true); else openMenu('add', btn); return; }
  if (btn.classList.contains('plan-menu-btn')) {
    if (menu?.kind === 'plan' && menu.planId === btn.dataset.planId) closeMenu(true);
    else openMenu('plan', btn, btn.dataset.planId);
    return;
  }
  if (btn.classList.contains('plan-tab')) { closeMenu(false); clearNotice(); store.select({ planId: btn.dataset.planId, placementId: null }); return; }
  if (btn.dataset.planAction) {
    const planId = menu?.planId ?? null;
    const action = btn.dataset.planAction;
    closeMenu(action !== 'rename' && action !== 'delete' && !action.startsWith('add') && action !== 'duplicate');
    planAction(action, planId);
  }
}

// ---- 右: 選んだ家具の詳細と、置く家具の一覧 ----

// フォーカスしている要素を描き直したあとに探すための selector
function keyOf(root) {
  const a = document.activeElement;
  if (!a || !root.contains(a)) return null;
  if (a.id) return `#${CSS.escape(a.id)}`;
  let s = a.tagName.toLowerCase();
  if (a.classList[0]) s += `.${CSS.escape(a.classList[0])}`;
  for (const at of ['data-action', 'data-placement-id', 'data-furniture-id', 'data-plan-id']) {
    if (a.hasAttribute(at)) s += `[${at}="${CSS.escape(a.getAttribute(at))}"]`;
  }
  return s;
}

function renderSide(c) {
  const focusKey = keyOf(side);
  const { house } = c;
  const warnings = checkPlan(house, c.room, c.plan);
  const nameOf = (plId) => furnitureOf(house, c.plan.placements.find((p) => p.id === plId))?.name ?? '';
  const warnOf = (plId) => warnings.filter((w) => w.placementId === plId).map((w) => warningText(w, nameOf));
  const items = c.plan.placements.map((pl) => ({ pl, f: furnitureOf(house, pl) })).filter((x) => x.f);
  const consideringCount = items.filter((x) => x.f.status === 'considering').length;
  const sel = selectedOf(c);
  const sf = furnitureOf(house, sel);
  const inPlan = new Set(items.map((x) => x.f.id));

  const warnLines = (list) => list.map((t) => `<span class="warn-line">${icon('warn', 14)}<span>${esc(t)}</span></span>`).join('');

  let html = `<p class="plan-name small muted">${esc(c.plan.name)} ・ ${items.length}点${consideringCount ? `(検討中 ${consideringCount})` : ''}</p>`;
  if (sel && sf) html += detailHtml(sel, sf, warnOf(sel.id), warnLines);

  html += '<h3 class="side-sub">この案の家具</h3>';
  html += items.length
    ? `<ul class="furniture-list">${items.map(({ pl, f }) => {
      const w = warnOf(pl.id);
      return `<li class="side-card">
        <button type="button" class="furniture-item${w.length ? ' has-warn' : ''}" data-placement-id="${esc(pl.id)}" aria-pressed="${pl.id === store.sel.placementId}">${furnitureCardHtml(f, photoUrl(f.photo), { compact: true })}${w.length ? `<span class="item-warns">${warnLines(w)}</span>` : ''}</button>
        <button type="button" class="icon-btn side-edit" data-action="edit-furniture" data-furniture-id="${esc(f.id)}" aria-label="「${esc(f.name)}」を編集" title="編集">${icon('edit', 18)}</button>
      </li>`;
    }).join('')}</ul>`
    : '<p class="muted small">この案に家具はまだありません</p>';

  html += '<h3 class="side-sub">家具を置く</h3>';
  if (!house.furniture.length) {
    html += `<p class="muted small">家具台帳に家具がありません</p>
      <button type="button" class="pill pill-ghost-inline" data-action="new-furniture">${icon('plus', 18)}<span>家具を追加</span></button>`;
  } else {
    html += `<p class="muted small side-hint">押すと部屋の中央に置きます。図へドラッグしても置けます</p>
      <ul id="place-list" class="place-list">${house.furniture.map((f) => `<li>
        <button type="button" class="place-item" data-action="place" data-furniture-id="${esc(f.id)}" draggable="true" title="部屋に置く">${furnitureCardHtml(f, photoUrl(f.photo), { compact: true })}${inPlan.has(f.id) ? `<span class="placed-mark">${icon('check', 14)}配置済み</span>` : ''}</button>
      </li>`).join('')}</ul>`;
  }
  side.innerHTML = html;
  if (focusKey) side.querySelector(focusKey)?.focus({ preventScroll: true });
}

function detailHtml(pl, f, warns, warnLines) {
  const dis = pl.locked ? ' disabled aria-describedby="rd-lock-hint"' : '';
  const field = (id, label, value, extra = '') => `<label class="rd-field" for="${id}"><span>${label}</span><input id="${id}" type="text" inputmode="decimal" autocomplete="off" value="${esc(value)}"${extra}></label>`;
  return `<section id="rd-panel" class="rd-panel" aria-labelledby="rd-title">
    <h3 id="rd-title" class="rd-title">${esc(f.name)}</h3>
    <p class="rd-meta"><span class="fcard-size">${formatMm(f.width)}×${formatMm(f.depth)}×${formatMm(f.height)} mm</span> ・ ${esc(statusLabel(f.status))}${f.status === 'considering' && f.price ? ` ・ ${formatPrice(f.price)}` : ''}</p>
    <div id="rd-warns" class="rd-warns">${warnLines(warns)}</div>
    <div class="rd-grid">
      ${field('rd-x', 'x(mm)', num1(pl.x), dis)}
      ${field('rd-y', 'y(mm)', num1(pl.y), dis)}
      ${field('rd-rot', '回転(度)', num1(pl.rotationDeg || 0), dis)}
      ${field('rd-elev', '床からの高さ(mm)', num1(pl.elevation || 0))}
    </div>
    <label class="rd-lock" for="rd-lock"><input id="rd-lock" type="checkbox"${pl.locked ? ' checked' : ''}>${icon('lock', 16)}<span>固定(ドラッグ・キーで動かさない)</span></label>
    ${pl.locked ? '<p id="rd-lock-hint" class="muted small rd-hint">固定を外すと動かせます</p>' : ''}
    <div class="rd-actions">
      <button type="button" id="rd-rotate90" class="pill pill-ghost-inline" data-action="rotate90"${pl.locked ? ' disabled' : ''} title="90度回す(R)">${icon('rotate', 16)}<span>90度回す</span></button>
      <button type="button" id="rd-dup" class="pill pill-ghost-inline" data-action="duplicate" title="複製(⌘D)">${icon('copy', 16)}<span>複製</span></button>
      <button type="button" id="rd-del" class="pill pill-danger-outline" data-action="delete-placement" title="この案から外す(Delete)">${icon('trash', 16)}<span>削除</span></button>
      <button type="button" id="rd-edit" class="pill pill-ghost-inline" data-action="edit-furniture" data-furniture-id="${esc(f.id)}">${icon('book', 16)}<span>台帳で編集</span></button>
    </div>
    <p id="rd-msg" class="rd-msg">${esc(noticeText)}</p>
  </section>`;
}

function onSideClick(e) {
  const btn = e.target.closest('button');
  if (!btn || !side.contains(btn)) return;
  const a = btn.dataset.action;
  if (a === 'place') { placeFurniture(btn.dataset.furnitureId); return; }
  if (a === 'new-furniture') { openFurnitureForm(null); return; }
  const c = ctx();
  const pl = selectedOf(c);
  if (!pl) return;
  if (a === 'rotate90') { clearNotice(); rotate90(pl); }
  else if (a === 'duplicate') { clearNotice(); duplicate(c, pl); }
  else if (a === 'delete-placement') { clearNotice(); remove(pl, false); }
}

function onSideChange(e) {
  const t = e.target;
  const c = ctx();
  const pl = selectedOf(c);
  if (!pl) return;
  if (t.id === 'rd-lock') { clearNotice(); store.commit(updatePlacement(store.house, pl.id, { locked: t.checked })); return; }
  const key = { 'rd-x': 'x', 'rd-y': 'y', 'rd-rot': 'rotationDeg', 'rd-elev': 'elevation' }[t.id];
  if (!key) return;
  let v = parseNumber(t.value);
  if (v === null || (key === 'elevation' && v < 0)) {
    notice(key === 'elevation' ? MSG.elevation : MSG.number);
    t.value = num1(pl[key] || 0);
    return;
  }
  if (key === 'rotationDeg') v = normDeg(v);
  clearNotice();
  if (v !== (pl[key] || 0)) store.commit(updatePlacement(store.house, pl.id, { [key]: v }));
}
