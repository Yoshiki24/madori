// 間取りの編集(Mac)。図面の取り込み → 傾き → 縮尺 → 部屋を描く → ドア・窓、の順に使う。
// 座標は階の mm(原点は図面の画像の左上、x は右、y は下)。画像の 1px は mmPerPx mm(縮尺がない階は 1)。
// 家の変更はすべて store.commit(1つの操作 = 取り消し1手)。描きかけの多角形などは、確定するまでこの画面だけの状態
import { store } from './store.js';
import {
  addFloor, updateFloor, removeFloor, addRoom, updateRoom, removeRoom, addOpening, updateOpening, removeOpening, findRoom,
} from './model.js';
import { calibrate, deskewAngle, parseMm, formatMm } from './scale.js';
import { snapDrawPoint } from './snap.js';
import { importImage, PLAN_MAX, PHOTO_MAX } from './blob.js';
import { putBlob, blobUrl } from './db.js';
import { wallOf, dist } from './geom.js';
import { renderFloorSvg, floorBounds } from './plan2d.js';
import { createViewport } from './view.js';
import {
  rectFromCorners, setEdgeLength, projectToWall, clampOffset, newOpening, fitOpenings, nextName, OPENING_TYPES,
} from './edit-geom.js';
import { confirmDialog } from './dialog.js';
import { icon } from './icons.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const num = (v) => (Math.round(v * 100) / 100).toString();

const SNAP_PX = 8;   // 吸着の許容(画面上の px)

// 文言
const MSG = {
  unsupported: 'この形式は読めません。JPEG か PNG に変換してください',
  samePoint: '2点が同じ位置です',
  badLength: '0 より大きい数値を入力してください',
  badPolygon: '線が交差しているか、面積がありません',
  needScale: '先に縮尺を合わせてください',
  badShape: 'この長さでは部屋の形が成り立たないため、変えませんでした',
};

export const FLOOR_COLORS = [
  ['#c99a66', 'ナチュラル'], ['#dcc09a', '明るい木'], ['#8a5a3a', 'ウォルナット'],
  ['#a59d92', 'グレー'], ['#c6bf86', '畳'], ['#ece4d4', '白'],
];
export const WALL_COLORS = [
  ['#ead9bd', 'ベージュ'], ['#f6f1e8', '白'], ['#d8c5a8', '砂'],
  ['#c9d1bf', 'セージ'], ['#e9d2c4', '桜'], ['#bdb7ad', 'グレー'],
];
const SWINGS = [['in-left', '内開き・左吊り'], ['in-right', '内開き・右吊り'], ['out-left', '外開き・左吊り'], ['out-right', '外開き・右吊り']];

const TOOLS = [
  { id: 'select', label: '選ぶ', icon: 'pointer' },
  { id: 'polygon', label: '部屋を描く', icon: 'polygon', draw: true },
  { id: 'rect', label: '四角で描く', icon: 'square', draw: true },
  { id: 'size', label: '寸法で作る', icon: 'size', draw: true },
  { id: 'opening', label: 'ドア・窓を置く', icon: 'door' },
];

let root = null;
let vp = null;
const $ = (sel) => root.querySelector(sel);
const urls = {};
const loading = new Set();

const ui = {
  tool: 'select',
  draft: [],          // 多角形の角(mm)、四角の1点目
  pts: [],            // 傾き・縮尺の点(画像の px)
  calReady: false,    // 縮尺: 2点がそろい、実寸の入力待ち
  hover: null,
  showImage: true,
  opening: null,      // 選んでいる開口部 { roomId, openingId }
  menu: null,         // 種類の選択 { roomId, wallIndex, offset }
  drag: null,         // ドラッグ中の開口部 { roomId, openingId, offset }
  dim: null,          // 辺の長さの入力 { roomId, wallIndex }
  prevMode: 'house',
  floorKey: '',
  focusName: false,
  msg: { text: '', kind: 'info' },
};

// ---- 入口 ----

export function mountFloorEditor(el) {
  root = el;
  root.innerHTML = frame();
  vp = createViewport($('#fe-stage'), {
    label: '図面と部屋',
    getBounds: () => (floorNow() ? floorBounds(store.house, floorNow().id, { blobUrls: urls, editing: true }) : null),
    render: renderSvg,
    afterRender: drawOverlay,
    canPan: () => ui.tool === 'select' || ui.tool === 'opening' || ui.tool === 'size',
    onTap,
    onDragStart,
    onHover: (p) => { ui.hover = p; if (needsOverlay()) drawOverlay(); },
  });
  $('#fe-stage').insertAdjacentHTML('beforeend', `
    <div class="fe-empty" id="fe-empty" hidden><p>図面の写真を取り込む(ファイルを選ぶ・ここへドラッグ・⌘V で貼り付け)か、<br>「寸法で作る」で部屋を作ります</p></div>
    <div class="fe-menu" id="fe-opening-menu" role="menu" aria-label="置くものの種類" hidden>
      <p class="fe-menu-cap">種類を選ぶ</p>
      ${OPENING_TYPES.map((t) => `<button type="button" role="menuitem" class="fe-menu-item" data-opening-type="${t.id}">${t.label}</button>`).join('')}
      <button type="button" role="menuitem" class="fe-menu-item muted" data-opening-type="">やめる</button>
    </div>
    <div class="fe-dim" id="fe-dim" hidden><label class="sr-only" for="fe-dim-input">辺の長さ(mm)</label><input id="fe-dim-input" type="text" inputmode="decimal" autocomplete="off"><span class="small muted">mm</span></div>`);
  vp.canvas.addEventListener('pointerdown', () => vp.canvas.focus({ preventScroll: true }));
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onFieldKey);
  root.addEventListener('submit', (e) => {   // 寸法で作る
    if (e.target?.id !== 'fe-size-form') return;
    e.preventDefault();
    createBySize();
  });
  $('#fe-dim-input').addEventListener('keydown', onDimKey);
  $('#fe-dim-input').addEventListener('blur', () => closeDim());
  document.addEventListener('keydown', onKey);
  document.addEventListener('paste', onPaste);
  const stage = $('#fe-stage');
  stage.addEventListener('dragover', (e) => { if (active() && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); stage.classList.add('drop'); } });
  stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
  stage.addEventListener('drop', (e) => {
    stage.classList.remove('drop');
    const f = e.dataTransfer?.files?.[0];
    if (!f || !active()) return;
    e.preventDefault();
    importPlan(f);
  });
  store.on('change', () => update());
  store.on('select', () => update());
  store.on('view', () => update());
  update();
}

// 選んだ階の編集に入る(「間取りを編集」)
export function startFloorEdit(floorId = store.sel.floorId) {
  if (!store.house.floors.length) return addFloorAndEdit();
  if (store.mode !== 'floor-edit') ui.prevMode = store.mode;
  if (floorId && floorId !== store.sel.floorId) store.select({ floorId });
  store.setMode('floor-edit');
}

// 編集を終えて、入る前のモードに戻る(「完了」)
export function finishFloorEdit() {
  resetTool();
  ui.opening = null;
  store.setMode(ui.prevMode && ui.prevMode !== 'floor-edit' ? ui.prevMode : 'house');
}

// 階を足して、その階の編集に入る(「階を追加」)。名前は 1階、2階 …
export function addFloorAndEdit() {
  const name = nextName(store.house.floors.map((f) => f.name), '', '階');
  const r = addFloor(store.house, name);
  store.commit(r.house);
  store.select({ floorId: r.floorId });
  if (store.mode !== 'floor-edit') ui.prevMode = store.mode;
  store.setMode('floor-edit');
  setMsg(`${name}を追加しました。図面の写真を取り込みます`, 'ok');
}

// ---- 状態 ----

const active = () => store.mode === 'floor-edit';
const floorNow = () => store.house.floors.find((f) => f.id === store.sel.floorId) ?? null;
const scaleOf = (floor) => floor?.mmPerPx || 1;
const needsScale = (floor) => !!(floor?.image && !floor.mmPerPx);
const roomNow = () => {
  const f = floorNow();
  return f?.rooms.find((r) => r.id === store.sel.roomId) ?? null;
};
const openingNow = () => {
  if (!ui.opening) return null;
  const found = findRoom(store.house, ui.opening.roomId);
  const o = found?.room.openings.find((x) => x.id === ui.opening.openingId);
  return o ? { room: found.room, opening: o } : null;
};
const needsOverlay = () => ['polygon', 'rect', 'calibrate', 'deskew'].includes(ui.tool);

function resetTool() {
  ui.draft = []; ui.pts = []; ui.calReady = false; ui.menu = null; ui.drag = null;
  closeDim();
}

function setTool(tool) {
  const f = floorNow();
  const def = TOOLS.find((t) => t.id === tool);
  if (def?.draw && needsScale(f)) { setMsg(MSG.needScale, 'error'); return; }
  resetTool();
  ui.tool = tool;
  setMsg('', 'info');   // 道具ごとの案内は、道具の下の行に出る
  update();
  if (tool === 'size') $('#fe-size-w')?.focus();
}

function setMsg(text, kind = 'info') {
  ui.msg = { text, kind };
  if (!root) return;
  const el = $('#fe-msg');
  el.className = `fe-msg ${kind}`;
  el.innerHTML = text ? `${kind === 'error' ? icon('warn', 18) : ''}<span>${esc(text)}</span>` : '';
}

// ---- 枠 ----

function frame() {
  const toolBtn = (t) => `<button type="button" class="tool-btn" data-tool="${t.id}" aria-pressed="false"${t.draw ? ' aria-describedby="fe-scale-hint"' : ''}>${icon(t.icon, 18)}<span>${t.label}</span></button>`;
  return `<div class="fe" data-tool="select">
  <header class="fe-head">
    <h2 id="fe-title" class="fe-title">間取りを編集</h2>
    <span id="fe-scale" class="small muted"></span>
    <span class="spacer"></span>
    <div class="fe-group fe-underlay" role="group" aria-label="下絵">
      <label class="fe-range">${icon('image', 18)}<span>下絵の濃さ</span><input type="range" id="fe-opacity" min="0.1" max="1" step="0.05"></label>
      <label class="fe-check"><input type="checkbox" id="fe-show-image" checked><span>下絵を表示</span></label>
    </div>
    <button type="button" id="fe-done-btn" class="pill pill-accent">${icon('check', 18)}<span>完了</span></button>
  </header>
  <div id="fe-tools" class="fe-tools" role="toolbar" aria-label="間取りの道具">
    <div class="fe-group" role="group" aria-label="図面">
      <button type="button" id="fe-import-btn" class="tool-btn">${icon('upload', 18)}<span>図面を取り込む</span></button>
      <input type="file" id="fe-file" accept="image/*" hidden>
      <button type="button" class="tool-btn" data-tool="deskew" aria-pressed="false">${icon('rotate', 18)}<span>傾きを直す</span></button>
      <button type="button" class="tool-btn" data-tool="calibrate" aria-pressed="false">${icon('ruler', 18)}<span>縮尺を合わせる</span></button>
    </div>
    <div class="fe-group" role="group" aria-label="部屋とドア・窓">${TOOLS.map(toolBtn).join('')}</div>
  </div>
  <div id="fe-options" class="fe-options"></div>
  <p id="fe-msg" class="fe-msg info" aria-live="polite" role="status"></p>
  <div class="fe-body">
    <div id="fe-stage" class="fe-stage"></div>
    <aside id="fe-inspector" class="fe-inspector" aria-label="設定"></aside>
  </div>
</div>`;
}

// ---- 描画 ----

function update() {
  if (!root) return;
  root.hidden = !active();
  if (!active()) return;
  const floor = floorNow();
  if (!floor) { root.querySelector('.fe-body').hidden = true; return; }
  root.querySelector('.fe-body').hidden = false;
  if (ui.opening && !openingNow()) ui.opening = null;
  if (floor.image?.hash) ensureUrl(floor.image.hash);
  // 階・図面・縮尺・傾きが変わったら、全体が見えるように合わせ直す
  const key = `${floor.id}|${floor.image?.hash ?? ''}|${floor.mmPerPx ?? ''}|${floor.imageRotationDeg}|${urls[floor.image?.hash] ? 1 : 0}`;
  if (key.split('|')[0] !== ui.floorKey.split('|')[0]) resetTool();
  const refit = key !== ui.floorKey;
  ui.floorKey = key;
  renderHead(floor);
  renderOptions(floor);
  renderInspector(floor);
  if (refit) vp.fit(); else vp.refresh();
  $('#fe-empty').hidden = !!(floor.image || floor.rooms.length);
  renderMenu();
}

function renderHead(floor) {
  $('#fe-title').textContent = `間取りを編集 ・ ${floor.name}`;
  $('#fe-scale').textContent = floor.image
    ? (floor.mmPerPx ? `縮尺 1px = ${fmtScale(floor.mmPerPx)}mm` : '縮尺はまだ合わせていません')
    : '図面なし(寸法で作れます)';
  const ns = needsScale(floor);
  $('.fe').dataset.tool = ui.tool;
  for (const b of root.querySelectorAll('[data-tool]')) {
    const id = b.dataset.tool;
    b.setAttribute('aria-pressed', String(id === ui.tool));
    const def = TOOLS.find((t) => t.id === id);
    b.disabled = (def?.draw && ns) || ((id === 'deskew' || id === 'calibrate') && !floor.image) || (id === 'opening' && !floor.rooms.length);
  }
  const op = $('#fe-opacity');
  if (document.activeElement !== op) op.value = String(floor.imageOpacity ?? 0.5);
  op.disabled = !floor.image;
  $('#fe-show-image').disabled = !floor.image;
  $('#fe-show-image').checked = ui.showImage;
}

const fmtScale = (k) => (k < 1 ? k.toFixed(2) : k.toFixed(1));

function renderOptions(floor) {
  const box = $('#fe-options');
  if (box.contains(document.activeElement)) return;   // 入力中は描き直さない
  let html = '';
  if (needsScale(floor)) html += `<p id="fe-scale-hint" class="fe-hint">${icon('warn', 16)}<span>${MSG.needScale}(部屋を描く前に「縮尺を合わせる」)</span></p>`;
  else html += '<span id="fe-scale-hint" hidden></span>';
  const t = ui.tool;
  if (t === 'deskew') {
    html += `<p class="fe-step">${ui.pts.length ? '2点目をクリック' : '壁の線の1点目をクリック'} ・ 今の傾き ${num(floor.imageRotationDeg || 0)}度</p>
      <button type="button" class="pill pill-ghost-inline" data-act="rot-left">${icon('rotateLeft', 18)}<span>左に90度</span></button>
      <button type="button" class="pill pill-ghost-inline" data-act="rot-right">${icon('rotate', 18)}<span>右に90度</span></button>`;
  } else if (t === 'calibrate') {
    if (ui.calReady) {
      html += `<label class="fe-field">2点の間の実寸 <input type="text" id="fe-cal-input" inputmode="decimal" autocomplete="off" placeholder="例 5400"> mm</label>
        <button type="button" id="fe-cal-apply" class="pill pill-accent">合わせる</button>
        <button type="button" class="pill pill-ghost-inline" data-act="cal-reset">点を打ち直す</button>`;
    } else {
      html += `<p class="fe-step">${ui.pts.length ? '2点目をクリック' : '長さの分かる2点の、1点目をクリック'}(拡大すると正確に打てます)</p>`;
    }
  } else if (t === 'polygon') {
    html += `<p class="fe-step">角を順にクリック ・ 最初の角をクリックか Enter で確定 ・ Backspace で1点戻す ・ Esc で中止(${ui.draft.length}点)</p>
      <button type="button" class="pill pill-accent" data-act="poly-close"${ui.draft.length >= 3 ? '' : ' disabled'}>確定</button>
      <button type="button" class="pill pill-ghost-inline" data-act="poly-back"${ui.draft.length ? '' : ' disabled'}>1点戻す</button>
      <button type="button" class="pill pill-ghost-inline" data-act="poly-cancel"${ui.draft.length ? '' : ' disabled'}>中止</button>`;
  } else if (t === 'rect') {
    html += `<p class="fe-step">${ui.draft.length ? 'もう一方の角をクリック(Esc で中止)' : '部屋の角を1つクリック'}</p>`;
  } else if (t === 'size') {
    html += `<form class="fe-size" id="fe-size-form">
      <label class="fe-field">幅 <input type="text" id="fe-size-w" inputmode="decimal" autocomplete="off" placeholder="3600"> mm</label>
      <span aria-hidden="true">×</span>
      <label class="fe-field">奥行 <input type="text" id="fe-size-d" inputmode="decimal" autocomplete="off" placeholder="2700"> mm</label>
      <button type="submit" class="pill pill-accent">部屋を作る</button></form>`;
  } else if (t === 'opening') {
    html += '<p class="fe-step">壁をクリックして種類を選びます ・ 置いたものは壁に沿ってドラッグで動かせます</p>';
  } else {
    html += '<p class="fe-step muted">部屋やドアを押すと右に設定が出ます ・ ドラッグで移動、ホイールで拡大・縮小</p>';
  }
  box.innerHTML = html;
}

function renderSvg({ viewBox, size }) {
  const floor = floorNow();
  if (!floor) return '';
  let house = store.house;
  if (ui.drag) house = updateOpening(house, ui.drag.roomId, ui.drag.openingId, { offset: ui.drag.offset });
  return renderFloorSvg(house, floor.id, {
    blobUrls: urls, showImage: ui.showImage, size, viewBox, editing: true, wallHits: true, showDims: true,
    highlightRoomId: ui.opening ? null : store.sel.roomId, selectedOpeningId: ui.opening?.openingId ?? null,
  });
}

// 描きかけの線・点、縮尺の点などを重ねる
function drawOverlay(svg = vp.canvas.querySelector('svg')) {
  if (!svg) return;
  svg.querySelector('.fe-overlay')?.remove();
  const floor = floorNow();
  if (!floor) return;
  const u = vp.unit;
  const k = scaleOf(floor);
  const pt = (p, cls, r = 4) => `<circle class="${cls}" cx="${num(p.x)}" cy="${num(p.y)}" r="${num(u * r)}" stroke-width="${num(u * 1.5)}"/>`;
  const line = (a, b, cls) => `<line class="${cls}" x1="${num(a.x)}" y1="${num(a.y)}" x2="${num(b.x)}" y2="${num(b.y)}" stroke-width="${num(u * 2)}"/>`;
  const label = (a, b) => {
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return `<text class="draft-len" x="${num(m.x + u * 6)}" y="${num(m.y - u * 6)}" font-size="${num(u * 12)}">${formatMm(dist(a, b))}</text>`;
  };
  let out = '';
  const hover = ui.hover;
  if (ui.tool === 'polygon' && ui.draft.length) {
    const s = hover ? snapPoint(hover) : null;
    const pts = s ? [...ui.draft, s] : ui.draft;
    out += `<polyline class="draft-line" points="${pts.map((p) => `${num(p.x)},${num(p.y)}`).join(' ')}" stroke-width="${num(u * 2)}"/>`;
    if (s) out += label(ui.draft[ui.draft.length - 1], s);
    ui.draft.forEach((p, i) => { out += pt(p, i === 0 ? 'draft-point first' : 'draft-point', i === 0 ? 5 : 4); });
    if (s?.snapped) out += pt(s, 'snap-mark', 7);
  } else if (ui.tool === 'polygon' && hover) {
    const s = snapPoint(hover);
    if (s.snapped) out += pt(s, 'snap-mark', 7);
  } else if (ui.tool === 'rect' && ui.draft.length && hover) {
    const s = snapPoint(hover, false);
    const r = rectFromCorners(ui.draft[0], s);
    out += `<polygon class="draft-line" points="${r.map((p) => `${num(p.x)},${num(p.y)}`).join(' ')}" stroke-width="${num(u * 2)}"/>`;
    out += label(r[0], r[1]) + label(r[1], r[2]);
    out += pt(ui.draft[0], 'draft-point');
  } else if (ui.tool === 'rect' && ui.draft.length) {
    out += pt(ui.draft[0], 'draft-point');
  } else if ((ui.tool === 'calibrate' || ui.tool === 'deskew') && ui.pts.length) {
    const ps = ui.pts.map((p) => ({ x: p.x * k, y: p.y * k }));
    const end = ps[1] ?? hover;
    if (end) out += line(ps[0], end, 'cal-line');
    ps.forEach((p) => { out += pt(p, 'cal-point', 5); });
  }
  if (!out) return;
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'fe-overlay');
  g.innerHTML = out;
  svg.append(g);
}

// 吸着: 既存の角と描きかけの角、1つ前の点と水平・垂直。許容は画面上 8px
function snapPoint(p, withPrev = true) {
  const floor = floorNow();
  const vertices = [...floor.rooms.flatMap((r) => r.polygon), ...ui.draft];
  const prev = withPrev && ui.draft.length ? ui.draft[ui.draft.length - 1] : null;
  return snapDrawPoint(p, { prev, vertices, tolerance: SNAP_PX * vp.unit });
}

function ensureUrl(hash) {
  if (urls[hash] || loading.has(hash)) return;
  loading.add(hash);
  blobUrl(hash).then((u) => { if (u) { urls[hash] = u; update(); } }).catch(() => {}).finally(() => loading.delete(hash));
}

// ---- 右の設定 ----

function renderInspector(floor) {
  const box = $('#fe-inspector');
  const focusId = box.contains(document.activeElement) ? document.activeElement.id : null;
  const sel = openingNow();
  const room = roomNow();
  if (sel) box.innerHTML = openingPanel(sel.room, sel.opening);
  else if (room) box.innerHTML = roomPanel(room);
  else box.innerHTML = floorPanel(floor);
  if (ui.focusName && room) {
    ui.focusName = false;
    const input = $('#fe-room-name');
    input?.focus();
    input?.select();
  } else if (focusId) {
    document.getElementById(focusId)?.focus();
  }
}

const field = (id, label, value, unit = 'mm', attrs = '') => `<label class="fe-prop" for="${id}"><span>${label}</span>
  <span class="fe-prop-in"><input type="text" id="${id}" value="${esc(value)}" inputmode="decimal" autocomplete="off"${attrs}>${unit ? `<span class="small muted">${unit}</span>` : ''}</span></label>`;

function floorPanel(floor) {
  return `<h3 class="fe-cap">階</h3>
    <label class="fe-prop" for="fe-floor-name"><span>名前</span><input type="text" id="fe-floor-name" value="${esc(floor.name)}" autocomplete="off"></label>
    <dl class="fe-facts">
      <dt>図面</dt><dd>${floor.image ? `${floor.image.width}×${floor.image.height}px` : 'なし'}</dd>
      <dt>縮尺</dt><dd>${floor.image ? (floor.mmPerPx ? `1px = ${fmtScale(floor.mmPerPx)}mm` : 'まだ') : '—'}</dd>
      <dt>傾き</dt><dd>${floor.image ? `${num(floor.imageRotationDeg || 0)}度` : '—'}</dd>
      <dt>部屋</dt><dd>${floor.rooms.length}</dd>
    </dl>
    <ol class="fe-steps small">
      <li>図面の写真を取り込む</li><li>傾きを直す</li><li>縮尺を合わせる</li><li>部屋を描く</li><li>ドア・窓を置く</li>
    </ol>
    <hr class="fe-sep">
    <button type="button" class="pill pill-danger-outline" id="fe-floor-del">${icon('trash', 18)}<span>この階を削除</span></button>`;
}

function swatches(name, list, current) {
  return `<div class="fe-swatches" role="group" aria-label="${name}">${list.map(([c, label]) => `<button type="button" class="fe-swatch" data-color-kind="${name === '床の色' ? 'floor' : 'wall'}" data-color="${c}" aria-pressed="${c === current}" aria-label="${name}: ${label}" title="${label}" style="--sw:${c}"></button>`).join('')}</div>`;
}

function roomPanel(room) {
  const edges = room.polygon.map((_, i) => wallOf(room.polygon, i));
  const photos = room.photos.map((h) => {
    if (!urls[h]) ensureUrl(h);
    return `<li class="fe-photo">${urls[h] ? `<img src="${esc(urls[h])}" alt="部屋の写真">` : '<span class="fe-photo-wait"></span>'}<button type="button" class="icon-btn fe-photo-del" data-photo="${esc(h)}" aria-label="この写真を外す">${icon('close', 16)}</button></li>`;
  }).join('');
  return `<h3 class="fe-cap">部屋</h3>
    <label class="fe-prop" for="fe-room-name"><span>名前</span><input type="text" id="fe-room-name" value="${esc(room.name)}" autocomplete="off"></label>
    ${field('fe-ceiling', '天井の高さ', formatMm(room.ceilingHeight))}
    <p class="fe-label">床の色</p>${swatches('床の色', FLOOR_COLORS, room.floorColor)}
    <p class="fe-label">壁の色</p>${swatches('壁の色', WALL_COLORS, room.wallColor)}
    <p class="fe-label">辺の長さ</p>
    <div class="fe-edges">${edges.map((e, i) => field(`fe-edge-${i}`, `辺${i + 1}`, formatMm(e.length), 'mm', ` data-edge="${i}"`)).join('')}</div>
    <p class="fe-label">部屋の写真</p>
    ${photos ? `<ul class="fe-photos">${photos}</ul>` : ''}
    <button type="button" class="pill pill-outline" id="fe-photo-btn">${icon('plus', 18)}<span>写真を追加</span></button>
    <input type="file" id="fe-photo-file" accept="image/*" multiple hidden>
    <hr class="fe-sep">
    <button type="button" class="pill pill-danger-outline" id="fe-room-del">${icon('trash', 18)}<span>この部屋を削除</span></button>`;
}

function openingPanel(room, o) {
  const label = OPENING_TYPES.find((t) => t.id === o.type)?.label ?? '開口部';
  return `<h3 class="fe-cap">${esc(label)} ・ ${esc(room.name)}</h3>
    <label class="fe-prop" for="fe-op-type"><span>種類</span><select id="fe-op-type">${OPENING_TYPES.map((t) => `<option value="${t.id}"${t.id === o.type ? ' selected' : ''}>${t.label}</option>`).join('')}</select></label>
    ${field('fe-op-width', '幅', formatMm(o.width))}
    ${field('fe-op-height', '高さ', formatMm(o.height))}
    ${field('fe-op-sill', '床からの高さ', formatMm(o.sill))}
    ${o.type === 'door' ? `<label class="fe-prop" for="fe-op-swing"><span>開き方</span><select id="fe-op-swing">${SWINGS.map(([v, l]) => `<option value="${v}"${v === o.swing ? ' selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
    <p class="small muted">壁に沿ってドラッグで位置を変えられます</p>
    <button type="button" class="pill pill-outline" id="fe-op-back">部屋の設定へ</button>
    <hr class="fe-sep">
    <button type="button" class="pill pill-danger-outline" id="fe-op-del">${icon('trash', 18)}<span>削除</span></button>`;
}

function renderMenu() {
  const m = $('#fe-opening-menu');
  if (!ui.menu) { m.hidden = true; return; }
  m.hidden = false;
  const stage = $('#fe-stage').getBoundingClientRect();
  const c = vp.toClient(ui.menu.at);
  m.style.left = `${Math.min(stage.width - 170, Math.max(8, c.x - stage.left + 12))}px`;
  m.style.top = `${Math.min(stage.height - 230, Math.max(8, c.y - stage.top + 12))}px`;
}

// ---- 図面の取り込み ----

async function importPlan(file) {
  const floor = floorNow();
  if (!floor) return;
  setMsg('図面を読み込んでいます…', 'info');
  // 先に読めるかを確かめる(読めないファイルでは何も聞かず、何も変えない)
  const r = await importImage(file, PLAN_MAX);
  if (!r.ok) { setMsg(MSG.unsupported, 'error'); return; }
  if (floor.rooms.length && !(await confirmDialog({
    title: '図面を差し替えますか',
    message: 'すでに描いた部屋は、新しい図面と位置が合わなくなることがあります。縮尺は合わせ直しになります。',
    ok: '差し替える',
  }))) { setMsg('', 'info'); return; }
  try {
    await putBlob(r);
    const u = await blobUrl(r.hash);
    if (u) urls[r.hash] = u;
  } catch (e) {
    console.warn('図面を保存できませんでした', e);
    setMsg('図面を保存できませんでした。空き容量を確かめてください', 'error');
    return;
  }
  if (!store.house.floors.some((f) => f.id === floor.id)) return;
  resetTool();
  ui.tool = 'select';
  store.commit(updateFloor(store.house, floor.id, { image: { hash: r.hash, width: r.width, height: r.height }, mmPerPx: null, imageRotationDeg: 0 }));
  setMsg('図面を取り込みました。傾いていれば「傾きを直す」、次に「縮尺を合わせる」', 'ok');
}

function onPaste(e) {
  if (!active() || e.defaultPrevented) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
  const files = [...(e.clipboardData?.files ?? [])];
  const file = files.find((f) => f.type.startsWith('image/')) ?? files[0];
  if (!file) return;
  e.preventDefault();
  importPlan(file);
}

// ---- 図面の傾き・縮尺 ----

// 部屋があるときに図面の傾きや縮尺を変えるなら確かめる
async function confirmImageChange() {
  const floor = floorNow();
  if (!floor?.rooms.length) return true;
  return confirmDialog({
    title: '図面を変えますか',
    message: 'すでに描いた部屋は動かないため、図面と位置が合わなくなります。傾きと縮尺は、部屋を描く前に合わせるのがおすすめです。',
    ok: '変える',
  });
}

async function applyRotation(deg) {
  const floor = floorNow();
  let r = ((deg % 360) + 360) % 360;
  if (r > 180) r -= 360;
  if (Math.abs(r) < 1e-9) r = 0;
  if (!(await confirmImageChange())) return;
  store.commit(updateFloor(store.house, floor.id, { imageRotationDeg: r }));
  setMsg(`図面の傾きを ${num(r)}度 にしました`, 'ok');
}

function tapImagePoint(p) {
  const floor = floorNow();
  const k = scaleOf(floor);
  const px = { x: p.x / k, y: p.y / k };
  if (ui.tool === 'calibrate' && ui.calReady) { ui.pts = []; ui.calReady = false; }
  ui.pts.push(px);
  if (ui.pts.length < 2) { setMsg('2点目をクリックしてください', 'info'); update(); return; }
  const [a, b] = ui.pts;
  if (dist(a, b) < 1e-9) {
    ui.pts = [];
    setMsg(MSG.samePoint, 'error');
    update();
    return;
  }
  if (ui.tool === 'deskew') {
    const delta = deskewAngle(a, b);
    ui.pts = [];
    update();
    applyRotation((floor.imageRotationDeg || 0) + delta);
    return;
  }
  ui.calReady = true;
  setMsg('2点の間の実寸(mm)を入力してください', 'info');
  update();
  $('#fe-cal-input')?.focus();
}

async function applyCalibration() {
  const floor = floorNow();
  const input = $('#fe-cal-input');
  if (!floor || !input || ui.pts.length < 2) return;
  const mm = parseMm(input.value);
  const r = calibrate(ui.pts[0], ui.pts[1], mm ?? NaN);
  if (!r.ok) {
    setMsg(r.reason === 'same-point' ? MSG.samePoint : MSG.badLength, 'error');
    input.focus();
    input.select();
    return;
  }
  if (!(await confirmImageChange())) return;
  ui.pts = []; ui.calReady = false; ui.tool = 'select';
  $('#fe-options').innerHTML = '';
  store.commit(updateFloor(store.house, floor.id, { mmPerPx: r.mmPerPx }));
  setMsg(`縮尺を合わせました: 1px = ${fmtScale(r.mmPerPx)}mm。次は「部屋を描く」`, 'ok');
  vp.canvas.focus({ preventScroll: true });
}

// ---- 部屋を描く ----

function createRoom(polygon) {
  const floor = floorNow();
  const name = nextName(floor.rooms.map((r) => r.name), '部屋', '');
  const r = addRoom(store.house, floor.id, { name, polygon });
  if (!r.ok) {
    setMsg(r.reason === 'no-scale' ? MSG.needScale : MSG.badPolygon, 'error');
    return false;
  }
  ui.draft = [];
  ui.focusName = true;
  ui.opening = null;
  store.commit(r.house);
  store.select({ roomId: r.roomId });
  if (ui.focusName) update();
  setMsg(`${name}を作りました。名前を入力できます`, 'ok');
  return true;
}

function closePolygon() {
  if (ui.draft.length < 3) { setMsg(MSG.badPolygon, 'error'); return; }
  if (!createRoom(ui.draft)) drawOverlay();
}

function tapDraw(p) {
  if (ui.tool === 'polygon') {
    const s = snapPoint(p);
    if (ui.draft.length >= 3 && dist(s, ui.draft[0]) <= SNAP_PX * vp.unit) { closePolygon(); return; }
    const last = ui.draft[ui.draft.length - 1];
    if (last && dist(s, last) < 1e-9) return;
    ui.draft.push({ x: s.x, y: s.y });
    renderOptions(floorNow());
    drawOverlay();
  } else if (ui.tool === 'rect') {
    const s = snapPoint(p, false);
    if (!ui.draft.length) { ui.draft = [{ x: s.x, y: s.y }]; renderOptions(floorNow()); drawOverlay(); return; }
    const poly = rectFromCorners(ui.draft[0], s);
    if (!createRoom(poly)) { ui.draft = []; drawOverlay(); }
  }
}

function createBySize() {
  const w = parseMm($('#fe-size-w').value), d = parseMm($('#fe-size-d').value);
  if (!w || !d) { setMsg(MSG.badLength, 'error'); (w ? $('#fe-size-d') : $('#fe-size-w')).focus(); return; }
  const floor = floorNow();
  // 既存の部屋の右隣に置く(なければ原点)
  const all = floor.rooms.flatMap((r) => r.polygon);
  const x = all.length ? Math.max(...all.map((p) => p.x)) : 0;
  const y = all.length ? Math.min(...all.map((p) => p.y)) : 0;
  createRoom(rectFromCorners({ x, y }, { x: x + w, y: y + d }));
}

// ---- 辺の長さ ----

function applyEdge(roomId, i, text) {
  const found = findRoom(store.house, roomId);
  if (!found) return false;
  const len = parseMm(text);
  if (len == null) { setMsg(MSG.badLength, 'error'); return false; }
  const r = setEdgeLength(found.room.polygon, i, len);
  if (!r.ok) { setMsg(MSG.badShape, 'error'); return 'reject'; }
  store.commit(updateRoom(store.house, roomId, { polygon: r.polygon, openings: fitOpenings(found.room.openings, r.polygon) }));
  setMsg(`辺${i + 1}を ${formatMm(len)}mm にしました`, 'ok');
  return true;
}

function openDim(target) {
  const g = target.closest('[data-room-id]');
  if (!g) return;
  const found = findRoom(store.house, g.dataset.roomId);
  if (!found) return;
  const i = Number(target.dataset.wallIndex);
  ui.dim = { roomId: found.room.id, wallIndex: i };
  const box = $('#fe-dim');
  const stage = $('#fe-stage').getBoundingClientRect();
  const r = target.getBoundingClientRect();
  box.hidden = false;
  box.style.left = `${r.left + r.width / 2 - stage.left}px`;
  box.style.top = `${r.top + r.height / 2 - stage.top}px`;
  const input = $('#fe-dim-input');
  input.value = formatMm(wallOf(found.room.polygon, i).length);
  input.focus();
  input.select();
}

function closeDim() {
  ui.dim = null;
  if (root) $('#fe-dim').hidden = true;
}

function onDimKey(e) {
  if (e.isComposing) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDim(); vp.canvas.focus({ preventScroll: true }); return; }
  if (e.key !== 'Enter' || !ui.dim) return;
  e.preventDefault();
  const r = applyEdge(ui.dim.roomId, ui.dim.wallIndex, e.target.value);
  if (r === false) { e.target.select(); return; }
  closeDim();
  vp.canvas.focus({ preventScroll: true });
}

// ---- ドア・窓 ----

function wallTarget(e) {
  const hit = e.target.closest?.('.wall-hit');
  const g = hit?.closest('[data-room-id]');
  return hit && g ? { roomId: g.dataset.roomId, wallIndex: Number(hit.dataset.wallIndex) } : null;
}

function placeOpening(type) {
  const m = ui.menu;
  ui.menu = null;
  if (!type || !m) { renderMenu(); return; }
  const found = findRoom(store.house, m.roomId);
  if (!found) return;
  const len = wallOf(found.room.polygon, m.wallIndex).length;
  const next = addOpening(store.house, m.roomId, newOpening(type, m.wallIndex, m.offset, len));
  const room = findRoom(next, m.roomId).room;
  const o = room.openings[room.openings.length - 1];
  ui.opening = { roomId: m.roomId, openingId: o.id };
  store.commit(next);
  store.select({ roomId: m.roomId });
  const label = OPENING_TYPES.find((t) => t.id === type).label;
  setMsg(`${label}を置きました。壁に沿ってドラッグで動かせます`, 'ok');
  vp.canvas.focus({ preventScroll: true });
}

function onDragStart(e) {
  if (ui.tool !== 'select' && ui.tool !== 'opening') return null;
  const g = e.target.closest?.('[data-opening-id]');
  const roomG = g?.closest('[data-room-id]');
  if (!g || !roomG) return null;
  const found = findRoom(store.house, roomG.dataset.roomId);
  const o = found?.room.openings.find((x) => x.id === g.dataset.openingId);
  if (!o) return null;
  const start = o.offset;
  let raf = 0;
  const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; vp.refresh(); }); };
  ui.menu = null;
  renderMenu();
  return {
    move(p) {
      const len = wallOf(found.room.polygon, o.wallIndex).length;
      const offset = clampOffset(len, o.width, projectToWall(found.room.polygon, o.wallIndex, p).offset);
      ui.drag = { roomId: found.room.id, openingId: o.id, offset };
      redraw();
    },
    end() {
      const d = ui.drag;
      ui.drag = null;
      cancelAnimationFrame(raf); raf = 0;
      ui.opening = { roomId: found.room.id, openingId: o.id };
      if (d && Math.abs(d.offset - start) > 1e-9) store.commit(updateOpening(store.house, found.room.id, o.id, { offset: d.offset }));
      if (store.sel.roomId !== found.room.id) store.select({ roomId: found.room.id });
      else update();
    },
    cancel() { ui.drag = null; cancelAnimationFrame(raf); raf = 0; vp.refresh(); },
  };
}

// ---- 図の上の操作 ----

function onTap(e, p) {
  if (!active()) return;
  const t = ui.tool;
  const busy = (t === 'polygon' || t === 'rect') && ui.draft.length;
  const dimText = e.target.closest?.('text.dim');
  if (dimText && !busy && t !== 'calibrate' && t !== 'deskew') { openDim(dimText); return; }
  if (t === 'calibrate' || t === 'deskew') { tapImagePoint(p); return; }
  if (t === 'polygon' || t === 'rect') { tapDraw(p); return; }
  const og = e.target.closest?.('[data-opening-id]');
  const rg = e.target.closest?.('[data-room-id]');
  if (t === 'opening') {
    const w = wallTarget(e);
    if (w && !og) {
      const found = findRoom(store.house, w.roomId);
      ui.menu = { ...w, offset: projectToWall(found.room.polygon, w.wallIndex, p).offset, at: p };
      renderMenu();
      $('#fe-opening-menu [data-opening-type]')?.focus();
      return;
    }
  }
  ui.menu = null;
  renderMenu();
  if (og && rg) {
    ui.opening = { roomId: rg.dataset.roomId, openingId: og.dataset.openingId };
    if (store.sel.roomId !== rg.dataset.roomId) store.select({ roomId: rg.dataset.roomId }); else update();
    return;
  }
  ui.opening = null;
  if (rg) {
    if (store.sel.roomId !== rg.dataset.roomId) store.select({ roomId: rg.dataset.roomId }); else update();
  } else if (store.sel.roomId) {
    store.select({ roomId: null, floorId: floorNow().id });
  } else update();
}

// ---- ボタン・入力 ----

async function onClick(e) {
  const b = e.target.closest('button');
  if (!b || !root.contains(b)) return;
  if (b.id === 'fe-done-btn') return finishFloorEdit();
  if (b.id === 'fe-import-btn') return $('#fe-file').click();
  if (b.dataset.tool) return setTool(b.dataset.tool);
  if (b.hasAttribute('data-opening-type')) return placeOpening(b.dataset.openingType);
  if (b.id === 'fe-cal-apply') return applyCalibration();
  const floor = floorNow();
  const act = b.dataset.act;
  if (act === 'rot-left') return applyRotation((floor.imageRotationDeg || 0) - 90);
  if (act === 'rot-right') return applyRotation((floor.imageRotationDeg || 0) + 90);
  if (act === 'cal-reset') { ui.pts = []; ui.calReady = false; return update(); }
  if (act === 'poly-close') return closePolygon();
  if (act === 'poly-back') { ui.draft.pop(); renderOptions(floor); return drawOverlay(); }
  if (act === 'poly-cancel') { ui.draft = []; renderOptions(floor); return drawOverlay(); }
  if (b.id === 'fe-floor-del' && floor) return deleteFloor(floor);
  const room = roomNow();
  if (b.dataset.colorKind && room) {
    const key = b.dataset.colorKind === 'floor' ? 'floorColor' : 'wallColor';
    return store.commit(updateRoom(store.house, room.id, { [key]: b.dataset.color }));
  }
  if (b.id === 'fe-photo-btn') return $('#fe-photo-file').click();
  if (b.dataset.photo && room) return store.commit(updateRoom(store.house, room.id, { photos: room.photos.filter((h) => h !== b.dataset.photo) }));
  if (b.id === 'fe-room-del' && room) {
    const ok = await confirmDialog({
      title: '部屋を削除しますか',
      message: `「${room.name}」と、その部屋のドア・窓・家具の配置を削除します。取り消し(⌘Z)で戻せます。`,
      ok: '削除する', danger: true,
    });
    if (ok) { store.commit(removeRoom(store.house, room.id)); setMsg(`${room.name}を削除しました`, 'ok'); }
    return;
  }
  const sel = openingNow();
  if (b.id === 'fe-op-back') { ui.opening = null; return update(); }
  if (b.id === 'fe-op-del' && sel) {
    ui.opening = null;
    store.commit(removeOpening(store.house, sel.room.id, sel.opening.id));
    setMsg('削除しました(⌘Z で戻せます)', 'ok');
  }
}

// 階を削除する(部屋・ドア・窓・家具の配置ごと)。1手で取り消せる。そのあとは隣の階、なければ家全体の案内へ
async function deleteFloor(floor) {
  const placements = floor.rooms.reduce((s, r) => s + r.plans.reduce((t, p) => t + p.placements.length, 0), 0);
  const ok = await confirmDialog({
    title: '階を削除しますか',
    message: `「${floor.name}」を削除します(部屋 ${floor.rooms.length}・家具の配置 ${placements} も消えます。家具台帳の家具は残ります)。取り消し(⌘Z)で戻せます。`,
    ok: '削除する', danger: true,
  });
  if (!ok) return;
  const floors = store.house.floors;
  const i = floors.findIndex((f) => f.id === floor.id);
  if (i < 0) return;
  const next = floors[i + 1] ?? floors[i - 1] ?? null;
  resetTool();
  ui.opening = null;
  store.commit(removeFloor(store.house, floor.id));
  if (next) {
    store.select({ floorId: next.id });
    setMsg(`${floor.name}を削除しました(⌘Z で戻せます)`, 'ok');
    document.getElementById('fe-floor-name')?.focus();
  } else {
    finishFloorEdit();
    store.setMode('house');
    document.querySelector('#house-empty [data-action="add-floor"]')?.focus();
  }
}

async function onChange(e) {
  const t = e.target;
  const floor = floorNow();
  if (!floor) return;
  if (t.id === 'fe-file') {
    const f = t.files?.[0];
    t.value = '';
    if (f) await importPlan(f);
    return;
  }
  if (t.id === 'fe-photo-file') {
    const files = [...(t.files ?? [])];
    t.value = '';
    return addPhotos(files);
  }
  if (t.id === 'fe-opacity') return store.commit(updateFloor(store.house, floor.id, { imageOpacity: Number(t.value) }));
  if (t.id === 'fe-show-image') { ui.showImage = t.checked; return vp.refresh(); }
  if (t.id === 'fe-floor-name') {
    const name = t.value.trim();
    if (name && name !== floor.name) store.commit(updateFloor(store.house, floor.id, { name }));
    else t.value = floor.name;
    return;
  }
  const room = roomNow();
  if (t.id === 'fe-room-name' && room) {
    const name = t.value.trim();
    if (name && name !== room.name) store.commit(updateRoom(store.house, room.id, { name }));
    else t.value = room.name;
    return;
  }
  if (t.id === 'fe-ceiling' && room) {
    const v = parseMm(t.value);
    if (v == null) { setMsg(MSG.badLength, 'error'); t.value = formatMm(room.ceilingHeight); return; }
    if (v !== room.ceilingHeight) store.commit(updateRoom(store.house, room.id, { ceilingHeight: v }));
    return;
  }
  if (t.dataset.edge != null && room) {
    if (applyEdge(room.id, Number(t.dataset.edge), t.value) !== true) t.value = formatMm(wallOf(room.polygon, Number(t.dataset.edge)).length);
    return;
  }
  const sel = openingNow();
  if (!sel) return;
  const { room: r, opening: o } = sel;
  const len = wallOf(r.polygon, o.wallIndex).length;
  if (t.id === 'fe-op-type') {
    store.commit(updateOpening(store.house, r.id, o.id, { type: t.value }));
  } else if (t.id === 'fe-op-swing') {
    store.commit(updateOpening(store.house, r.id, o.id, { swing: t.value }));
  } else if (t.id === 'fe-op-width' || t.id === 'fe-op-height' || t.id === 'fe-op-sill') {
    const zeroOk = t.id === 'fe-op-sill' && /^\s*[0０]\s*$/.test(t.value);
    const v = zeroOk ? 0 : parseMm(t.value);
    const key = { 'fe-op-width': 'width', 'fe-op-height': 'height', 'fe-op-sill': 'sill' }[t.id];
    if (v == null) { setMsg(MSG.badLength, 'error'); t.value = formatMm(o[key]); return; }
    const patch = { [key]: v };
    if (key === 'width') {
      if (v > len) setMsg(`壁の長さ(${formatMm(len)}mm)に合わせました`, 'info');
      patch.width = Math.min(v, len);
      patch.offset = clampOffset(len, patch.width, o.offset);
    }
    store.commit(updateOpening(store.house, r.id, o.id, patch));
  }
}

function onInput(e) {
  // 下絵の濃さは、動かしている間は見た目だけ変える(確定は change で1手)
  if (e.target.id === 'fe-opacity') vp.canvas.querySelector('.floor-image')?.setAttribute('opacity', e.target.value);
}

function onFieldKey(e) {
  const t = e.target;
  if (e.isComposing || e.key !== 'Enter') return;
  if (t.id === 'fe-cal-input') { e.preventDefault(); applyCalibration(); return; }
  if (t.closest?.('#fe-size-form')) return;
  if (t.tagName === 'INPUT' && t.type === 'text' && t.closest('#fe-inspector')) { e.preventDefault(); t.blur(); }
}

async function addPhotos(files) {
  const room = roomNow();
  if (!room || !files.length) return;
  const hashes = [];
  for (const f of files) {
    const r = await importImage(f, PHOTO_MAX);
    if (!r.ok) { setMsg(MSG.unsupported, 'error'); continue; }
    await putBlob(r);
    hashes.push(r.hash);
  }
  const now = findRoom(store.house, room.id)?.room;
  if (!now || !hashes.length) return;
  store.commit(updateRoom(store.house, room.id, { photos: [...now.photos, ...hashes.filter((h) => !now.photos.includes(h))] }));
  setMsg(`写真を${hashes.length}枚追加しました`, 'ok');
}


// ---- キー ----

function onKey(e) {
  if (!active() || e.defaultPrevented || e.isComposing) return;
  if (document.querySelector('dialog[open]')) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'Escape') {
    if (ui.menu) { ui.menu = null; renderMenu(); vp.canvas.focus({ preventScroll: true }); }
    else if (ui.draft.length || ui.pts.length) { ui.draft = []; ui.pts = []; ui.calReady = false; update(); }
    else if (ui.opening) { ui.opening = null; update(); }
    else if (ui.tool !== 'select') setTool('select');
    else return;
    e.preventDefault();
    return;
  }
  if (t && t.tagName === 'BUTTON' && (k === 'Enter' || k === ' ')) return;   // ボタンの操作を優先
  if (ui.tool === 'polygon' && k === 'Enter') { e.preventDefault(); closePolygon(); return; }
  if (ui.tool === 'polygon' && k === 'Backspace' && ui.draft.length) {
    e.preventDefault();
    ui.draft.pop();
    renderOptions(floorNow());
    drawOverlay();
    return;
  }
  if ((k === 'Backspace' || k === 'Delete') && openingNow()) {
    e.preventDefault();
    const { room, opening } = openingNow();
    ui.opening = null;
    store.commit(removeOpening(store.house, room.id, opening.id));
    setMsg('削除しました(⌘Z で戻せます)', 'ok');
  }
}
