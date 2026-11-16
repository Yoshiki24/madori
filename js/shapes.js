// 家具の簡易な形 → 箱の一覧(純粋)。
// 箱は家具の中心・床を原点とする。x: 幅方向、y: 奥行方向(正面は −y)、z: 高さ方向の下端。mm。
// role: 'body' 本体の部品 / 'front' 正面(−y の面)に写真を貼る部品 / 'leg' 脚 / 'top' 天板・上面

export const KINDS = [
  { id: 'box', label: '箱' }, { id: 'table', label: 'テーブル' }, { id: 'chair', label: '椅子' }, { id: 'sofa', label: 'ソファ' },
  { id: 'bed', label: 'ベッド' }, { id: 'shelf', label: '棚' }, { id: 'rug', label: 'ラグ' }, { id: 'lamp', label: '照明' },
];

const part = (x, y, z, w, d, h, role) => ({ x, y, z, w, d, h, role });

// 四隅の脚(太さ s、高さ h)
function legs(W, D, s, h) {
  const out = [];
  for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
    out.push(part(sx * (W / 2 - s / 2), sy * (D / 2 - s / 2), 0, s, s, h, 'leg'));
  }
  return out;
}

const BUILDERS = {
  box: (W, D, H) => [part(0, 0, 0, W, D, H, 'front')],

  // 天板 厚さ min(40, h) + 脚4本 太さ 50(寸法が小さいときは細くする)。脚の高さが 0 なら天板だけ
  table: (W, D, H) => {
    const t = Math.min(40, H);
    const legH = H - t;
    const s = Math.min(50, W / 2, D / 2);
    return [...(legH > 0 ? legs(W, D, s, legH) : []), part(0, 0, legH, W, D, t, 'top')];
  },

  // 座面の上端 h×0.5、奥側に背もたれ、脚4本
  chair: (W, D, H) => {
    const seatTop = H * 0.5;
    const st = Math.min(40, seatTop / 2);
    const s = Math.min(40, W / 4, D / 4);
    const bt = Math.min(40, D * 0.2);
    return [
      ...legs(W, D, s, seatTop - st),
      part(0, 0, seatTop - st, W, D, st, 'body'),
      part(0, D / 2 - bt / 2, seatTop, W, bt, H - seatTop, 'front'),
    ];
  },

  // 座面 h×0.5、背もたれ 奥行の25%、肘掛け 幅の各8%
  sofa: (W, D, H) => {
    const seatTop = H * 0.5;
    const bd = D * 0.25, aw = W * 0.08;
    const armTop = seatTop + (H - seatTop) * 0.5;
    const fd = D - bd, fy = -bd / 2;
    return [
      part(0, fy, 0, W - 2 * aw, fd, seatTop, 'front'),
      part(0, D / 2 - bd / 2, 0, W, bd, H, 'body'),
      part(-(W / 2 - aw / 2), fy, 0, aw, fd, armTop, 'body'),
      part(W / 2 - aw / 2, fy, 0, aw, fd, armTop, 'body'),
    ];
  },

  // マットレス h×0.6 の高さまで、頭側(奥 +y)に高さ h の板
  bed: (W, D, H) => {
    const hb = Math.min(60, D * 0.1);
    return [
      part(0, -hb / 2, 0, W, D - hb, H * 0.6, 'front'),
      part(0, D / 2 - hb / 2, 0, W, hb, H, 'body'),
    ];
  },

  // 側板2枚・天板・底板・棚板(約350mmごと)・背板 厚さ 20
  shelf: (W, D, H) => {
    const pt = Math.min(20, W / 4);       // 側板
    const tt = Math.min(20, H / 4);       // 天板・底板・棚板
    const bt = Math.min(20, D / 4);       // 背板
    const iw = W - 2 * pt, bd = D - bt, by = -bt / 2;
    const inner = H - 2 * tt;
    const gaps = Math.max(1, Math.round(inner / 350));
    const out = [
      part(-(W / 2 - pt / 2), 0, 0, pt, D, H, 'body'),
      part(W / 2 - pt / 2, 0, 0, pt, D, H, 'body'),
      part(0, by, 0, iw, bd, tt, 'body'),
      part(0, by, H - tt, iw, bd, tt, 'body'),
    ];
    const pitch = (inner - (gaps - 1) * tt) / gaps;   // 板と板の間のすき間
    for (let i = 1; i < gaps; i++) out.push(part(0, by, tt + i * pitch + (i - 1) * tt, iw, bd, tt, 'body'));
    out.push(part(0, D / 2 - bt / 2, tt, iw, bt, inner, 'front'));
    return out;
  },

  rug: (W, D, H) => [part(0, 0, 0, W, D, Math.min(H, 20), 'top')],

  // 台座・細い柱・上部の傘
  lamp: (W, D, H) => {
    const bh = Math.min(30, H * 0.05);
    const shadeH = H * 0.25;
    const pw = Math.min(30, W * 0.1), pd = Math.min(30, D * 0.1);
    return [
      part(0, 0, 0, W * 0.6, D * 0.6, bh, 'body'),
      part(0, 0, bh, pw, pd, H - shadeH - bh, 'body'),
      part(0, 0, H - shadeH, W, D, shadeH, 'front'),
    ];
  },
};

// 種類と寸法から箱の一覧を作る。未知の kind は 'box'
export function shapeParts(kind, width, depth, height) {
  const build = BUILDERS[kind] || BUILDERS.box;
  return build(width, depth, height);
}
