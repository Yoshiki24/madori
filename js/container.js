// .madori ファイル(バックアップ)の組み立て・分解(純粋。Node とブラウザの両方で動く)
// 形式: 'MADORI1\n'(8バイト)→ ヘッダーの長さ(4バイト、ビッグエンディアン)
//       → ヘッダー JSON { house, blobs: [{hash,type,size}] }(UTF-8)→ 画像の本体を順に連結
const MAGIC = new TextEncoder().encode('MADORI1\n');
const HEAD = MAGIC.length + 4;

export function pack(house, blobs) {
  const header = new TextEncoder().encode(JSON.stringify({
    house,
    blobs: blobs.map(b => ({ hash: b.hash, type: b.type, size: b.bytes.length })),
  }));
  const total = HEAD + header.length + blobs.reduce((s, b) => s + b.bytes.length, 0);
  const out = new Uint8Array(total);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, header.length);
  out.set(header, HEAD);
  let pos = HEAD + header.length;
  for (const b of blobs) { out.set(b.bytes, pos); pos += b.bytes.length; }
  return out;
}

export function unpack(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('not-madori');
  // 先頭の印を確かめる。短くても、印の途中まで一致していれば「途中で切れた」とみなす
  const n = Math.min(bytes.length, MAGIC.length);
  for (let i = 0; i < n; i++) if (bytes[i] !== MAGIC[i]) throw new Error('not-madori');
  if (bytes.length < HEAD) throw new Error('truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(MAGIC.length);
  if (bytes.length < HEAD + headerLen) throw new Error('truncated');
  let header;
  try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEAD, HEAD + headerLen))); }
  catch { throw new Error('not-madori'); }
  if (!header || typeof header !== 'object' || !header.house || typeof header.house !== 'object' || !Array.isArray(header.blobs)) {
    throw new Error('not-madori');
  }
  for (const b of header.blobs) {
    if (!b || typeof b.hash !== 'string' || typeof b.type !== 'string' || !Number.isInteger(b.size) || b.size < 0) {
      throw new Error('not-madori');
    }
  }
  const bodyLen = header.blobs.reduce((s, b) => s + b.size, 0);
  const start = HEAD + headerLen;
  if (bytes.length < start + bodyLen) throw new Error('truncated');
  if (bytes.length > start + bodyLen) throw new Error('not-madori'); // サイズ表と本体が合わない
  let pos = start;
  const blobs = header.blobs.map(b => {
    const out = { hash: b.hash, type: b.type, bytes: bytes.slice(pos, pos + b.size) };
    pos += b.size;
    return out;
  });
  return { house: header.house, blobs };
}
