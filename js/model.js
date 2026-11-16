// 家のデータの作成・変更・検証・版の移行(純粋)。
// すべての関数は引数を書き換えず、新しい House を返す。
// 規則により何もしないとき(対象がない、不正な形など)は、同じ house をそのまま返す。
import { isSimplePolygon } from './geom.js';
import { OPENING_DEFAULTS } from './edit-geom.js';

export const VERSION = 1;

export function newId() {
  return crypto.randomUUID();
}

const now = () => new Date().toISOString();
const touch = (house, changes) => ({ ...house, ...changes, updatedAt: now() });

// ---- 既定値 ----

function makeFloor(name) {
  return { id: newId(), name, image: null, mmPerPx: null, imageRotationDeg: 0, imageOpacity: 0.5, rooms: [] };
}

function makePlan(name, isCurrent, placements = []) {
  return { id: newId(), name, isCurrent, placements };
}

function makeRoom(name, polygon) {
  return {
    id: newId(), name, polygon: polygon.map(p => ({ x: p.x, y: p.y })),
    ceilingHeight: 2400, floorColor: '#c99a66', wallColor: '#ead9bd',
    openings: [], plans: [makePlan('現状', true)], photos: [],
  };
}

const FURNITURE_DEFAULTS = {
  name: '', kind: 'box', width: 600, depth: 600, height: 700,
  photo: null, color: '#7a4a2b', status: 'owned', price: null, url: '', memo: '', model: null,
};

// ---- 内部の書き換え補助 ----

// 部屋1つを書き換える。fn が同じ room を返したら house も同じまま
function mapRoom(house, roomId, fn) {
  let changed = false;
  const floors = house.floors.map(floor => {
    if (!floor.rooms.some(r => r.id === roomId)) return floor;
    const rooms = floor.rooms.map(r => {
      if (r.id !== roomId) return r;
      const next = fn(r);
      if (next !== r) changed = true;
      return next;
    });
    return changed ? { ...floor, rooms } : floor;
  });
  return changed ? touch(house, { floors }) : house;
}

// すべての配置案を書き換える
function mapPlans(house, fn) {
  let changed = false;
  const floors = house.floors.map(floor => {
    let fChanged = false;
    const rooms = floor.rooms.map(room => {
      let rChanged = false;
      const plans = room.plans.map(plan => {
        const next = fn(plan);
        if (next !== plan) rChanged = true;
        return next;
      });
      if (!rChanged) return room;
      fChanged = true;
      return { ...room, plans };
    });
    if (!fChanged) return floor;
    changed = true;
    return { ...floor, rooms };
  });
  return changed ? touch(house, { floors }) : house;
}

const without = (obj, ...keys) => {
  const o = { ...obj };
  for (const k of keys) delete o[k];
  return o;
};

// ---- 家・階 ----

export function createHouse(name = 'わが家') {
  return { version: VERSION, id: newId(), name, updatedAt: now(), floors: [], furniture: [] };
}

export function addFloor(house, name) {
  const floor = makeFloor(name);
  return { house: touch(house, { floors: [...house.floors, floor] }), floorId: floor.id };
}

export function updateFloor(house, floorId, patch) {
  if (!house.floors.some(f => f.id === floorId)) return house;
  const p = without(patch, 'id', 'rooms');
  return touch(house, { floors: house.floors.map(f => (f.id === floorId ? { ...f, ...p } : f)) });
}

export function removeFloor(house, floorId) {
  if (!house.floors.some(f => f.id === floorId)) return house;
  return touch(house, { floors: house.floors.filter(f => f.id !== floorId) });
}

// ---- 部屋 ----

export function findRoom(house, roomId) {
  for (const floor of house.floors) {
    const room = floor.rooms.find(r => r.id === roomId);
    if (room) return { floor, room };
  }
  return null;
}

export function addRoom(house, floorId, { name, polygon }) {
  const floor = house.floors.find(f => f.id === floorId);
  if (!floor) return { ok: false, reason: 'no-floor' };
  if (!floor.mmPerPx && floor.image) return { ok: false, reason: 'no-scale' };
  if (!Array.isArray(polygon) || !isSimplePolygon(polygon)) return { ok: false, reason: 'bad-polygon' };
  const room = makeRoom(name, polygon);
  const floors = house.floors.map(f => (f.id === floorId ? { ...f, rooms: [...f.rooms, room] } : f));
  return { ok: true, house: touch(house, { floors }), roomId: room.id };
}

export function updateRoom(house, roomId, patch) {
  if ('polygon' in patch && (!Array.isArray(patch.polygon) || !isSimplePolygon(patch.polygon))) return house;
  const p = without(patch, 'id');
  return mapRoom(house, roomId, r => ({ ...r, ...p }));
}

export function removeRoom(house, roomId) {
  if (!findRoom(house, roomId)) return house;
  return touch(house, {
    floors: house.floors.map(f => (f.rooms.some(r => r.id === roomId)
      ? { ...f, rooms: f.rooms.filter(r => r.id !== roomId) } : f)),
  });
}

// ---- 開口部 ----

export function addOpening(house, roomId, fields) {
  const opening = { ...fields, id: newId() };
  return mapRoom(house, roomId, r => ({ ...r, openings: [...r.openings, opening] }));
}

export function updateOpening(house, roomId, openingId, patch) {
  const p = without(patch, 'id');
  return mapRoom(house, roomId, r => (r.openings.some(o => o.id === openingId)
    ? { ...r, openings: r.openings.map(o => (o.id === openingId ? { ...o, ...p } : o)) } : r));
}

export function removeOpening(house, roomId, openingId) {
  return mapRoom(house, roomId, r => (r.openings.some(o => o.id === openingId)
    ? { ...r, openings: r.openings.filter(o => o.id !== openingId) } : r));
}

// ---- 配置案 ----

export function addPlan(house, roomId, name, copyFromPlanId = null) {
  const found = findRoom(house, roomId);
  if (!found) return { house, planId: null };
  const src = copyFromPlanId ? found.room.plans.find(p => p.id === copyFromPlanId) : null;
  const placements = src ? src.placements.map(pl => ({ ...pl, id: newId() })) : [];
  const plan = makePlan(name, false, placements);
  return { house: mapRoom(house, roomId, r => ({ ...r, plans: [...r.plans, plan] })), planId: plan.id };
}

export function setCurrentPlan(house, roomId, planId) {
  return mapRoom(house, roomId, r => {
    if (!r.plans.some(p => p.id === planId)) return r;
    return { ...r, plans: r.plans.map(p => ({ ...p, isCurrent: p.id === planId })) };
  });
}

export function removePlan(house, roomId, planId) {
  return mapRoom(house, roomId, r => {
    const target = r.plans.find(p => p.id === planId);
    if (!target || r.plans.length <= 1) return r;
    let plans = r.plans.filter(p => p.id !== planId);
    if (target.isCurrent) plans = plans.map((p, i) => ({ ...p, isCurrent: i === 0 }));
    return { ...r, plans };
  });
}

// ---- 家具 ----

export function addFurniture(house, fields) {
  const furniture = { ...FURNITURE_DEFAULTS, ...without(fields, 'id'), id: newId() };
  return { house: touch(house, { furniture: [...house.furniture, furniture] }), furnitureId: furniture.id };
}

export function updateFurniture(house, furnitureId, patch) {
  if (!house.furniture.some(f => f.id === furnitureId)) return house;
  const p = without(patch, 'id');
  return touch(house, { furniture: house.furniture.map(f => (f.id === furnitureId ? { ...f, ...p } : f)) });
}

// 家具を台帳から消し、その家具の配置もすべて消す
export function removeFurniture(house, furnitureId) {
  if (!house.furniture.some(f => f.id === furnitureId)) return house;
  const h = mapPlans(house, plan => (plan.placements.some(pl => pl.furnitureId === furnitureId)
    ? { ...plan, placements: plan.placements.filter(pl => pl.furnitureId !== furnitureId) } : plan));
  return touch(h, { furniture: h.furniture.filter(f => f.id !== furnitureId) });
}

// その家具が置かれている案の一覧(案ごとに1件)
export function furnitureUsage(house, furnitureId) {
  const out = [];
  for (const floor of house.floors) {
    for (const room of floor.rooms) {
      for (const plan of room.plans) {
        if (plan.placements.some(pl => pl.furnitureId === furnitureId)) {
          out.push({ floorName: floor.name, roomName: room.name, planName: plan.name, isCurrent: plan.isCurrent });
        }
      }
    }
  }
  return out;
}

// ---- 配置 ----

export function place(house, roomId, planId, furnitureId, { x, y }) {
  const placement = { id: newId(), furnitureId, x, y, rotationDeg: 0, elevation: 0, locked: false };
  const h = mapRoom(house, roomId, r => (r.plans.some(p => p.id === planId)
    ? { ...r, plans: r.plans.map(p => (p.id === planId ? { ...p, placements: [...p.placements, placement] } : p)) }
    : r));
  return h === house ? { house, placementId: null } : { house: h, placementId: placement.id };
}

export function updatePlacement(house, placementId, patch) {
  const p = without(patch, 'id');
  return mapPlans(house, plan => (plan.placements.some(pl => pl.id === placementId)
    ? { ...plan, placements: plan.placements.map(pl => (pl.id === placementId ? { ...pl, ...p } : pl)) } : plan));
}

export function removePlacement(house, placementId) {
  return mapPlans(house, plan => (plan.placements.some(pl => pl.id === placementId)
    ? { ...plan, placements: plan.placements.filter(pl => pl.id !== placementId) } : plan));
}

// ---- 集計 ----

// 案に置かれた「検討中」の家具の価格の合計。配置の数だけ数える(同じ家具を2回置けば2回分)
export function planTotal(house, plan) {
  const byId = new Map(house.furniture.map(f => [f.id, f]));
  let total = 0;
  for (const pl of plan.placements) {
    const f = byId.get(pl.furnitureId);
    if (f && f.status === 'considering') total += f.price ?? 0;
  }
  return total;
}

// 家のデータが参照している画像・立体モデルのハッシュ(重複なし)
export function referencedHashes(house) {
  const set = new Set();
  for (const floor of house.floors) {
    if (floor.image?.hash) set.add(floor.image.hash);
    for (const room of floor.rooms) for (const h of room.photos ?? []) if (h) set.add(h);
  }
  for (const f of house.furniture) {
    if (f.photo) set.add(f.photo);
    if (f.model?.hash) set.add(f.model.hash);
  }
  return [...set];
}

// ---- 版の移行と修復 ----

const arr = v => (Array.isArray(v) ? v : []);
const str = (v, d) => (typeof v === 'string' ? v : d);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function normalizePlans(plans, furnitureIds) {
  let out = arr(plans).map(p => ({
    id: str(p?.id, newId()),
    name: str(p?.name, '案'),
    isCurrent: p?.isCurrent === true,
    placements: arr(p?.placements)
      .filter(pl => pl && furnitureIds.has(pl.furnitureId))
      .map(pl => ({
        ...pl,
        id: str(pl.id, newId()),
        x: num(pl.x, 0), y: num(pl.y, 0),
        rotationDeg: num(pl.rotationDeg, 0),
        elevation: num(pl.elevation, 0),
        locked: pl.locked === true,
      })),
  }));
  if (!out.length) out = [makePlan('現状', true)];
  const first = out.findIndex(p => p.isCurrent);
  const cur = first < 0 ? 0 : first;
  return out.map((p, i) => ({ ...p, isCurrent: i === cur }));
}

// 寸法: 正の有限の数でなければ既定の値
const pos = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const OPENING_KINDS = ['door', 'sliding', 'window', 'gap'];
const SWING_KINDS = ['in-left', 'in-right', 'out-left', 'out-right'];

// 開口部の数値を確かめる。壁の番号が部屋にない(整数でない)ものは描けないので null(取り除く)
function normalizeOpening(o, wallCount) {
  if (!Number.isInteger(o.wallIndex) || o.wallIndex < 0 || o.wallIndex >= wallCount) return null;
  const type = OPENING_KINDS.includes(o.type) ? o.type : 'gap';
  const def = OPENING_DEFAULTS[type];
  return {
    ...o,
    id: str(o.id, newId()),
    type,
    offset: Math.max(0, num(o.offset, 0)),
    width: pos(o.width, def.width),
    height: pos(o.height, def.height),
    sill: num(o.sill, -1) >= 0 ? o.sill : def.sill,
    swing: SWING_KINDS.includes(o.swing) ? o.swing : 'in-left',
  };
}

// 図面の画像: { hash: 文字列, width > 0, height > 0 } でなければ null
const normalizeImage = (img) => (img && typeof img === 'object' && typeof img.hash === 'string' && img.hash
  && pos(img.width, 0) > 0 && pos(img.height, 0) > 0 ? { ...img } : null);

function normalizeRoom(r, furnitureIds) {
  return {
    ...r,
    id: str(r.id, newId()),
    name: str(r.name, '部屋'),
    polygon: r.polygon.map(p => ({ x: p.x, y: p.y })),
    ceilingHeight: num(r.ceilingHeight, 2400),
    floorColor: str(r.floorColor, '#c99a66'),
    wallColor: str(r.wallColor, '#ead9bd'),
    openings: arr(r.openings).filter(o => o && typeof o === 'object').map(o => normalizeOpening(o, r.polygon.length)).filter(Boolean),
    plans: normalizePlans(r.plans, furnitureIds),
    photos: arr(r.photos).filter(h => typeof h === 'string'),
  };
}

const validPolygon = poly => Array.isArray(poly)
  && poly.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
  && isSimplePolygon(poly);

// 読み込んだデータを現在の版にそろえ、壊れた部分を直す。入力は書き換えない
export function normalize(data) {
  if (!data || typeof data !== 'object') throw new Error('家のデータではありません');
  const version = data.version ?? VERSION;   // 版の書かれていない古いデータは版1として読む
  if (version !== VERSION) throw new Error(`未対応の版です: ${data.version}`);

  const furniture = arr(data.furniture)
    .filter(f => f && typeof f === 'object')
    .map(f => ({
      ...FURNITURE_DEFAULTS, ...f, id: str(f.id, newId()),
      width: pos(f.width, FURNITURE_DEFAULTS.width),
      depth: pos(f.depth, FURNITURE_DEFAULTS.depth),
      height: pos(f.height, FURNITURE_DEFAULTS.height),
    }));
  const furnitureIds = new Set(furniture.map(f => f.id));

  const floors = arr(data.floors).filter(f => f && typeof f === 'object').map(f => ({
    ...f,
    id: str(f.id, newId()),
    name: str(f.name, '階'),
    image: normalizeImage(f.image),
    mmPerPx: num(f.mmPerPx, null) > 0 ? f.mmPerPx : null,
    imageRotationDeg: num(f.imageRotationDeg, 0),
    imageOpacity: num(f.imageOpacity, 0.5),
    rooms: arr(f.rooms).filter(r => r && validPolygon(r.polygon)).map(r => normalizeRoom(r, furnitureIds)),
  }));

  return {
    ...data,
    version: VERSION,
    id: str(data.id, newId()),
    name: str(data.name, 'わが家'),
    updatedAt: str(data.updatedAt, now()),
    floors,
    furniture,
  };
}
