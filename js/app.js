// 起動。編集(Mac)か閲覧(スマホ)かを決め、必要な部品だけを読み込む(import() で分ける)
//   URL に #s=…&v=… があれば保存して URL から消し、閲覧にする
//   保存済みの viewToken があり editToken がなければ閲覧。それ以外は編集
//   幅 700px 未満で合言葉がなければ、QRコードを読み取る案内を出す
import { readLinkHash } from './sync.js';
import { getSetting, setSetting } from './db.js';
import { registerServiceWorker } from './pwa.js';

const root = document.querySelector('#app');

async function decide() {
  const link = readLinkHash(location.hash);
  if (link) {
    history.replaceState(history.state, '', location.pathname + location.search);
    // 編集用の合言葉がある端末(Mac)では、送信先・閲覧用の合言葉・送信の印を書き換えない(今の設定のまま閲覧する)
    if (await getSetting('editToken')) return 'viewer';
    const oldUrl = await getSetting('syncUrl');
    await setSetting('syncUrl', link.baseUrl);
    await setSetting('viewToken', link.viewToken);
    if (oldUrl && oldUrl !== link.baseUrl) await setSetting('etag', null);   // 別の保管場所の印は使わない
    return 'viewer';
  }
  if (location.hash.includes('v=')) history.replaceState(history.state, '', location.pathname + location.search);
  const [viewToken, editToken] = await Promise.all([getSetting('viewToken'), getSetting('editToken')]);
  if (viewToken && !editToken) return 'viewer';
  if (!viewToken && !editToken && innerWidth < 700 && !sessionStorage.getItem('madori-edit-here')) return 'guide';
  return 'editor';
}

async function startEditor() {
  const [{ store }, model, { mountShell }, { loadSettings }, { claimEditor, mountGuards }] = await Promise.all([
    import('./store.js'), import('./model.js'), import('./ui-shell.js'), import('./ui-settings.js'), import('./ui-guard.js'),
  ]);
  // 編集できるタブは1つだけ。別のタブが編集中なら、利用者が「このタブで編集する」を押すまで待つ
  await claimEditor(root);
  // テストからデータを入れるための入口
  window.__madori = { store, model };
  await store.init();
  await loadSettings();
  mountShell(root);
  mountGuards(root);
}

async function startViewer() {
  const { startViewer: start } = await import('./ui-viewer.js');
  await start(root);
}

// 狭い画面で合言葉がないとき(スマホで初めて開いた)
function showGuide() {
  document.body.classList.add('guide-body');
  root.innerHTML = `<main class="guide">
    <img class="guide-mark" src="icon.svg" alt="" width="96" height="96">
    <h1 class="guide-title">MADORI</h1>
    <p class="guide-text">Mac の設定画面の QRコードを読み取ってください</p>
    <p class="guide-sub">読み取ると、この端末で家の間取りと家具を見られるようになります。</p>
    <button type="button" class="pill pill-ghost-inline guide-edit">この端末で編集する</button>
  </main>`;
  root.querySelector('.guide-edit').addEventListener('click', () => {
    sessionStorage.setItem('madori-edit-here', '1');
    location.reload();
  });
}

const mode = await decide();
document.documentElement.dataset.mode = mode;
if (mode === 'viewer') await startViewer();
else if (mode === 'guide') showGuide();
else await startEditor();
registerServiceWorker();
