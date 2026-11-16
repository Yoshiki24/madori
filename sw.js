// MADORI の service worker: アプリのファイルを保存し、電波がなくても開けるようにする
//   保存するのは下の一覧(tools/build-sw-list.mjs が作る)だけ。それ以外(保管場所・外部・テスト用のファイル)には触れない
//   一覧のファイルは保存したものを先に使う。新しい版は次に開いたときに切り替わる(pwa.js が知らせる)
// <files> tools/build-sw-list.mjs が書き直す。手で直さない
const VERSION = "9338c6483b23";
const CORE = [
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
  "js/app.js",
  "js/blob.js",
  "js/catalog-logic.js",
  "js/check.js",
  "js/db.js",
  "js/edit-geom.js",
  "js/fcard.js",
  "js/geom.js",
  "js/hub.js",
  "js/icons.js",
  "js/model.js",
  "js/plan2d.js",
  "js/pwa.js",
  "js/scale.js",
  "js/shapes.js",
  "js/sync.js",
  "js/ui-viewer.js",
  "js/view.js",
  "js/view3d.js",
  "vendor/imagegen-client.js",
  "vendor/three/BufferGeometryUtils.js",
  "vendor/three/GLTFLoader.js",
  "vendor/three/OrbitControls.js",
  "vendor/three/SkeletonUtils.js",
  "vendor/three/three.core.min.js",
  "vendor/three/three.module.min.js",
];
const LAZY = [
  "js/container.js",
  "js/dialog.js",
  "js/history.js",
  "js/qr.js",
  "js/room-logic.js",
  "js/snap.js",
  "js/store.js",
  "js/ui-catalog.js",
  "js/ui-floor.js",
  "js/ui-guard.js",
  "js/ui-room.js",
  "js/ui-settings.js",
  "js/ui-shell.js",
  "vendor/qrcode.js",
  "vendor/three/LICENSE",
];
// </files>

const CACHE = `madori-${VERSION}`;
const SCOPE = new URL(self.registration.scope);
const ALL = new Set([...CORE, ...LAZY]);
const urlOf = (p) => new URL(p, SCOPE).href;
const fresh = (p) => new Request(urlOf(p), { cache: 'reload' });   // HTTP のキャッシュを通さずに取る

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE.map(fresh));
    // この端末で編集の部品を使っていれば(前の版の保存にあれば)、それも新しい版で保存し直す
    const old = (await caches.keys()).filter((k) => k.startsWith('madori-') && k !== CACHE);
    let usedLazy = false;
    for (const k of old) if (await (await caches.open(k)).match(urlOf('js/ui-shell.js'))) usedLazy = true;
    if (usedLazy) await cache.addAll(LAZY.map(fresh)).catch(() => {});
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('madori-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// 次に開いたときに、待っている新しい版へ切り替える(pwa.js が送る)
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

async function cacheFirst(path) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(urlOf(path));
  if (hit) return hit;
  const res = await fetch(fresh(path));
  if (res.ok) await cache.put(urlOf(path), res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname) || url.search) return;
  const rel = url.pathname.slice(SCOPE.pathname.length);
  if (req.mode === 'navigate' && (rel === '' || rel === 'index.html')) {
    event.respondWith(cacheFirst('index.html'));
    return;
  }
  if (ALL.has(rel)) event.respondWith(cacheFirst(rel));
});
