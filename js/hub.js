// 立体モデル化(imagegen-hub)。家具の写真を中継役に送り、できた GLB を家具に付ける。
//   純粋な部分(Node でテスト): fitTransform、normalizeHubUrl、hubErrorMessage、createHub(fetch を差し替えられる)
//   ブラウザの部分: preparePhoto(写真を送る形に縮める)、作成中の仕事の一覧(startModelJob・jobState・onJobChange)と残り回数
// 合言葉(hubToken)は中継役への Authorization にだけ使う。画面の文・ログ・家のデータには出さない
import { createImagegenClient, QuotaExhaustedError, ImagegenError } from '../vendor/imagegen-client.js';
import { sha256Hex } from './blob.js';
import { getBlob, putBlob } from './db.js';
import { updateFurniture } from './model.js';

export { QuotaExhaustedError };

export const MSG_HUB = {
  unauthorized: '立体モデル化の合言葉が違います',
  network: '立体モデル化の接続先に届きません',
  failed: '立体モデルを作れませんでした。時間をおいてもう一度お試しください',
  notConfigured: '設定で立体モデル化の接続先を入力してください',
  noPhoto: '写真を入れると使えます',
  savePhoto: '写真を保存すると使えます',
  otherRunning: 'ほかの家具を作成中です',
  running: '立体モデルを作成中…(約1分)',
  keepOpen: '作成中はこのページを開いたままにしてください',
  checking: '残り回数を確認中…',
  quotaUnknown: '残り回数を確認できません',
};
export const remainingText = (n) => `今日の残り ${n}回`;

// 中継役の受け取る画像(worker/src/model3d.js と同じ決まり): png・jpeg・webp の data URL で 4MB まで
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_DATA_URL = 4 * 1024 * 1024;
export const SEND_MAX = 1024;   // 送る写真の長辺(px)

// ---------------------------------------------------------------- 純粋な部分

// モデルの外形 bbox(モデル自身の軸。glTF は y が上、単位はおおむね m)を、yawDeg(90度刻み、平面図で時計回り)だけ回したあと
// 家具の寸法(mm → m)にぴったり合わせる。scale はモデルの軸に対する倍率(回転の前に掛ける)、offset は回したあとに足す移動(m)。
// 合わせたあと: 幅 = x、奥行 = z、高さ = y、底が y = 0、外形の中心が原点
export function fitTransform(bbox, { width, depth, height }, yawDeg = 0) {
  const ext = [0, 1, 2].map((a) => bbox.max[a] - bbox.min[a]);
  const q = (((Math.round((yawDeg || 0) / 90)) % 4) + 4) % 4;
  const swap = q % 2 === 1;
  const W = width / 1000, D = depth / 1000, H = height / 1000;
  const fit = (target, e) => (e > 1e-9 && target > 0 ? target / e : 1);
  const scale = [fit(swap ? D : W, ext[0]), fit(H, ext[1]), fit(swap ? W : D, ext[2])];
  const cx = (scale[0] * (bbox.min[0] + bbox.max[0])) / 2;
  const cz = (scale[2] * (bbox.min[2] + bbox.max[2])) / 2;
  // three.js の rotation.y(= −yaw)で回した中心
  const t = -(q * Math.PI) / 2;
  const c = Math.cos(t), s = Math.sin(t);
  const clean = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
  const offset = [clean(-(cx * c + cz * s)), clean(-scale[1] * bbox.min[1]), clean(-(-cx * s + cz * c))];
  return { scale, offset };
}

// 設定のアドレス: https か、テスト用の http://localhost・127.0.0.1 だけ。末尾の / を除く
export function normalizeHubUrl(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'invalid' }; }
  if (u.username || u.password || u.search || u.hash) return { ok: false, reason: 'invalid' };
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return { ok: false, reason: 'protocol' };
  return { ok: true, url: `${u.origin}${u.pathname}`.replace(/\/+$/, '') };
}

// エラー → 画面の文。枠切れは回復時刻を含む文のまま
export function hubErrorMessage(e) {
  if (e instanceof QuotaExhaustedError) return e.message;
  if (e instanceof ImagegenError && e.status === 401) return MSG_HUB.unauthorized;
  if (e instanceof TypeError) return MSG_HUB.network;
  if (e?.message === 'not-configured') return MSG_HUB.notConfigured;
  return MSG_HUB.failed;
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const dataUrlLength = (type, n) => `data:${type};base64,`.length + Math.ceil(n / 3) * 4;
const isGlb = (b) => b.length >= 12 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46;   // 'glTF'

export function createHub({ baseUrl, token, fetch } = {}) {
  const client = createImagegenClient({ baseUrl, token, ...(fetch ? { fetch } : {}) });
  return {
    async quota() {
      const q = await client.getQuota();
      return { remaining: q.model3d?.remaining ?? 0, resetAt: q.model3d?.resetAt ?? null };
    },
    // photo: { bytes, type }(png・jpeg・webp)→ { hash, type: 'model/gltf-binary', bytes }
    async toModel(photo) {
      const bytes = photo.bytes instanceof Uint8Array ? photo.bytes : new Uint8Array(photo.bytes);
      if (!IMAGE_TYPES.includes(photo.type)) throw new Error('unsupported-image');
      if (dataUrlLength(photo.type, bytes.length) > MAX_IMAGE_DATA_URL) throw new Error('too-large');
      const r = await client.generate3d({ image: `data:${photo.type};base64,${base64(bytes)}` });
      const out = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
      if (!isGlb(out)) throw new Error('not-glb');
      return { hash: await sha256Hex(out), type: 'model/gltf-binary', bytes: out };
    },
  };
}

// ---------------------------------------------------------------- ブラウザの部分

// 保存している写真(WebP、長辺 1600px まで)を、送る形にする: 長辺 1024px まで縮め、
// 透明な部分があれば PNG(透明を残す。生成側の背景の処理がそれを使う)、なければ JPEG(品質 0.9)。
// PNG が中継役の上限を超えるときは白の地に置いて JPEG にする。背景の除去はしない(生成側で行う)
export async function preparePhoto(photo) {
  const bm = await createImageBitmap(new Blob([photo.bytes], { type: photo.type }));
  try {
    const k = Math.min(1, SEND_MAX / Math.max(bm.width, bm.height));
    const w = Math.max(1, Math.round(bm.width * k)), h = Math.max(1, Math.round(bm.height * k));
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(bm, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let alpha = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { alpha = true; break; }
    const encode = async (type, q) => {
      const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type, quality: q }) : await new Promise((r) => canvas.toBlob(r, type, q));
      return { type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) };
    };
    if (alpha) {
      const png = await encode('image/png');
      if (dataUrlLength(png.type, png.bytes.length) <= MAX_IMAGE_DATA_URL) return png;
      g.globalCompositeOperation = 'destination-over';
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
    }
    return encode('image/jpeg', 0.9);
  } finally {
    bm.close?.();
  }
}

// ---- 作成中の仕事と残り回数(モジュールに1つ。フォームを閉じても続く。ページを閉じると止まる) ----

let deps = null;          // { getHouse, commit, getSetting }
const jobs = new Map();   // furnitureId → { status: 'running' } | { status: 'error', message }
let running = null;       // 作成中の furnitureId(同時に1つだけ)
const listeners = new Set();
let quota = { status: 'unknown', remaining: null, resetAt: null, blocked: null, message: '' };
let quotaLoad = null;

// ui-catalog がつなぐ(store と設定の読み出し)
export function connectHub(d) { deps = d; }

function emit() {
  for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } }
}
export function onJobChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const jobState = (furnitureId) => jobs.get(furnitureId) ?? null;
export const runningJob = () => running;

export function hubConfigured() {
  return !!(deps?.getSetting('hubUrl') && deps?.getSetting('hubToken'));
}
const hubOf = () => createHub({ baseUrl: deps.getSetting('hubUrl'), token: deps.getSetting('hubToken') });

// 残り回数: { status: 'unknown'|'loading'|'ok'|'error', remaining, resetAt, blocked(押せない理由の文 | null), message }
export const quotaState = () => quota;

export function refreshQuota() {
  if (!hubConfigured()) return Promise.resolve(quota);
  if (quotaLoad) return quotaLoad;
  if (quota.status !== 'ok') quota = { ...quota, status: 'loading' };
  emit();
  quotaLoad = hubOf().quota().then(
    ({ remaining, resetAt }) => {
      quota = { status: 'ok', remaining, resetAt, blocked: remaining > 0 ? null : new QuotaExhaustedError('model3d', resetAt).message, message: '' };
    },
    (e) => {
      if (e instanceof QuotaExhaustedError) quota = { status: 'ok', remaining: 0, resetAt: e.resetAt, blocked: e.message, message: '' };
      else quota = { status: 'error', remaining: null, resetAt: null, blocked: null, message: hubErrorMessage(e) };
    },
  ).then(() => { quotaLoad = null; emit(); return quota; });
  return quotaLoad;
}

// 設定を変えたとき: 残り回数と、前の失敗の文を忘れる
export function resetHubState() {
  quota = { status: 'unknown', remaining: null, resetAt: null, blocked: null, message: '' };
  for (const [id, j] of jobs) if (j.status !== 'running') jobs.delete(id);
  emit();
}

// 写真から立体モデルを作り、終わったら家具に付ける(その家具がまだあれば)。成功したら true
export async function startModelJob(furnitureId) {
  if (!deps || running) return false;
  const f = deps.getHouse().furniture.find((x) => x.id === furnitureId);
  if (!f?.photo) return false;
  running = furnitureId;
  jobs.set(furnitureId, { status: 'running' });
  emit();
  try {
    if (!hubConfigured()) throw new Error('not-configured');
    const photo = await getBlob(f.photo);
    if (!photo) throw new Error('no-photo');
    const glb = await hubOf().toModel(await preparePhoto(photo));
    if (quota.status === 'ok' && quota.remaining > 0) {
      const remaining = quota.remaining - 1;
      quota = { ...quota, remaining, blocked: remaining > 0 ? null : new QuotaExhaustedError('model3d', quota.resetAt).message };
    }
    const house = deps.getHouse();
    if (house.furniture.some((x) => x.id === furnitureId)) {
      await putBlob(glb);
      deps.commit(updateFurniture(deps.getHouse(), furnitureId, { model: { hash: glb.hash, yawDeg: 0 } }));
    }
    jobs.delete(furnitureId);
    return true;
  } catch (e) {
    if (e instanceof QuotaExhaustedError) quota = { status: 'ok', remaining: 0, resetAt: e.resetAt, blocked: e.message, message: '' };
    jobs.set(furnitureId, { status: 'error', message: hubErrorMessage(e) });
    console.warn('立体モデルを作れませんでした', e?.name ?? 'Error');
    return false;
  } finally {
    running = null;
    emit();
  }
}
