// IndexedDB への保存。DB 'madori'、ストア: 'doc'(キー 'house')、'blobs'(キー hash、値 {type, bytes})、'settings'
const DB_NAME = 'madori';
const DB_VERSION = 1;
let dbPromise = null;
const urls = new Map(); // hash → blob: URL(再利用する)
const recentPuts = new Map(); // hash → 保存した時刻(画像の掃除で、まだ家に付けていない画像を消さないため)

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function connect() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of ['doc', 'blobs', 'settings']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    r.onsuccess = () => {
      const db = r.result;
      // 別のタブが版を上げるときは閉じて、次の呼び出しで開き直す
      db.onversionchange = () => { db.close(); dbPromise = null; };
      res(db);
    };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('db-blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await connect();
  const t = db.transaction(store, mode);
  const result = fn(t.objectStore(store));
  const value = result instanceof IDBRequest ? req(result) : Promise.resolve(result);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); });
  return value;
}

// ブラウザがデータを消さないように頼んだ結果。true: 認められた、false: 断られた、null: 確かめられない
export let persistGranted = null;
let persistAsked = false;

export async function openDb() {
  await connect();
  if (!persistAsked) {
    persistAsked = true;
    try {
      const st = navigator.storage;
      if (st?.persist) persistGranted = (await st.persisted?.()) || (await st.persist());
    } catch { /* 永続化を断られても続ける */ }
  }
}

export async function loadHouse() {
  return (await tx('doc', 'readonly', s => s.get('house'))) ?? null;
}

// 保存データが、このタブが読んだ(最後に保存した)ものから変わっていたときのエラー(別のタブが書いた)
export class ConflictError extends Error {
  constructor() { super('conflict'); this.name = 'ConflictError'; }
}

// 家を保存する。expect を渡すと、同じトランザクションで保存済みの家の updatedAt を読み、
// expect と違えば(別のタブが書いた)上書きせず ConflictError を投げる。expect: 文字列か null(保存データなし)
export async function saveHouse(house, { expect } = {}) {
  if (expect === undefined) { await tx('doc', 'readwrite', s => s.put(house, 'house')); return; }
  const db = await connect();
  const t = db.transaction('doc', 'readwrite');
  const s = t.objectStore('doc');
  let conflict = false;
  const r = s.get('house');
  r.onsuccess = () => {
    if ((r.result?.updatedAt ?? null) !== expect) { conflict = true; t.abort(); return; }
    s.put(house, 'house');
  };
  await new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(conflict ? new ConflictError() : (t.error || new Error('aborted')));
  });
}

export async function putBlob({ hash, type, bytes }) {
  recentPuts.set(hash, Date.now());
  await tx('blobs', 'readwrite', s => s.put({ type, bytes }, hash));
}

// このページで最近(既定 10分以内)保存した画像のハッシュ
export function recentBlobHashes(withinMs = 10 * 60 * 1000) {
  const since = Date.now() - withinMs;
  return [...recentPuts].filter(([, t]) => t >= since).map(([h]) => h);
}

export async function getBlob(hash) {
  const v = await tx('blobs', 'readonly', s => s.get(hash));
  return v ? { type: v.type, bytes: v.bytes } : null;
}

export async function listBlobHashes() {
  return (await tx('blobs', 'readonly', s => s.getAllKeys())).map(String);
}

export async function deleteBlobs(hashes) {
  if (!hashes.length) return;
  await tx('blobs', 'readwrite', s => { for (const h of hashes) s.delete(h); });
  // 作った blob: URL は取り消さない。画面の部品が URL を覚えていて、同じ画像が読み込み・復元で戻ったときに
  // 取り消し済みの URL で表示が壊れるため。名前は内容のハッシュなので、古い URL でも同じ画像が出る
}

export async function getSetting(key) {
  return tx('settings', 'readonly', s => s.get(key));
}

export async function setSetting(key, value) {
  await tx('settings', 'readwrite', s => s.put(value, key));
}

export async function blobUrl(hash) {
  if (urls.has(hash)) return urls.get(hash);
  const b = await getBlob(hash);
  if (!b) return null;
  if (urls.has(hash)) return urls.get(hash); // 待つ間に別の呼び出しが作っていればそれを使う
  const u = URL.createObjectURL(new Blob([b.bytes], { type: b.type }));
  urls.set(hash, u);
  return u;
}
