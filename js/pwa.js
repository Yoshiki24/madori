// service worker の登録と、新しい版の知らせ。https か localhost のときだけ登録する
//   新しい版は次に開いたときに切り替える(開いている間は古い版のまま)。開いている間に見つかったら小さく知らせる
const NOTICE = '新しい版があります。開き直すと更新されます';

function canRegister() {
  if (!('serviceWorker' in navigator)) return false;
  return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

function showNotice() {
  if (document.querySelector('#update-notice')) return;
  const el = document.createElement('div');
  el.id = 'update-notice';
  el.className = 'update-notice';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${NOTICE}</span><button type="button" class="icon-btn" aria-label="閉じる"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  document.body.append(el);
}

export async function registerServiceWorker() {
  if (!canRegister()) return;
  try {
    const hadController = !!navigator.serviceWorker.controller;
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    // 前回までに入れ替わりを待っている版があれば、今(開いた直後)切り替えて読み込み直す
    if (reg.waiting && hadController) {
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
      reg.waiting.postMessage('skip-waiting');
      return;
    }
    const watch = (sw) => {
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) showNotice();
      });
    };
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    // 開いたままの時間が長いとき(スマホで戻ってきたとき)にも新しい版を探す
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  } catch (e) {
    console.warn('service worker を登録できませんでした', e?.name ?? 'Error');
  }
}
