// 3D表示。前半は純粋な計算(Node でテスト)、後半は Three.js の場面(ブラウザだけ)。
// 座標: 平面図(x 右、y 下、mm)→ 3D(X = x/1000、Z = y/1000、Y = 高さ/1000)。真上から −Z を上にして見ると平面図と同じ向き
// Three.js はブラウザで createView3d を呼んだときに読み込む(Node のテストでは読み込まない)
import { shapeParts } from './shapes.js';
import { wallOf } from './geom.js';
import { fitTransform } from './hub.js';
import { getBlob } from './db.js';

// 読めなかった GLB(どの 3D 表示で失敗したものも)。家具のフォームが「読めませんでした」と出すのに使う
const unreadableModels = new Set();
const unreadableListeners = new Set();
export const isUnreadableModel = (hash) => !!hash && unreadableModels.has(hash);
export function onUnreadableModel(fn) { unreadableListeners.add(fn); return () => unreadableListeners.delete(fn); }

export const CEILING_DEFAULT = 2400;
export const EYE_HEIGHT = 1500;
const FADE_OPACITY = 0.15;
const SHARED_OPACITY = 0.3;     // 階全体の3Dで、隣の部屋との境の壁(いつも透かして両側の部屋の中を見せる)
const SHARED_LINE_FADE = 0.75;  // 境の壁の線は濃いめに残す(部屋の区切りが分かるように)
const DOOR_OPACITY = 0.35;      // 開いた戸は半透明(後ろの家具を隠さない)。線は残す
const WALL_INSET = 0.003;       // 壁の面を部屋の内側へ 3mm ずらす(境の壁が2枚重なってもちらつかない)

// ---------------------------------------------------------------- 純粋な部分

// 平面図の点(mm)と高さ(mm)→ 3D の座標(m)
export function toWorld(p, height = 0) {
  return { x: p.x / 1000, y: height / 1000, z: p.y / 1000 };
}

// 平面図の rotationDeg(画面で時計回り)→ three.js の rotation.y(ラジアン)
export function rotationY(deg) {
  return -((deg || 0) * Math.PI) / 180 + 0;
}

// 家具の中の点(x: 幅方向、y: 奥行方向、mm)→ 平面図の点。pl は { x, y, rotationDeg }(geom.rectCorners と同じ回転)
export function localToPlan(p, pl) {
  const a = ((pl.rotationDeg || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: pl.x + p.x * c - p.y * s, y: pl.y + p.x * s + p.y * c };
}

// 各辺の外向きの単位法線(平面図の座標)。多角形の回りの向き(時計・反時計)を見て外側を選ぶ
export function wallNormals(poly) {
  const n = poly.length;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  const o = s >= 0 ? 1 : -1;
  return poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) return { x: 0, y: 0 };
    const t = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    return { x: t.y * o + 0, y: -t.x * o + 0 };
  });
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 開口部をくり抜いた壁の面。from/to は壁の始点からの距離、bottom/top は床からの高さ(mm)
// ドア・引き戸・開口は床から height まで、窓は sill〜sill+height を抜く
export function wallSegments(room) {
  const poly = room.polygon || [];
  const H = room.ceilingHeight > 0 ? room.ceilingHeight : CEILING_DEFAULT;
  const normals = wallNormals(poly);
  return poly.map((_, i) => {
    const { a, b, length: L } = wallOf(poly, i);
    const openings = (room.openings || [])
      .filter((o) => o.wallIndex === i)
      .map((o) => {
        const w = o.width || 0;
        const from = clamp((o.offset || 0) - w / 2, 0, L), to = clamp((o.offset || 0) + w / 2, 0, L);
        const bottom = o.type === 'window' ? clamp(o.sill || 0, 0, H) : 0;
        const top = clamp(bottom + (o.height || 0), 0, H);
        return { id: o.id, type: o.type, from, to, bottom, top, swing: o.swing ?? null, width: to - from };
      })
      .filter((o) => o.to > o.from && o.top > o.bottom)
      .sort((p, q) => p.from - q.from);
    const pieces = [];
    let cursor = 0;
    for (const o of openings) {
      if (o.from > cursor) pieces.push({ from: cursor, to: o.from, bottom: 0, top: H });
      const s = Math.max(o.from, cursor), e = o.to;
      if (e > s) {
        if (o.bottom > 0) pieces.push({ from: s, to: e, bottom: 0, top: o.bottom });
        if (o.top < H) pieces.push({ from: s, to: e, bottom: o.top, top: H });
      }
      cursor = Math.max(cursor, e);
    }
    if (cursor < L) pieces.push({ from: cursor, to: L, bottom: 0, top: H });
    return { wallIndex: i, a, b, length: L, height: H, normal: normals[i], openings, pieces };
  });
}

// 隣り合う部屋の境の壁に shared: true を付ける(階全体の3D用)。
// 同じ線上(5mm 以内)で外向きの法線が逆向き、かつ壁どうしが 1mm より長く重なるもの
const SHARED_TOL = 5;
export function markSharedWalls(walls) {
  const isShared = (w, o) => {
    if (w === o || !w.length || !o.length) return false;
    if (w.normal.x * o.normal.x + w.normal.y * o.normal.y > -0.99) return false;
    const t = { x: (w.b.x - w.a.x) / w.length, y: (w.b.y - w.a.y) / w.length };
    const off = (p) => Math.abs((p.x - w.a.x) * w.normal.x + (p.y - w.a.y) * w.normal.y);
    if (off(o.a) > SHARED_TOL || off(o.b) > SHARED_TOL) return false;
    const along = (p) => (p.x - w.a.x) * t.x + (p.y - w.a.y) * t.y;
    const lo = Math.max(0, Math.min(along(o.a), along(o.b))), hi = Math.min(w.length, Math.max(along(o.a), along(o.b)));
    return hi - lo > 1;
  };
  return walls.map((w) => ({ ...w, shared: walls.some((o) => isShared(w, o)) }));
}

function itemsOf(house, room, plan) {
  if (!plan) return [];
  const byId = new Map(house.furniture.map((f) => [f.id, f]));
  const out = [];
  for (const pl of plan.placements) {
    const f = byId.get(pl.furnitureId);
    if (!f) continue;   // 台帳にない家具(参照切れ)は描かない
    out.push({
      placementId: pl.id,
      furnitureId: f.id,
      roomId: room.id,
      name: f.name,
      x: pl.x, y: pl.y,
      elevation: pl.elevation || 0,
      rotationDeg: pl.rotationDeg || 0,
      width: f.width, depth: f.depth, height: f.height,
      parts: shapeParts(f.kind, f.width, f.depth, f.height),
      color: f.color,
      photoHash: f.photo || null,
      modelHash: f.model?.hash ?? null,
      yawDeg: f.model?.yawDeg ?? 0,
      considering: f.status === 'considering',
    });
  }
  return out;
}

function roomParts(house, room, plan) {
  return {
    floors: [{ roomId: room.id, polygon: room.polygon, color: room.floorColor }],
    walls: wallSegments(room).map((w) => ({ ...w, roomId: room.id, color: room.wallColor })),
    items: itemsOf(house, room, plan),
  };
}

// 描くものの一覧。{ roomId, planId }(planId を省くと「現状」)か { floorId }(階の全部屋と、各部屋の「現状」)
export function sceneSpec(house, opts = {}) {
  const empty = { floors: [], walls: [], items: [] };
  const current = (room) => room.plans.find((p) => p.isCurrent) ?? room.plans[0];
  if (opts.roomId) {
    for (const floor of house.floors) {
      const room = floor.rooms.find((r) => r.id === opts.roomId);
      if (!room) continue;
      const plan = opts.planId ? room.plans.find((p) => p.id === opts.planId) : current(room);
      return roomParts(house, room, plan);
    }
    return empty;
  }
  if (opts.floorId) {
    const floor = house.floors.find((f) => f.id === opts.floorId);
    if (!floor) return empty;
    const out = { floors: [], walls: [], items: [] };
    for (const room of floor.rooms) {
      const r = roomParts(house, room, current(room));
      out.floors.push(...r.floors); out.walls.push(...r.walls); out.items.push(...r.items);
    }
    out.walls = markSharedWalls(out.walls);
    return out;
  }
  return empty;
}

// ---------------------------------------------------------------- 画面(Three.js)

const MSG_NO_WEBGL = 'この端末では3Dを表示できません';
const MSG_EMPTY = '部屋を選ぶと、ここに3Dで表示されます';
// 指で操作する端末(スマホ)では「タップ」と言う
const coarse = () => !!globalThis.matchMedia?.('(pointer: coarse)').matches;
const MSG_PICK_MOUSE = '床をクリックすると、その場所に立って見回せます(平面図でも選べます)';
const MSG_PICK_TOUCH = '床をタップすると、その場所に立って見回せます(平面図でも選べます)';
const MSG_EYE_MOUSE = 'ドラッグで見回します。「俯瞰」で戻ります';
const MSG_EYE_TOUCH = '指でなぞると見回せます。「俯瞰」で戻ります';
const MODES = [['overview', '俯瞰'], ['eye', '人の目線'], ['top', '真上']];
const ANIM_MS = 450;
// 3D の色(style.css の変数。2つ目は変数を読めないときの予備で、style.css と同じ値)。起動時に読む
export const COLOR_VARS = {
  glass: ['--3d-glass', '#cfe2e6'],               // 窓ガラス(半透明で描くので、色は控えめな水色)
  sky: ['--3d-sky', '#fff5e8'],                   // 暖かい空の光
  ground: ['--3d-ground', '#b08a68'],             // 床からの照り返し
  sun: ['--3d-sun', '#fff0db'],                   // 斜め上からの平行光
  fill: ['--3d-fill', '#ffe9d2'],                 // 反対側からの弱い光
  roomFloor: ['--3d-room-floor', '#c99a66'],      // 床の色が無い部屋(家のデータの既定と同じ)
  roomWall: ['--3d-room-wall', '#ead9bd'],        // 壁の色が無い部屋(家のデータの既定と同じ)
  slidingTint: ['--3d-sliding-tint', '#ffffff'],  // 引き戸の板を明るくする色
};
const C = Object.fromEntries(Object.entries(COLOR_VARS).map(([k, [, v]]) => [k, v]));
function readColors() {
  for (const [k, [name, fallback]] of Object.entries(COLOR_VARS)) C[k] = cssVar(name, fallback);
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

const cssVar = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function createView3d(el) {
  readColors();
  let T = null;              // three モジュール
  let renderer, scene, camera, controls, raycaster, root;
  let spec = { floors: [], walls: [], items: [] };
  let opts = { blobUrls: {}, label: '' };
  let pending = false;       // 読み込み中に show された
  let specKey = '';
  let selected = null;
  let mode = 'overview';
  let picking = false;
  let userMoved = false;
  let anim = null;
  let frame = 0;
  let builds = 0;
  let failed = false;
  let disposed = false;
  let selectFn = null;
  let bounds = null;         // { minX, maxX, minZ, maxZ, maxY } m
  let items = new Map();     // placementId → { group, item, size, center, edgeMats, outline }
  let walls = [];            // { mats: [{ mat, base }], mid, normal, meshes }
  let floorMeshes = [];
  let pickables = [];
  let doorMats = [];         // 開き戸の面(テスト用に不透明度を返す)
  let roomFn = null;
  const images = new Map();  // url → Promise<HTMLImageElement>(場面を作り直しても使い回す)
  // 立体モデル(GLB)。ハッシュごとに1回だけ読み、配置ごとに複製する(場面を作り直しても使い回し、dispose で捨てる)
  const models = new Map();      // hash → { scene, bbox }
  const modelLoads = new Map();  // hash → Promise<{ scene, bbox } | null>
  const badModels = new Set();   // 読めなかった GLB(簡易な形のまま)

  // 枠
  el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'v3d';
  wrap.innerHTML = `
    <div class="v3d-tools" role="group" aria-label="3Dの視点">
      ${MODES.map(([m, label]) => `<button type="button" class="pill v3d-btn" data-cam="${m}" aria-pressed="${m === 'overview'}">${label}</button>`).join('')}
    </div>
    <p class="v3d-hint" role="status" aria-live="polite" hidden></p>
    <p class="v3d-msg placeholder" hidden></p>`;
  el.appendChild(wrap);
  const hint = wrap.querySelector('.v3d-hint');
  const msg = wrap.querySelector('.v3d-msg');
  const tools = wrap.querySelector('.v3d-tools');
  tools.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cam]');
    if (b) api.setCamera(b.dataset.cam);
  });

  const showMsg = (text) => { msg.textContent = text || ''; msg.hidden = !text; };

  const ready = (async () => {
    if (!webglAvailable()) throw new Error('no-webgl');
    T = await import('three');
    const { OrbitControls } = await import('../vendor/three/OrbitControls.js');
    if (disposed) return;
    renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = T.SRGBColorSpace;
    const canvas = renderer.domElement;
    canvas.className = 'v3d-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '3D表示');
    wrap.prepend(canvas);

    scene = new T.Scene();
    scene.background = new T.Color(cssVar('--panel', '#f8f0e1'));
    // 暖かい空の光 + 床からの照り返し、斜め上からのやわらかい平行光。影はなし
    scene.add(new T.HemisphereLight(C.sky, C.ground, 2.3));
    const sun = new T.DirectionalLight(C.sun, 1.6);   // 手前右の上から(既定の視点で奥と左の壁を照らす)
    sun.position.set(3, 8, 5);
    scene.add(sun);
    const fill = new T.DirectionalLight(C.fill, 0.5);  // 反対側からの弱い光(右の壁・家具の影側)
    fill.position.set(-5, 4, -3);
    scene.add(fill);
    root = new T.Group();
    scene.add(root);

    camera = new T.PerspectiveCamera(45, 1, 0.05, 200);
    camera.position.set(6, 6, 9);
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = false;   // 移動は床と平行に
    controls.addEventListener('change', onControlsChange);
    controls.addEventListener('start', () => { userMoved = true; anim = null; });
    raycaster = new T.Raycaster();

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    const ro = new ResizeObserver(() => resize());
    ro.observe(wrap);
    api._ro = ro;
    resize();
    applyModeControls();
    if (pending) build();
  })().catch((e) => {
    failed = true;
    tools.hidden = true;
    for (const c of wrap.querySelectorAll('canvas')) c.remove();
    showMsg(MSG_NO_WEBGL);
    if (e?.message !== 'no-webgl') console.warn('3Dを準備できませんでした', e);
  });

  // ---- 描画(変更があったときと、カメラが動いている間だけ)

  let active = true;         // false の間は描かない(画面の外・隠れたタブ)。戻ったら描き直す
  let dirty = false;
  function requestRender() {
    if (!active) { dirty = true; return; }
    if (!renderer || disposed || frame) return;
    frame = requestAnimationFrame(tick);
  }

  function tick(t) {
    frame = 0;
    let more = false;
    if (anim) more = stepAnim(t);
    else if (controls.update()) more = true;
    renderNow();
    if (more) requestRender();
  }

  function renderNow() {
    if (!renderer || !wrap.clientWidth || !wrap.clientHeight) return;
    fadeWalls();
    renderer.render(scene, camera);
  }

  function onControlsChange() {
    // 床の下に潜らない
    if (controls.target.y < 0) controls.target.y = 0;
    if (camera.position.y < 0.1) camera.position.y = 0.1;
    requestRender();
  }

  function resize() {
    if (!renderer) return;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!userMoved && mode === 'overview' && !anim && bounds) placeCamera(overviewPose(), false);
    requestRender();
  }

  // カメラ側(壁の外)にいる壁を透かす。毎フレーム判定する
  function fadeWalls() {
    const cp = camera.position;
    for (const w of walls) {
      const out = w.shared || (cp.x - w.mid.x) * w.normal.x + (cp.z - w.mid.z) * w.normal.z > 0;
      if (w.faded === out) continue;
      w.faded = out;
      for (const { mat, base, lineFade, door } of w.mats) {
        // 境の壁の戸は、もともと半透明なのでそれ以上は透かさない
        const k = w.shared ? (door ? 1 : lineFade != null ? SHARED_LINE_FADE : SHARED_OPACITY) : (lineFade ?? FADE_OPACITY);
        mat.opacity = out ? base * k : base;
        mat.transparent = out || base < 1;
        mat.depthWrite = !out && base >= 1;
      }
      for (const m of w.meshes) m.userData.faded = out;
    }
  }

  // ---- 場面の組み立て

  function disposeObject(obj) {
    obj.traverse((o) => {
      if (!o.userData.glb) o.geometry?.dispose();   // GLB の形は読み込んだ元と共有(元は dispose() で捨てる)
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) {
        if (m.map && !m.userData.glbClone) { m.map.userData.dead = true; m.map.dispose(); }
        m.dispose();
      }
    });
  }

  function clearScene() {
    for (const c of [...root.children]) { root.remove(c); disposeObject(c); }
    items = new Map(); walls = []; floorMeshes = []; pickables = []; doorMats = [];
  }

  const line = (geom, color, opacity = 1) => new T.LineSegments(
    new T.EdgesGeometry(geom, 20),
    new T.LineBasicMaterial({ color, transparent: opacity < 1, opacity }),
  );

  function build() {
    pending = false;
    if (!renderer) return;
    clearScene();
    builds++;
    const ink = new T.Color(cssVar('--wall', '#4a2f1c'));
    const label = opts.label ? `${opts.label} の3D表示` : '3D表示';
    renderer.domElement.setAttribute('aria-label', label);

    // 範囲
    const xs = [], zs = [];
    for (const f of spec.floors) for (const p of f.polygon) { xs.push(p.x / 1000); zs.push(p.y / 1000); }
    const maxY = Math.max(CEILING_DEFAULT, ...spec.walls.map((w) => w.height || 0)) / 1000;
    bounds = xs.length ? { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), maxY } : null;
    showMsg(bounds ? '' : MSG_EMPTY);
    tools.hidden = !bounds;

    // 床
    for (const f of spec.floors) {
      if (!f.polygon || f.polygon.length < 3) continue;
      const shape = new T.Shape(f.polygon.map((p) => new T.Vector2(p.x / 1000, -p.y / 1000)));
      const geom = new T.ShapeGeometry(shape);
      const mesh = new T.Mesh(geom, new T.MeshStandardMaterial({ color: f.color || C.roomFloor, roughness: 0.75, metalness: 0, side: T.DoubleSide }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.userData.kind = 'floor';
      mesh.userData.roomId = f.roomId ?? null;
      root.add(mesh);
      floorMeshes.push(mesh);
      pickables.push(mesh);
      const pts = f.polygon.map((p) => new T.Vector3(p.x / 1000, 0.002, p.y / 1000));
      const outline = new T.LineLoop(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.45 }));
      root.add(outline);
    }

    // 壁(厚さ 0 の面、両面)と開口部
    for (const w of spec.walls) buildWall(w, ink);

    // 家具
    for (const it of spec.items) {
      const obj = buildItemObject(it, ink);
      root.add(obj.group);
      items.set(it.placementId, obj);
    }
    applySelection();

    // 別の部屋になったらカメラを合わせ直す
    const key = JSON.stringify(spec.floors.map((f) => f.polygon));
    if (key !== specKey) {
      specKey = key;
      userMoved = false;
      picking = false;
      mode = 'overview';
      applyModeControls();
      if (bounds) placeCamera(overviewPose(), false);
    }
    requestRender();
  }

  function buildWall(w, ink) {
    const len = w.length / 1000;
    if (!len) return;
    const t = { x: (w.b.x - w.a.x) / w.length, z: (w.b.y - w.a.y) / w.length };
    const n = { x: w.normal.x, z: w.normal.y };
    // k: 部屋の内側へのずれ(m)。壁の面は WALL_INSET だけ内側に置く
    const at = (s, h, k = 0) => new T.Vector3(w.a.x / 1000 + t.x * s - n.x * k, h, w.a.y / 1000 + t.z * s - n.z * k);
    const rotY = Math.atan2(n.x, n.z);   // 面の表(+Z)を外向きに
    const wallMat = new T.MeshStandardMaterial({
      color: w.color || C.roomWall, roughness: 0.92, metalness: 0, side: T.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const edgeColor = new T.Color(w.color || C.roomWall).lerp(ink, 0.55);
    const edgeMat = new T.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.8 });
    const rec = { mats: [{ mat: wallMat, base: 1 }, { mat: edgeMat, base: 0.8, lineFade: 0.4 }], mid: at(len / 2, 0), normal: n, meshes: [], faded: null, shared: !!w.shared };
    for (const p of w.pieces) {
      const pw = (p.to - p.from) / 1000, ph = (p.top - p.bottom) / 1000;
      if (pw <= 0 || ph <= 0) continue;
      const geom = new T.PlaneGeometry(pw, ph);
      const mesh = new T.Mesh(geom, wallMat);
      mesh.position.copy(at((p.from + p.to) / 2000, (p.bottom + p.top) / 2000, WALL_INSET));
      mesh.rotation.y = rotY;
      mesh.userData.kind = 'wall';
      const edges = new T.LineSegments(new T.EdgesGeometry(geom), edgeMat);
      mesh.add(edges);
      root.add(mesh);
      rec.meshes.push(mesh);
      pickables.push(mesh);
    }
    for (const o of w.openings) {
      const ow = (o.to - o.from) / 1000, oh = (o.top - o.bottom) / 1000;
      if (o.type === 'window') {
        const glassMat = new T.MeshStandardMaterial({ color: C.glass, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.32, side: T.DoubleSide, depthWrite: false });
        const pane = new T.Mesh(new T.PlaneGeometry(ow, oh), glassMat);
        pane.position.copy(at((o.from + o.to) / 2000, (o.bottom + o.top) / 2000, WALL_INSET));
        pane.rotation.y = rotY;
        // 窓枠の中の桟(縦1本)
        const mullMat = new T.MeshStandardMaterial({ color: edgeColor, roughness: 0.6 });
        const mull = new T.Mesh(new T.BoxGeometry(0.03, oh, 0.03), mullMat);
        rec.mats.push({ mat: mullMat, base: 1 });
        mull.position.copy(pane.position);
        mull.rotation.y = rotY;
        root.add(pane, mull);
        rec.mats.push({ mat: glassMat, base: 0.32 });
      } else if (o.type === 'door') {
        // 開いた戸(平面図と同じく 90 度開いた状態)。吊り元は swing の left = 壁の始点側
        const swing = String(o.swing || 'in-left');
        const side = swing.startsWith('out') ? -1 : 1;
        const hingeS = swing.endsWith('right') ? o.to / 1000 : o.from / 1000;
        const leafMat = new T.MeshStandardMaterial({
          color: new T.Color(cssVar('--line', '#d8c5a8')).lerp(new T.Color(cssVar('--walnut', '#7a4a2b')), 0.3), roughness: 0.6,
          transparent: true, opacity: DOOR_OPACITY, depthWrite: false,
        });
        rec.mats.push({ mat: leafMat, base: DOOR_OPACITY, door: true });   // 壁が透けるときは戸も透かす
        doorMats.push(leafMat);
        const leaf = new T.Mesh(new T.BoxGeometry(0.035, oh, ow), leafMat);
        const hinge = at(hingeS, oh / 2);
        leaf.position.set(hinge.x - n.x * side * ow / 2, oh / 2, hinge.z - n.z * side * ow / 2);
        leaf.rotation.y = rotY;
        const leafEdges = line(leaf.geometry, ink, 0.5);
        rec.mats.push({ mat: leafEdges.material, base: 0.5, lineFade: 0.4 });
        leaf.add(leafEdges);
        root.add(leaf);
      } else if (o.type === 'sliding') {
        const leafMat = new T.MeshStandardMaterial({ color: new T.Color(cssVar('--walnut', '#7a4a2b')).lerp(new T.Color(C.slidingTint), 0.45), roughness: 0.6, transparent: true, opacity: 0.85 });
        for (const [s0, s1, k] of [[0, 0.55, 0.03], [0.45, 1, -0.03]]) {
          const pw = ow * (s1 - s0);
          const panel = new T.Mesh(new T.BoxGeometry(pw, oh, 0.025), leafMat);
          panel.position.copy(at(o.from / 1000 + ow * (s0 + s1) / 2, oh / 2, k));
          panel.rotation.y = rotY;
          const pe = line(panel.geometry, ink, 0.5);
          rec.mats.push({ mat: pe.material, base: 0.5, lineFade: 0.4 });
          panel.add(pe);
          root.add(panel);
        }
        rec.mats.push({ mat: leafMat, base: 0.85 });
      }
    }
    walls.push(rec);
  }

  // 写真を「色を塗った面に contain で収める」テクスチャ(写真を読み終えたら描き直す)
  function photoTexture(url, color, aspect) {
    const W = aspect >= 1 ? 512 : Math.max(16, Math.round(512 * aspect));
    const H = aspect >= 1 ? Math.max(16, Math.round(512 / aspect)) : 512;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, W, H);
    const tex = new T.CanvasTexture(canvas);
    tex.colorSpace = T.SRGBColorSpace;
    tex.anisotropy = 4;
    loadImage(url).then((img) => {
      if (tex.userData.dead || !img) return;
      const pad = 0.05;
      const s = Math.min((W * (1 - 2 * pad)) / img.naturalWidth, (H * (1 - 2 * pad)) / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      tex.needsUpdate = true;
      requestRender();
    });
    return tex;
  }

  function loadImage(url) {
    if (!images.has(url)) {
      images.set(url, new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      }));
    }
    return images.get(url);
  }

  // 家具1つ分の立体。簡易な形を作り、modelHash があれば GLB を読み終えたところで差し替える
  // (読み込み中・読めないときは簡易な形のまま)
  function buildItemObject(item, ink) {
    const group = new T.Group();
    group.userData.placementId = item.placementId;
    const shape = new T.Group();
    group.add(shape);
    const color = /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : cssVar('--walnut', '#7a4a2b');
    const accent = cssVar('--accent', '#b4532a');
    const considering = !!item.considering;
    const look = (m) => {
      if (considering) { m.transparent = true; m.opacity = 0.45; m.depthWrite = false; }
      m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
      return m;
    };
    const body = look(new T.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0 }));
    const edgeColor = new T.Color(color).lerp(ink, 0.6);
    const edgeMat = considering
      ? new T.LineDashedMaterial({ color: accent, dashSize: 0.05, gapSize: 0.035 })
      : new T.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.85 });

    // 写真を貼る面: 'front' の部品の正面(−y = −Z)。なければ 'top' の部品の上面
    const url = item.photoHash ? opts.blobUrls?.[item.photoHash] : null;
    const frontPart = item.parts.find((p) => p.role === 'front');
    const photoPart = url ? (frontPart ?? item.parts.find((p) => p.role === 'top') ?? null) : null;

    const ext = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const p of item.parts) {
      const geom = new T.BoxGeometry(Math.max(p.w, 1) / 1000, Math.max(p.h, 1) / 1000, Math.max(p.d, 1) / 1000);
      let mat = body;
      if (p === photoPart) {
        const onFront = p === frontPart;
        const tex = photoTexture(url, color, onFront ? p.w / Math.max(p.h, 1) : p.w / Math.max(p.d, 1));
        const photoMat = look(new T.MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0 }));
        mat = [body, body, body, body, body, body];
        mat[onFront ? 5 : 2] = photoMat;   // BoxGeometry の面の順: +X −X +Y −Y +Z −Z
      }
      const mesh = new T.Mesh(geom, mat);
      mesh.position.set(p.x / 1000, (p.z + p.h / 2) / 1000, p.y / 1000);
      mesh.userData.placementId = item.placementId;
      const edges = new T.LineSegments(new T.EdgesGeometry(geom), edgeMat);
      if (considering) edges.computeLineDistances();
      mesh.add(edges);
      shape.add(mesh);
      pickables.push(mesh);
      ext.minX = Math.min(ext.minX, p.x - p.w / 2); ext.maxX = Math.max(ext.maxX, p.x + p.w / 2);
      ext.minY = Math.min(ext.minY, p.y - p.d / 2); ext.maxY = Math.max(ext.maxY, p.y + p.d / 2);
      ext.minZ = Math.min(ext.minZ, p.z); ext.maxZ = Math.max(ext.maxZ, p.z + p.h);
    }
    const size = { w: (ext.maxX - ext.minX) / 1000, d: (ext.maxY - ext.minY) / 1000, h: (ext.maxZ - ext.minZ) / 1000 };
    const center = new T.Vector3((ext.minX + ext.maxX) / 2000, (ext.minZ + ext.maxZ) / 2000, (ext.minY + ext.maxY) / 2000);

    const sel = selectionFrame(size, center, item);
    group.add(sel);

    placeGroup(group, item);
    const obj = { group, item, size, center, bottom: ext.minZ / 1000, sel, edgeMat, edgeColor, shape, glb: false, ink };
    if (item.modelHash && !badModels.has(item.modelHash)) {
      const ready = models.get(item.modelHash);
      if (ready) useModel(obj, ready);
      else {
        loadModel(item.modelHash).then((m) => {
          if (!m || disposed || items.get(item.placementId) !== obj) return;
          useModel(obj, m);
          requestRender();
        });
      }
    }
    return obj;
  }

  // 選んだときの枠(主色): 外形の箱の線と、床の上の薄い面
  function selectionFrame(size, center, item) {
    const accent = cssVar('--accent', '#b4532a');
    const sel = new T.Group();
    const boxGeom = new T.BoxGeometry(size.w + 0.06, size.h + 0.03, size.d + 0.06);
    const outline = new T.LineSegments(new T.EdgesGeometry(boxGeom), new T.LineBasicMaterial({ color: accent }));
    boxGeom.dispose();
    outline.position.copy(center);
    const pad = new T.Mesh(new T.PlaneGeometry(size.w + 0.12, size.d + 0.12), new T.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.22, depthWrite: false }));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(center.x, 0.004 - (item.elevation || 0) / 1000, center.z);
    sel.add(outline, pad);
    sel.visible = false;
    return sel;
  }

  // GLB を読む(ハッシュごとに1回)。まだ端末にない(受け取り中の)ときは null で、次に場面を作るときに読み直す
  function loadModel(hash) {
    if (models.has(hash)) return Promise.resolve(models.get(hash));
    if (badModels.has(hash)) return Promise.resolve(null);
    if (!modelLoads.has(hash)) {
      const job = (async () => {
        const b = await getBlob(hash);
        if (!b) return null;
        const { GLTFLoader } = await import('../vendor/three/GLTFLoader.js');
        const u8 = b.bytes instanceof Uint8Array ? b.bytes : new Uint8Array(b.bytes);
        const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        const gltf = await new Promise((resolve, reject) => {
          try { new GLTFLoader().parse(buf, '', resolve, reject); } catch (e) { reject(e); }
        });
        const scene = gltf.scene;
        scene.updateMatrixWorld(true);
        const box = new T.Box3().setFromObject(scene);
        if (box.isEmpty()) throw new Error('empty-model');
        const m = { scene, bbox: { min: box.min.toArray(), max: box.max.toArray() } };
        if (disposed) { disposeModel(m); return null; }
        models.set(hash, m);
        return m;
      })().catch((e) => {
        badModels.add(hash);
        if (!unreadableModels.has(hash)) {
          unreadableModels.add(hash);
          for (const fn of unreadableListeners) { try { fn(hash); } catch { /* 表示の失敗で読み込みを止めない */ } }
        }
        console.warn('立体モデルを読み込めませんでした。簡易な形で表示します', e?.message ?? e);
        return null;
      }).finally(() => modelLoads.delete(hash));
      modelLoads.set(hash, job);
    }
    return modelLoads.get(hash);
  }

  function disposeModel(m) {
    m.scene.traverse((o) => {
      o.geometry?.dispose();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const mat of ms) {
        for (const v of Object.values(mat)) if (v?.isTexture) v.dispose();
        mat.dispose();
      }
    });
  }

  // 簡易な形を GLB の複製に差し替える。yaw → 寸法に合わせる → 底を床、中心を配置の点に(配置の回転はその上に group で)
  function useModel(obj, m) {
    const { item, group } = obj;
    const q = (((Math.round((item.yawDeg || 0) / 90)) % 4) + 4) % 4;
    const { scale, offset } = fitTransform(m.bbox, item, q * 90);
    const considering = !!item.considering;
    const inner = m.scene.clone(true);   // 形は共有、材質は配置ごとに複製(検討中の半透明のため)
    inner.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.glb = true;
      o.userData.placementId = item.placementId;
      const one = (mat) => {
        const c = mat.clone();
        c.userData.glbClone = true;
        if (considering) { c.transparent = true; c.opacity = 0.45 * (mat.opacity ?? 1); c.depthWrite = false; }
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
    });
    const scaled = new T.Group();
    scaled.scale.set(scale[0], scale[1], scale[2]);
    scaled.add(inner);
    const wrap = new T.Group();
    wrap.rotation.y = rotationY(q * 90);
    wrap.position.set(offset[0], offset[1], offset[2]);
    wrap.add(scaled);
    wrap.updateMatrixWorld(true);
    const box = new T.Box3().setFromObject(wrap);   // 家具の中の座標(m)。実際の形から測る

    // 簡易な形を外す
    group.remove(obj.shape);
    const gone = new Set();
    obj.shape.traverse((o) => gone.add(o));
    pickables = pickables.filter((p) => !gone.has(p));
    disposeObject(obj.shape);

    const holder = new T.Group();
    holder.add(wrap);
    if (considering) {
      // 検討中: 外形の点線(簡易な形と同じ見た目)
      const g = new T.BoxGeometry(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
      const dashed = new T.LineSegments(new T.EdgesGeometry(g), new T.LineDashedMaterial({ color: cssVar('--accent', '#b4532a'), dashSize: 0.05, gapSize: 0.035 }));
      g.dispose();
      dashed.position.copy(box.getCenter(new T.Vector3()));
      dashed.computeLineDistances();
      holder.add(dashed);
    }
    group.add(holder);
    inner.traverse((o) => { if (o.isMesh) pickables.push(o); });

    obj.shape = holder;
    obj.glb = true;
    obj.size = { w: box.max.x - box.min.x, d: box.max.z - box.min.z, h: box.max.y - box.min.y };
    obj.center = box.getCenter(new T.Vector3());
    obj.bottom = box.min.y;
    const visible = obj.sel.visible;
    group.remove(obj.sel);
    disposeObject(obj.sel);
    obj.sel = selectionFrame(obj.size, obj.center, item);
    obj.sel.visible = visible;
    group.add(obj.sel);
  }

  function placeGroup(group, p) {
    group.position.set(p.x / 1000, (p.elevation || 0) / 1000, p.y / 1000);
    group.rotation.y = rotationY(p.rotationDeg);
  }

  function applySelection() {
    for (const [id, o] of items) o.sel.visible = id === selected;
    requestRender();
  }

  // ---- カメラ

  function overviewPose() {
    const b = bounds;
    const c = new T.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    const r = 0.5 * Math.hypot(w, d, b.maxY);
    const vf = (camera.fov * Math.PI) / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
    const dist = (r / Math.sin(Math.min(vf, hf) / 2)) * 0.92;
    const dir = new T.Vector3(0.42, 0.95, 1.05).normalize();   // 手前(平面図の下)のやや右、斜め上から
    const target = c.clone().setY(b.maxY * 0.2);
    // 横長の階を縦長の枠で見るときなどは、球の見積もりでは端が切れる。
    // 範囲の箱の8つの角が枠の 90% に収まるまで少しずつ離す(近づけはしない)
    const cam = camera.clone();
    const corners = [];
    for (const x of [b.minX, b.maxX]) for (const y of [0, b.maxY]) for (const z of [b.minZ, b.maxZ]) corners.push(new T.Vector3(x, y, z));
    const fits = (d) => {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      return corners.every((p) => { const q = p.clone().project(cam); return Math.abs(q.x) <= 0.9 && Math.abs(q.y) <= 0.9; });
    };
    let fitDist = dist;
    for (let i = 0; i < 40 && !fits(fitDist); i++) fitDist *= 1.05;
    return { position: target.clone().addScaledVector(dir, fitDist), target };
  }

  function topPose() {
    const b = bounds;
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    const vf = (camera.fov * Math.PI) / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
    const dist = Math.max(d / 2 / Math.tan(vf / 2), w / 2 / Math.tan(hf / 2)) * 1.12 + b.maxY;
    const target = new T.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    // 真上からわずかに手前(+Z)にずらし、画面の上が −Z(平面図の上)になるようにする
    return { position: target.clone().add(new T.Vector3(0, dist, 0.001)), target };
  }

  function eyePose(pt) {
    const pos = new T.Vector3(pt.x / 1000, EYE_HEIGHT / 1000, pt.y / 1000);
    const b = bounds;
    const look = b ? new T.Vector3((b.minX + b.maxX) / 2 - pos.x, 0, (b.minZ + b.maxZ) / 2 - pos.z) : new T.Vector3(0, 0, -1);
    if (look.length() < 0.3) look.set(0, 0, -1);
    look.normalize();
    // 少し(約 12 度)見下ろす。立った人が部屋を見渡す自然な向き
    const down = (12 * Math.PI) / 180;
    look.multiplyScalar(Math.cos(down)).setY(-Math.sin(down));
    return { position: pos, target: pos.clone().addScaledVector(look, 0.01) };
  }

  function applyModeControls() {
    if (!controls) return;
    const eye = mode === 'eye';
    const fov = eye ? 62 : 45;   // 人の目線は広め(近くの床と家具も入るように)
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    controls.enableZoom = !eye;
    controls.enablePan = !eye;
    controls.rotateSpeed = eye ? -0.35 : 1;   // 人の目線は「景色をつかんで動かす」向き(パノラマ写真と同じ)
    controls.minDistance = eye ? 0 : 0.5;
    controls.maxDistance = eye ? Infinity : 80;
    controls.minPolarAngle = eye ? Math.PI * 0.2 : 0;
    controls.maxPolarAngle = eye ? Math.PI * 0.8 : Math.PI / 2 - 0.06;
    for (const b of tools.querySelectorAll('button[data-cam]')) b.setAttribute('aria-pressed', String(b.dataset.cam === mode || (picking && b.dataset.cam === 'eye')));
    hint.textContent = picking ? (coarse() ? MSG_PICK_TOUCH : MSG_PICK_MOUSE) : eye ? (coarse() ? MSG_EYE_TOUCH : MSG_EYE_MOUSE) : '';
    hint.hidden = !hint.textContent;
    renderer?.domElement.classList.toggle('picking', picking);
  }

  function placeCamera(pose, animate = true) {
    if (!animate || reducedMotion()) {
      anim = null;
      camera.position.copy(pose.position);
      controls.target.copy(pose.target);
      const damp = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = damp;
      requestRender();
      return;
    }
    anim = { from: { p: camera.position.clone(), t: controls.target.clone() }, to: { p: pose.position.clone(), t: pose.target.clone() }, start: null };
    requestRender();
  }

  function stepAnim(now) {
    if (anim.start === null) anim.start = now;
    const k = Math.min(1, (now - anim.start) / ANIM_MS);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(anim.from.p, anim.to.p, e);
    controls.target.lerpVectors(anim.from.t, anim.to.t, e);
    camera.lookAt(controls.target);
    if (k >= 1) {
      const pose = anim.to;
      anim = null;
      placeCamera({ position: pose.p, target: pose.t }, false);
      return false;
    }
    return true;
  }

  // ---- クリック(ドラッグと区別する)

  let down = null;
  function onPointerDown(e) { down = { x: e.clientX, y: e.clientY, button: e.button, t: performance.now() }; }
  function onPointerUp(e) {
    const d = down; down = null;
    if (!d || d.button !== 0 || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 800) return;
    const hit = pick(e.clientX, e.clientY);
    if (picking) {
      if (hit?.floorPoint) api.setCamera('eye', hit.floorPoint);
      return;
    }
    if (hit?.placementId) selectFn?.(hit.placementId);
    else if (!hit || hit.floorPoint) selectFn?.(null);
    // 部屋の床・家具を押した(階全体の3Dでは、その部屋へ入るのに使う)
    const roomId = hit?.roomId ?? (hit?.placementId ? items.get(hit.placementId)?.item.roomId : null);
    if (roomId) roomFn?.(roomId, hit.placementId ?? null);
  }

  function pick(cx, cy) {
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new T.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    // 透けている壁はクリックを妨げない。人の目線の場所選びでは床だけを見る
    const targets = picking ? floorMeshes : pickables.filter((m) => !m.userData.faded);
    for (const h of raycaster.intersectObjects(targets, false)) {
      const o = h.object;
      if (o.userData.placementId) return { placementId: o.userData.placementId };
      if (o.userData.kind === 'floor') return { floorPoint: { x: h.point.x * 1000, y: h.point.z * 1000 }, roomId: o.userData.roomId };
      if (o.userData.kind === 'wall') return { wall: true };
    }
    return null;
  }

  const project = (v) => {
    const r = renderer.domElement.getBoundingClientRect();
    const p = v.clone().project(camera);
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  };

  function readPixel(fx, fy) {
    renderNow();
    const gl = renderer.getContext();
    const x = Math.round((gl.drawingBufferWidth - 1) * fx), y = Math.round((gl.drawingBufferHeight - 1) * (1 - fy));
    const buf = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [buf[0], buf[1], buf[2]];
  }

  const api = {
    show(nextSpec, o = {}) {
      spec = nextSpec || { floors: [], walls: [], items: [] };
      opts = { blobUrls: o.blobUrls || {}, label: o.label || '' };
      if (failed) return;
      if (!renderer) { pending = true; return; }
      build();
    },

    // 'overview' | 'top' | 'eye'(point を省くと、次に床をクリックした点に立つ)
    setCamera(m, point) {
      if (failed) return;
      if (!renderer || !bounds) return;
      if (m === 'eye') {
        if (!point) { picking = true; applyModeControls(); return; }
        picking = false;
        mode = 'eye';
        applyModeControls();
        placeCamera(eyePose(point));
        return;
      }
      picking = false;
      mode = m === 'top' ? 'top' : 'overview';
      userMoved = mode !== 'overview';   // 俯瞰は、枠の大きさが変わったら合わせ直す(利用者が動かすまで)
      applyModeControls();
      placeCamera(mode === 'top' ? topPose() : overviewPose());
    },

    get picking() { return picking; },
    cancelPick() { if (picking) { picking = false; applyModeControls(); } },

    select(placementId) {
      selected = placementId || null;
      if (renderer) applySelection();
    },

    onSelect(fn) { selectFn = fn; },
    // 床か家具をクリックしたときに (roomId, placementId | null) を受ける
    onRoomPick(fn) { roomFn = fn; },

    // 平面図でドラッグ・回転している途中の位置(場面は作り直さず、家具だけ動かす)。null で store の値に戻す
    moveLive(p) {
      if (!renderer) return;
      if (!p) { for (const o of items.values()) placeGroup(o.group, o.item); }
      else {
        const o = items.get(p.placementId);
        if (o) placeGroup(o.group, { ...o.item, x: p.x, y: p.y, rotationDeg: p.rotationDeg ?? o.item.rotationDeg });
      }
      requestRender();
    },

    resize,

    // 描くのを止める・再開する(スマホで 3D が画面の外に出たとき・タブが隠れたとき)
    setActive(on) {
      on = !!on;
      if (on === active) return;
      active = on;
      if (!on && frame) { cancelAnimationFrame(frame); frame = 0; dirty = true; }
      if (on && dirty) { dirty = false; requestRender(); }
    },
    get active() { return active; },

    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      api._ro?.disconnect();
      if (renderer) {
        clearScene();
        for (const m of models.values()) disposeModel(m);
        models.clear();
        controls.dispose();
        renderer.dispose();
      }
      el.innerHTML = '';
    },

    ready,

    // テスト用(m)
    debug() {
      if (!renderer) return { ready: false, failed, meshes: 0, items: [], camera: null };
      root.updateMatrixWorld(true);
      let meshes = 0;
      root.traverse((o) => { if (o.isMesh) meshes++; });
      const out = {
        ready: true,
        builds,
        meshes,
        mode,
        picking,
        selected,
        items: [...items.values()].map((o) => ({
          placementId: o.item.placementId,
          x: o.group.position.x, y: o.group.position.y, z: o.group.position.z,
          rotationY: o.group.rotation.y,
          glb: !!o.glb,
          size: o.size,
          center: { x: o.center.x, y: o.center.y, z: o.center.z },
          bottom: o.bottom ?? 0,
          outline: o.sel.visible,
          translucent: (() => {
            const ms = [];
            o.shape.traverse((m) => { if (m.isMesh) ms.push(...(Array.isArray(m.material) ? m.material : [m.material])); });
            return ms.length > 0 && ms.every((m) => m.transparent && m.opacity < 1);
          })(),
          screen: project(o.group.localToWorld(o.center.clone())),
        })),
        camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        wallOpacity: (fadeWalls(), walls.map((w) => Math.round(w.mats[0].mat.opacity * 100) / 100)),
        sharedWallOpacity: walls.filter((w) => w.shared).map((w) => Math.round(w.mats[0].mat.opacity * 100) / 100),
        doorOpacity: doorMats.map((m) => Math.round(m.opacity * 100) / 100),
        floors: floorMeshes.length,
        memory: { ...renderer.info.memory },
        centerPixel: readPixel(0.5, 0.5),
        background: readPixel(0.003, 0.003),
      };
      // 関数はテストのページ内だけで使う(値として返さない)
      Object.defineProperty(out, 'screenOfWorld', { value: (x, y, z) => project(new T.Vector3(x, y, z)) });
      Object.defineProperty(out, 'screenOfLocal', {
        value: (placementId, lx, ly, h) => {
          const o = items.get(placementId);
          return o ? project(o.group.localToWorld(new T.Vector3(lx / 1000, h / 1000, ly / 1000))) : null;
        },
      });
      return out;
    },
  };
  return api;
}
