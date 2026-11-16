// 平面図の拡大・移動(viewBox を動かす)。
// 前半は純粋な計算(Node で試せる)、後半の createViewport が画面の操作(ホイール・ドラッグ・キー・枠の大きさ)をまとめる。
// 座標: 「世界」は図の座標(mm)、「画面」は枠の左上からの px。viewBox は枠と同じ縦横比にする(余白の歪みがない)
import { icon } from './icons.js';

const DEFAULT_BOUNDS = { x: 0, y: 0, w: 10000, h: 8000 };   // 中身がないときに見せる範囲(10m × 8m)
export const MIN_UNIT = 0.2;   // 1px あたり 0.2mm まで拡大
export const MAX_UNIT = 500;   // 1px あたり 500mm まで縮小

// 1px あたりの mm
export const unitOf = (vb, size) => vb.w / size.width;

// 中身の範囲 bounds を、枠 size の中央に margin(px)の余白で収める
export function fitView(bounds, size, margin = 40) {
  const b = bounds && bounds.w >= 0 && bounds.h >= 0 ? bounds : DEFAULT_BOUNDS;
  const aw = Math.max(1, size.width - margin * 2), ah = Math.max(1, size.height - margin * 2);
  const k = Math.max(Math.max(b.w, 1) / aw, Math.max(b.h, 1) / ah);
  const w = size.width * k, h = size.height * k;
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}

// factor 倍に拡大する(1 より大きいと拡大)。pivot(世界の点)は画面の同じ位置に残る
export function zoomView(vb, factor, pivot, size, { minUnit = MIN_UNIT, maxUnit = MAX_UNIT } = {}) {
  const u = unitOf(vb, size);
  const nu = Math.min(maxUnit, Math.max(minUnit, u / factor));
  const f = u / nu;
  return { x: pivot.x - (pivot.x - vb.x) / f, y: pivot.y - (pivot.y - vb.y) / f, w: vb.w / f, h: vb.h / f };
}

// 画面で dx, dy(px)だけ図を動かす
export function panView(vb, dx, dy, size) {
  const u = unitOf(vb, size);
  return { x: vb.x - dx * u, y: vb.y - dy * u, w: vb.w, h: vb.h };
}

// 枠の大きさが変わったとき: 中心と拡大率を保つ
export function resizeView(vb, oldSize, newSize) {
  const u = unitOf(vb, oldSize);
  const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
  const w = newSize.width * u, h = newSize.height * u;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function toWorld(vb, size, p) {
  return { x: vb.x + (p.x * vb.w) / size.width, y: vb.y + (p.y * vb.h) / size.height };
}

export function toScreen(vb, size, p) {
  return { x: ((p.x - vb.x) * size.width) / vb.w, y: ((p.y - vb.y) * size.height) / vb.h };
}

// ---- 画面の操作 ----

const editable = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName));

// host の中に図を描く場所と、拡大・縮小・全体を表示のボタンを作る。
//   getBounds()            中身の範囲(mm)。null なら既定の範囲
//   render({ viewBox, size, unit }) → SVG などの HTML 文字列
//   afterRender(svg)       描いたあとに呼ぶ(重ね書きなど)
//   canPan(e)              このドラッグで図を動かしてよいか(Space を押しながら・中ボタンなら常に動かす)
//   onTap(e, p)            動かさずに押して離したとき(p は押した位置の世界座標)
//   onDragStart(e, p)      { move(p, e), end(p, e), cancel() } を返すと、そのドラッグを受け持つ
//   onHover(p, e)          押していないときのポインタの位置
//   touchScroll            true なら(スマホの閲覧)、全体表示より拡大していない間は1本指の縦のなぞりをページのスクロールに譲る。
//                          1本指で図を動かすのは拡大している間だけ。2本指のつまむ・移動はいつでも
// 動かしたあとの click は止める(動かしただけで選択が外れないように)
export function createViewport(host, {
  getBounds, render, afterRender = null, margin = 40, canPan = () => true,
  onTap = null, onDragStart = null, onHover = null, label = '平面図', touchScroll = false,
} = {}) {
  host.classList.add('vp');
  host.innerHTML = `<div class="vp-canvas" tabindex="0" role="group" aria-label="${label}(+ − で拡大・縮小、矢印で移動、0 で全体を表示)"></div>
    <div class="vp-controls" role="group" aria-label="表示の大きさ">
      <button type="button" class="icon-btn vp-btn" data-vp="in" aria-label="拡大" title="拡大(+)">${icon('plus', 18)}</button>
      <button type="button" class="icon-btn vp-btn" data-vp="out" aria-label="縮小" title="縮小(−)">${icon('minus', 18)}</button>
      <button type="button" class="pill vp-btn vp-fit" data-vp="fit" title="全体を表示(0)">${icon('fit', 18)}<span>全体を表示</span></button>
    </div>`;
  const canvas = host.querySelector('.vp-canvas');
  let vb = null, size = null, fitted = true, timer = null, drag = null, suppressClick = false, space = false;

  const measure = () => {
    const r = canvas.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
  };
  const svgEl = () => canvas.querySelector('svg');

  // 全体表示より拡大しているか(touchScroll のとき、1本指で図を動かせるのはこの間だけ)
  const zoomedIn = () => {
    if (!vb || !size || fitted) return false;
    return unitOf(vb, size) < unitOf(fitView(getBounds(), size, margin), size) * 0.999;
  };
  // 指の操作をブラウザに譲る範囲。触れた時点の値が使われるので、拡大・縮小のたびに直す
  const syncTouch = () => { if (touchScroll) canvas.style.touchAction = zoomedIn() ? 'none' : 'pan-y'; };

  function draw() {
    clearTimeout(timer); timer = null;
    if (!size) return;
    syncTouch();
    canvas.innerHTML = render({ viewBox: vb, size, unit: unitOf(vb, size) });
    const svg = svgEl();
    host.querySelector('.vp-controls').hidden = !svg;
    if (svg && afterRender) afterRender(svg);
  }
  // 拡大・移動の途中は viewBox だけ変え、線の太さは少し後にまとめて描き直す
  function quick() {
    svgEl()?.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    syncTouch();
    clearTimeout(timer);
    timer = setTimeout(draw, 120);
  }

  const api = {
    get viewBox() { return vb; },
    get size() { return size; },
    get unit() { return vb && size ? unitOf(vb, size) : 1; },
    get fitted() { return fitted; },
    get canvas() { return canvas; },
    // 描き直す。全体を表示している間は、中身に合わせて範囲も直す
    refresh() {
      size = measure() ?? size;
      if (!size) return;
      if (!vb || fitted) vb = fitView(getBounds(), size, margin);
      draw();
    },
    fit() {
      fitted = true;
      size = measure() ?? size;
      if (!size) return;
      vb = fitView(getBounds(), size, margin);
      draw();
    },
    zoomBy(factor, client = null) {
      if (!vb) return;
      const r = canvas.getBoundingClientRect();
      const pivot = client ? toWorld(vb, size, { x: client.x - r.left, y: client.y - r.top }) : { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
      vb = zoomView(vb, factor, pivot, size);
      fitted = false;
      quick();
    },
    panBy(dx, dy) {
      if (!vb) return;
      vb = panView(vb, dx, dy, size);
      fitted = false;
      quick();
    },
    // ページの座標(clientX, clientY)→ 世界座標
    toWorld(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      return toWorld(vb, size, { x: clientX - r.left, y: clientY - r.top });
    },
    // 世界座標 → ページの座標
    toClient(p) {
      const r = canvas.getBoundingClientRect();
      const s = toScreen(vb, size, p);
      return { x: s.x + r.left, y: s.y + r.top };
    },
    destroy() { ro.disconnect(); removeEventListener('keydown', onSpace); removeEventListener('keyup', onSpace); },
  };

  host.querySelector('.vp-controls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-vp]');
    if (!b) return;
    if (b.dataset.vp === 'fit') api.fit();
    else api.zoomBy(b.dataset.vp === 'in' ? 1.25 : 0.8);
  });

  canvas.addEventListener('wheel', (e) => {
    if (!vb) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : 1;
    // トラックパッドのつまむ操作は ctrlKey 付きの wheel になる
    const f = Math.exp((-e.deltaY * k) * (e.ctrlKey ? 0.01 : 0.0015));
    api.zoomBy(f, { x: e.clientX, y: e.clientY });
  }, { passive: false });

  const point = (e) => api.toWorld(e.clientX, e.clientY);

  // 2本指: つまんで拡大・縮小し、指の中点の動きで図を動かす(タッチ)
  const touches = new Map();   // pointerId → { x, y }
  let pinch = null;            // { d, mx, my }
  const pinchInfo = () => {
    const [a, b] = [...touches.values()];
    return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && vb) {
        // 1本目の操作(図の移動・家具のドラッグ・タップ)はやめて、つまむ操作にする
        if (drag?.mode === 'drag') drag.handler.cancel?.();
        drag = null;
        host.classList.remove('panning');
        pinch = pinchInfo();
        suppressClick = true;
        canvas.setPointerCapture?.(e.pointerId);
        e.preventDefault();
        return;
      }
      if (touches.size > 2 || pinch) return;
    }
    suppressClick = false;
    if (!vb || e.button === 2) return;
    const p = point(e);
    if (e.button === 0 && !space && onDragStart) {
      const h = onDragStart(e, p);
      if (h) {
        drag = { mode: 'drag', handler: h, id: e.pointerId };
        canvas.setPointerCapture?.(e.pointerId);
        e.preventDefault();
        return;
      }
    }
    if (e.button === 1) e.preventDefault();
    const touchPan = !(touchScroll && e.pointerType === 'touch') || zoomedIn();
    drag = { mode: 'pending', id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, p, button: e.button, pan: space || e.button === 1 || (touchPan && canPan(e)) };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) {
      if (touches.size < 2) return;
      const p = pinchInfo();
      api.panBy(p.mx - pinch.mx, p.my - pinch.my);
      api.zoomBy(p.d / pinch.d, { x: p.mx, y: p.my });
      pinch = p;
      return;
    }
    if (!drag || drag.id !== e.pointerId) { if (vb && onHover) onHover(point(e), e); return; }
    if (drag.mode === 'drag') { drag.handler.move(point(e), e); return; }
    if (drag.mode === 'pending') {
      if (drag.pan && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) {
        drag.mode = 'pan';
        canvas.setPointerCapture?.(e.pointerId);
        host.classList.add('panning');
      } else {
        if (onHover) onHover(point(e), e);
        return;
      }
    }
    api.panBy(e.clientX - drag.lx, e.clientY - drag.ly);
    drag.lx = e.clientX; drag.ly = e.clientY;
  });

  const finish = (e, cancel) => {
    touches.delete(e.pointerId);
    if (pinch) {
      if (touches.size < 2) { pinch = null; draw(); }
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    host.classList.remove('panning');
    if (d.mode === 'drag') {
      suppressClick = true;
      if (cancel) d.handler.cancel?.(); else d.handler.end(point(e), e);
    } else if (d.mode === 'pan') {
      suppressClick = true;
      draw();
    } else if (!cancel && d.button === 0 && onTap) {
      onTap(e, d.p);
    }
  };
  canvas.addEventListener('pointerup', (e) => finish(e, false));
  canvas.addEventListener('pointercancel', (e) => finish(e, true));
  canvas.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); }
  }, true);

  // キー: + − で拡大・縮小、0 で全体、矢印で移動(図にフォーカスがあるとき)
  canvas.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = 60;
    const k = e.key;
    if (k === '+' || k === '=') api.zoomBy(1.25);
    else if (k === '-') api.zoomBy(0.8);
    else if (k === '0') api.fit();
    else if (k === 'ArrowLeft') api.panBy(step, 0);
    else if (k === 'ArrowRight') api.panBy(-step, 0);
    else if (k === 'ArrowUp') api.panBy(0, step);
    else if (k === 'ArrowDown') api.panBy(0, -step);
    else return;
    e.preventDefault();
  });

  // Space を押している間はドラッグで図を動かす
  function onSpace(e) {
    if (e.code !== 'Space' || editable(e.target)) return;
    if (e.type === 'keydown' && !canvas.matches(':hover') && document.activeElement !== canvas) return;
    space = e.type === 'keydown';
    host.classList.toggle('space-pan', space);
    e.preventDefault();
  }
  addEventListener('keydown', onSpace);
  addEventListener('keyup', onSpace);

  const ro = new ResizeObserver(() => {
    const s = measure();
    if (!s) return;
    if (size && vb && !fitted && (s.width !== size.width || s.height !== size.height)) vb = resizeView(vb, size, s);
    else if (!vb || fitted) vb = fitView(getBounds(), s, margin);
    size = s;
    draw();
  });
  ro.observe(canvas);
  return api;
}
