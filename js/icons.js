// 線の SVG アイコン(絵文字は使わない)。色は currentColor で文字の色に合わせる
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  menu: 'M4 6h16M4 12h16M4 18h16',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM5 17a3 3 0 0 1 3-3h11',
  warn: 'M12 4L2.5 20h19L12 4zM12 10v4M12 17v.01',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  upload: 'M12 15V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  rotate: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4',
  rotateLeft: 'M4 12a8 8 0 1 0 2.34-5.66M4 4v4h4',
  ruler: 'M3 17L17 3l4 4L7 21l-4-4zM7 13l2 2M10 10l2 2M13 7l2 2',
  pointer: 'M5 3l14 8-6 1.5L10 19 5 3z',
  polygon: 'M5 19L3 9l8-6 9 5-3 11H5z',
  square: 'M4 4h16v16H4z',
  size: 'M3 7h18M3 7l3-3M3 7l3 3M21 7l-3-3M21 7l-3 3M5 13h14v7H5z',
  door: 'M6 20V4h9v16M3 20h18M12 12h.01M15 4l4 2v14',
  check: 'M5 12l5 5L20 7',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  // スマホの閲覧画面
  room: 'M4 4h16v16H4zM13 4v6M4 13h5M13 20v-4h7',
  house: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-5h4v5',
  sofa: 'M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3M3 11h4v4h10v-4h4v6H3zM5 17v2M19 17v2',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4',
  chevronDown: 'M6 9l6 6 6-6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  offline: 'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4-2.4M19 13a10 10 0 0 0-3-2M2 8.8a15 15 0 0 1 5-2.9M22 8.8a15 15 0 0 0-11-3.7M12 20h.01',
};

export function icon(name, size = 20) {
  const d = PATHS[name];
  if (!d) throw new Error(`アイコンがありません: ${name}`);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

// 線の形(path の d)だけ。SVG の図の中に重ねるときに使う(24×24 の座標)
export function iconPath(name) {
  const d = PATHS[name];
  if (!d) throw new Error(`アイコンがありません: ${name}`);
  return d;
}
