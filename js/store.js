// 画面全体の状態(現在の家・選択・表示・履歴・保存)。モジュールに1つだけの store を使う。
// 通知: 'change'(家が変わった)、'select'(選択が変わった)、'view'(表示・モードが変わった)、
//       'save'(保存の状態 saveError・stopped が変わった)
import * as db from './db.js';
import { createHouse, normalize, findRoom } from './model.js';
import { createHistory } from './history.js';

const SAVE_DELAY = 300;
const EMPTY_SEL = { floorId: null, roomId: null, planId: null, placementId: null, furnitureId: null };
const VIEWS = ['split', 'plan', '3d'];
const MODES = ['house', 'room', 'floor-edit', 'catalog', 'settings'];

const listeners = new Map();
const history = createHistory(50);
let saveTimer = null;
let dirty = false;
let saving = Promise.resolve();
// 保存データの updatedAt のうち、このタブが読んだ・最後に保存したもの(別のタブの保存を上書きしないため)。
// undefined: 確かめない(読み込みに失敗したあと、利用者がバックアップなどで置き換えるとき)
let baseStamp = undefined;
const stampOf = (h) => h?.updatedAt ?? null;

function emit(event, detail) {
  for (const fn of listeners.get(event) ?? []) {
    try { fn(detail); } catch (e) { console.error(e); }
  }
}

const currentPlanId = (room) => (room.plans.find((p) => p.isCurrent) ?? room.plans[0])?.id ?? null;

// 選択を家の中身に合わせる(消えた部屋・案・配置・家具を外し、部屋から階と案を補う)
function fixSel(house, sel) {
  const s = { ...EMPTY_SEL, ...sel };
  const found = s.roomId ? findRoom(house, s.roomId) : null;
  if (!found) { s.roomId = null; s.planId = null; s.placementId = null; }
  else {
    s.floorId = found.floor.id;
    const plan = found.room.plans.find((p) => p.id === s.planId);
    if (!plan) s.planId = currentPlanId(found.room);
    const p = found.room.plans.find((x) => x.id === s.planId);
    if (s.placementId && !p.placements.some((pl) => pl.id === s.placementId)) s.placementId = null;
  }
  if (!house.floors.some((f) => f.id === s.floorId)) s.floorId = house.floors[0]?.id ?? null;
  if (s.furnitureId && !house.furniture.some((f) => f.id === s.furnitureId)) s.furnitureId = null;
  return s;
}

// 'house'(家全体)と 'room'(部屋の編集)は、部屋を選んでいるかどうかで決まる。ほかのモードはそのまま
const modeFor = (mode, sel) => (mode === 'house' && sel.roomId ? 'room' : mode === 'room' && !sel.roomId ? 'house' : mode);

const sameSel = (a, b) => Object.keys(EMPTY_SEL).every((k) => a[k] === b[k]);

function writeNow() {
  if (!dirty || store.loadError || store.stopped) return saving;
  dirty = false;
  const house = store.house;
  saving = saving.then(() => {
    if (store.stopped) return;
    return db.saveHouse(house, { expect: baseStamp }).then(
      () => {
        baseStamp = stampOf(house);
        if (store.saveError) { store.saveError = null; emit('save'); }
      },
      (e) => {
        // 別のタブが新しい家を保存していた: 上書きせず、このタブの保存をやめる
        if (e?.name === 'ConflictError') { store.stopSaving('moved'); return; }
        store.saveError = e; dirty = true; console.warn('保存できませんでした', e);
        emit('save');
      },
    );
  });
  return saving;
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, SAVE_DELAY);
}

export const store = {
  house: createHouse(),
  sel: { ...EMPTY_SEL },
  view: 'split',
  mode: 'house',
  loadError: null,   // 保存されたデータを読めなかったとき。上書きしないよう保存を止める
  saveError: null,   // 最後の保存に失敗した(次の commit で再試行する)
  stopped: null,     // 'moved': 編集が別のタブに移った。このタブはもう保存しない
  hasLock: false,    // このタブが編集の権利(navigator.locks)を持っている。画像の掃除はこのときだけ

  // db から読み、なければ新しい家。読むだけで保存はしない(最初の commit で保存する)
  async init() {
    try {
      await db.openDb();
      const data = await db.loadHouse();
      if (data) this.house = normalize(data);
      baseStamp = stampOf(data);
    } catch (e) {
      this.loadError = e;
      console.warn('保存された家を読めませんでした', e);
    }
    history.clear();
    this.sel = fixSel(this.house, EMPTY_SEL);
    this.mode = modeFor(this.mode, this.sel);
    if (typeof addEventListener === 'function') {
      addEventListener('pagehide', () => { this.flush(); });
      // 閉じる・別のアプリに切り替える前に保存する(pagehide では書き込みの完了を待てないことがある)
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
      }
    }
  },

  // 保存をやめる(編集が別のタブに移った)。待っている保存も捨てる
  stopSaving(reason = 'moved') {
    if (this.stopped) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    dirty = false;
    this.stopped = reason;
    emit('save');
  },

  // 次の保存で、保存データの updatedAt を確かめない(読めなかった保存データを、利用者の確認のうえで置き換える)
  allowOverwrite() { baseStamp = undefined; },

  // 家を差し替える。undoable なら直前の家を履歴に積む。保存は 300ms まとめて行う
  commit(nextHouse, { undoable = true } = {}) {
    if (!nextHouse || nextHouse === this.house) return;
    if (undoable) history.push(this.house);
    apply(nextHouse);
  },

  undo() {
    const prev = history.undo(this.house);
    if (!prev) return false;
    apply(prev);
    return true;
  },

  redo() {
    const next = history.redo(this.house);
    if (!next) return false;
    apply(next);
    return true;
  },

  get canUndo() { return history.canUndo; },
  // 取り消し・やり直しの履歴にある家(画像の掃除で、まだ戻せる状態の画像を残すため)
  historyStates() { return history.states(); },
  // 履歴を空にする(バックアップの読み込み・復元のあと)
  clearHistory() {
    history.clear();
    emit('change', this.house);
  },
  get canRedo() { return history.canRedo; },

  // 選択を変える。roomId を変えたときは階と「現状」の案を補い、配置の選択を外す(patch に書けば優先)
  select(patch = {}) {
    const p = { ...patch };
    if ('roomId' in p && p.roomId !== this.sel.roomId) {
      if (!('planId' in p)) p.planId = null;
      if (!('placementId' in p)) p.placementId = null;
    }
    if ('floorId' in p && p.floorId !== this.sel.floorId && !('roomId' in p)) {
      p.roomId = null; p.planId = null; p.placementId = null;
    }
    const next = fixSel(this.house, { ...this.sel, ...p });
    if (sameSel(next, this.sel)) return;
    this.sel = next;
    const mode = modeFor(this.mode, next);
    const modeChanged = mode !== this.mode;
    this.mode = mode;
    emit('select', this.sel);
    if (modeChanged) emit('view', { view: this.view, mode: this.mode });
  },

  setView(view) {
    if (!VIEWS.includes(view) || view === this.view) return;
    this.view = view;
    emit('view', { view: this.view, mode: this.mode });
  },

  // 'house' と 'room' は選択に合わせて読み替える(部屋を選んでいれば 'room')
  setMode(mode) {
    if (!MODES.includes(mode)) return;
    mode = modeFor(mode, this.sel);
    if (mode === this.mode) return;
    this.mode = mode;
    emit('view', { view: this.view, mode: this.mode });
  },

  // 通知を受ける。戻り値を呼ぶと解除
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },

  // 待っている保存をすぐに行う
  flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    return writeNow();
  },
};

function apply(house) {
  store.house = house;
  const sel = fixSel(house, store.sel);
  const selChanged = !sameSel(sel, store.sel);
  store.sel = sel;
  const mode = modeFor(store.mode, sel);
  const modeChanged = mode !== store.mode;
  store.mode = mode;
  scheduleSave();
  emit('change', house);
  if (selChanged) emit('select', store.sel);
  if (modeChanged) emit('view', { view: store.view, mode: store.mode });
}
