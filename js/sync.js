// 保管場所(madori-sync)との送受信。fetch は差し替えられる(テストでは worker を直接呼ぶ)
// 合言葉はエラーの文・ログに出さない。エラーは SyncError(code)だけを投げる
import { referencedHashes, normalize } from './model.js';

export class SyncError extends Error {
  // code: 'unauthorized'|'forbidden'|'storage_limit'|'network'|'server'
  //       |'missing-local'(count あり)|'empty'(保管場所がまだ空)|'corrupt'(受け取った画像のハッシュが違う)|'unsupported'(新しい版のデータ)
  constructor(code, { status = null, count = null } = {}) {
    super(code);
    this.name = 'SyncError';
    this.code = code;
    this.status = status;
    this.count = count;
  }
}

const MESSAGES = {
  unauthorized: '合言葉が違います。設定を確認してください',
  forbidden: 'この合言葉では書き込めません。編集用の合言葉を設定してください',
  storage_limit: '保管場所の1日の上限に達しました。明日もう一度「スマホに送る」を押してください(続きから送ります)',
  network: '保管場所に接続できません。通信を確認して、もう一度お試しください',
  server: '保管場所が一時的に使えません。しばらくしてからもう一度お試しください',
  empty: '保管場所はまだ空です。先に「スマホに送る」で送ってください',
  corrupt: '受け取った画像が壊れていました。もう一度お試しください',
  unsupported: '保管場所のデータは新しい版のアプリで作られています',
};

export function syncErrorMessage(code, { count } = {}) {
  if (code === 'missing-local') {
    const n = Number.isInteger(count) ? `${count}件` : '一部';
    return `画像 ${n}がこの Mac に見つからないため、送れませんでした。バックアップを読み込むと戻せることがあります`;
  }
  return MESSAGES[code] ?? MESSAGES.server;
}

function codeOf(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'storage_limit';
  // 503(保管場所の一時的な障害)・500 など: しばらくしてから再試行
  return 'server';
}

const PARALLEL = 4;
const MISSING_BATCH = 2000;

async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// items を n 件ずつ並行に処理する。1件でも失敗したら新しく始めず、走っているものを待って最初の失敗を投げる
async function runParallel(items, n, fn) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch (e) { failure ??= e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failure) throw failure;
}

export function createSync({ baseUrl, token, fetch = globalThis.fetch }) {
  const doFetch = fetch;
  const base = String(baseUrl).replace(/\/+$/, '');

  // 通信の失敗は 'network'、HTTP の失敗は状態から code を決める
  async function call(path, { method = 'GET', headers = {}, body, ok = [200] } = {}) {
    let res;
    try {
      res = await doFetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
    } catch (e) {
      throw new SyncError('network');
    }
    if (!ok.includes(res.status)) {
      let error = null;
      try { error = (await res.json())?.error ?? null; } catch { /* 本文が JSON でなくてもよい */ }
      if (res.status === 404 && error === 'empty') throw new SyncError('empty', { status: 404 });
      throw new SyncError(codeOf(res.status), { status: res.status });
    }
    return res;
  }

  const json = async (res) => {
    try { return await res.json(); } catch { throw new SyncError('server', { status: res.status }); }
  };

  const postJson = async (path, data) => json(await call(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }));

  async function missing(hashes) {
    const out = [];
    for (let i = 0; i < hashes.length; i += MISSING_BATCH) {
      const r = await postJson('/blobs/missing', { hashes: hashes.slice(i, i + MISSING_BATCH) });
      if (!Array.isArray(r?.missing)) throw new SyncError('server');
      out.push(...r.missing);
    }
    return out;
  }

  return {
    // 順序: 未保存の画像を問い合わせ → 不足分を PUT(4件ずつ並行)→ すべて成功してから PUT /manifest → prune
    // 途中で失敗したら manifest に触れず SyncError を投げる。prune の失敗だけは送信の失敗にしない(pruneFailed)
    async push(house, getBlob, onProgress = () => {}) {
      const hashes = referencedHashes(house);
      const need = new Set(await missing(hashes));
      const todo = hashes.filter((h) => need.has(h));
      // 送る画像がすべて手元にあるかを、何かを送る前に確かめる
      let lost = 0;
      for (const h of todo) if (!(await getBlob(h))) lost++;
      if (lost) throw new SyncError('missing-local', { count: lost });

      let done = 0;
      onProgress({ done, total: todo.length, phase: 'blobs' });
      await runParallel(todo, PARALLEL, async (hash) => {
        const b = await getBlob(hash);
        if (!b) throw new SyncError('missing-local', { count: 1 });
        await call(`/blob/${hash}`, { method: 'PUT', headers: { 'Content-Type': b.type || 'application/octet-stream' }, body: b.bytes });
        done++;
        onProgress({ done, total: todo.length, phase: 'blobs' });
      });

      onProgress({ done, total: todo.length, phase: 'manifest' });
      const res = await call('/manifest', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(house) });
      const etag = (await json(res))?.etag ?? res.headers.get('ETag');

      onProgress({ done, total: todo.length, phase: 'prune' });
      let deleted = 0;
      let pruneFailed = false;
      try {
        deleted = (await postJson('/blobs/prune', { keep: hashes }))?.deleted ?? 0;
      } catch {
        pruneFailed = true;   // 次の送信で続きを消す
      }
      return { uploaded: todo.length, skipped: hashes.length - todo.length, deleted, etag, pruneFailed };
    },

    // 家のデータを読む。etag が同じなら { changed: false }。house は normalize 済み
    async pull(etag = null) {
      const res = await call('/manifest', { headers: etag ? { 'If-None-Match': etag } : {}, ok: [200, 304] });
      if (res.status === 304) return { changed: false };
      const data = await json(res);
      let house;
      try { house = normalize(data); } catch { throw new SyncError('unsupported'); }
      return { changed: true, house, etag: res.headers.get('ETag') };
    },

    // 画像の本体。内容の SHA-256 が hash と違えば 'corrupt'
    async fetchBlob(hash) {
      const res = await call(`/blob/${hash}`);
      let bytes;
      try { bytes = new Uint8Array(await res.arrayBuffer()); } catch { throw new SyncError('network'); }
      if ((await sha256Hex(bytes)) !== hash) throw new SyncError('corrupt');
      return { type: res.headers.get('Content-Type') || 'application/octet-stream', bytes };
    },

    // 書き込みの権限を確かめる(閲覧用の合言葉なら 'forbidden')
    async checkWrite() {
      await missing([]);
      return true;
    },
  };
}

// スマホ用のリンク。合言葉は # 以降に入れ、サーバーに送られないようにする
export function viewerLink(appUrl, baseUrl, viewToken) {
  return `${appUrl}#s=${encodeURIComponent(baseUrl)}&v=${encodeURIComponent(viewToken)}`;
}

// location.hash('#s=…&v=…' か '#' なし)→ { baseUrl, viewToken } | null
export function readLinkHash(hash) {
  const params = {};
  for (const part of String(hash ?? '').replace(/^#/, '').split('&')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { params[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1)); } catch { return null; }
  }
  if (!params.s || !params.v) return null;
  const u = normalizeSyncUrl(params.s);
  if (!u.ok) return null;
  return { baseUrl: u.url, viewToken: params.v };
}

// 保管場所のアドレスを確かめる。https だけ(テスト用に http://localhost と http://127.0.0.1 は可)。末尾の / を除く
export function normalizeSyncUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, reason: 'invalid' }; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local)) || !u.hostname) return { ok: false, reason: 'protocol' };
  if (u.search || u.hash || u.username || u.password) return { ok: false, reason: 'invalid' };
  return { ok: true, url: `${u.origin}${u.pathname}`.replace(/\/+$/, '') };
}

// バックアップのファイル名: madori-YYYYMMDD-HHmm.madori(その端末の時刻)
export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `madori-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.madori`;
}
