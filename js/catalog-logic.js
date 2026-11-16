// 家具台帳の計算(純粋): 入力の確かめ、表示の文字、絞り込み。DOM に触れない
import { KINDS } from './shapes.js';
import { parseMm } from './scale.js';

export const STATUSES = [
  { id: 'owned', label: '手持ち' },
  { id: 'considering', label: '検討中' },
  { id: 'fixed', label: '備え付け' },
];
export const DEFAULT_COLOR = '#7a4a2b';

export const MSG = {
  name: '名前を入力してください',
  size: '0 より大きい数値を入力してください',
  price: '0 以上の整数(円)で入力してください',
  url: 'http:// か https:// で始まるアドレスを入力してください',
  unsupported: 'この形式は読めません。JPEG か PNG に変換してください',
};

export const statusLabel = (id) => (STATUSES.find((s) => s.id === id) ?? STATUSES[0]).label;
export const kindLabel = (id) => (KINDS.find((k) => k.id === id) ?? KINDS[0]).label;

// 全角の数字・記号を半角に
const half = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 価格(円)。空は null。"29,800"・"¥29800"・全角数字を受ける。0 以上の整数だけ
export function parsePrice(text) {
  const s = half(String(text ?? '')).replace(/[,，\s]/g, '').replace(/^[¥￥]/, '').replace(/円$/, '');
  if (s === '') return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false };
  return { ok: true, value: Number(s) };
}

export function formatPrice(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return '¥' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 商品ページの URL。空は ''。http: と https: だけ
export function checkUrl(text) {
  const s = String(text ?? '').trim();
  if (s === '') return { ok: true, value: '' };
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return { ok: true, value: s };
  } catch { /* 誤りとして扱う */ }
  return { ok: false };
}

// フォームの文字の値 → { ok, errors: { 欄: 文 }(画面の上から順), data: 家具の値 }
export function validateFurniture(v) {
  const errors = {};
  const name = String(v.name ?? '').trim();
  if (!name) errors.name = MSG.name;
  const size = {};
  for (const k of ['width', 'depth', 'height']) {
    size[k] = parseMm(String(v[k] ?? ''));
    if (size[k] === null) errors[k] = MSG.size;
  }
  const price = parsePrice(v.price);
  if (!price.ok) errors.price = MSG.price;
  const url = checkUrl(v.url);
  if (!url.ok) errors.url = MSG.url;
  const ok = Object.keys(errors).length === 0;
  if (!ok) return { ok, errors, data: null };
  return {
    ok,
    errors,
    data: {
      name,
      kind: KINDS.some((k) => k.id === v.kind) ? v.kind : 'box',
      width: size.width,
      depth: size.depth,
      height: size.height,
      status: STATUSES.some((s) => s.id === v.status) ? v.status : 'owned',
      price: price.value,
      url: url.value,
      memo: String(v.memo ?? ''),
      color: /^#[0-9a-fA-F]{6}$/.test(v.color ?? '') ? v.color.toLowerCase() : DEFAULT_COLOR,
    },
  };
}

// furnitureUsage の結果 → ['LDK(現状)', '寝室(案A)']
export const usageLabels = (usage) => usage.map((u) => `${u.roomName}(${u.planName})`);

export function deleteMessage(usage) {
  if (!usage.length) return 'この家具を台帳から削除します。取り消しで戻せます';
  return `${usageLabels(usage).join('、')}に置かれています。配置も消えます`;
}

// その家具が置かれている部屋の id(どの案でも)
export function roomsOf(house, furnitureId) {
  const out = new Set();
  for (const floor of house.floors) for (const room of floor.rooms) {
    if (room.plans.some((p) => p.placements.some((pl) => pl.furnitureId === furnitureId))) out.add(room.id);
  }
  return out;
}

const norm = (s) => String(s ?? '').normalize('NFKC').trim().toLowerCase();

// 絞り込み(AND)。status / kind / roomId は '' か省略で「すべて」。roomId '__none' はどこにも置いていない家具
export function filterFurniture(house, { status = '', kind = '', roomId = '', q = '' } = {}) {
  const query = norm(q);
  return house.furniture.filter((f) => {
    if (status && f.status !== status) return false;
    if (kind && f.kind !== kind) return false;
    if (roomId) {
      const rooms = roomsOf(house, f.id);
      if (roomId === '__none' ? rooms.size > 0 : !rooms.has(roomId)) return false;
    }
    if (query && !norm(f.name).includes(query)) return false;
    return true;
  });
}
