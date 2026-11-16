// imagegen-hub の共通クライアント(ブラウザ・Node 両用)
//
// 使い方:
//   import { createImagegenClient, QuotaExhaustedError } from "./imagegen-client.js";
//   const hub = createImagegenClient({ baseUrl, token }); // token はコードに書かず、設定から読む
//   try {
//     const { bytes, contentType } = await hub.generateImage({ prompt: "..." });
//   } catch (e) {
//     if (e instanceof QuotaExhaustedError) { /* ボタンを無効にし、e.message を表示 */ }
//   }

export function formatResetJst(resetAt) {
  if (!resetAt) return "不明";
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(resetAt));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("month")}/${get("day")} ${Number(get("hour"))}:${get("minute")}`;
}

const SERVICE_NAMES = { image2d: "2D画像", model3d: "3Dモデル" };

export class QuotaExhaustedError extends Error {
  constructor(service, resetAt) {
    super(`${SERVICE_NAMES[service] ?? service}の無料枠を使い切りました。回復は ${formatResetJst(resetAt)}(日本時間)です`);
    this.name = "QuotaExhaustedError";
    this.service = service;
    this.resetAt = resetAt;
  }
}

export class ImagegenError extends Error {
  constructor(status, code, message) {
    super(message ? `${message}(${code ?? status})` : `エラーが発生しました(${code ?? status})`);
    this.name = "ImagegenError";
    this.status = status;
    this.code = code;
  }
}

export function createImagegenClient({ baseUrl, token, fetch: doFetch = globalThis.fetch.bind(globalThis) } = {}) {
  if (!baseUrl) throw new Error("baseUrl を指定してください");
  if (!token) throw new Error("token を指定してください");
  const base = baseUrl.replace(/\/+$/, "");

  async function call(path, { method = "GET", body } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await doFetch(`${base}${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res;
    const j = await res.json().catch(() => ({}));
    if (res.status === 429 && j.error === "quota_exhausted") throw new QuotaExhaustedError(j.service, j.resetAt);
    throw new ImagegenError(res.status, j.error, j.message);
  }

  const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer());

  return {
    async getQuota() {
      return (await call("/quota")).json();
    },
    async generateImage(opts) {
      const res = await call("/image", { method: "POST", body: opts });
      const remaining = Number(res.headers.get("X-Quota-Remaining"));
      return { bytes: await bytesOf(res), contentType: res.headers.get("Content-Type"), remaining };
    },
    async generate3d(opts) {
      const { jobId, source } = await (await call("/3d/start", { method: "POST", body: opts })).json();
      const path = `/3d/result/${encodeURIComponent(jobId)}`;
      // 通信エラー・待機の中断(504)は、同じ jobId で最大3回まで取り直す(Space は1回しか呼ばれない)
      let res;
      for (let attempt = 1; ; attempt++) {
        try {
          res = await call(path);
          break;
        } catch (e) {
          const retryable = e instanceof TypeError || (e instanceof ImagegenError && e.status === 504);
          if (!retryable || attempt >= 3) throw e;
        }
      }
      return { bytes: await bytesOf(res), contentType: res.headers.get("Content-Type"), source };
    },
  };
}
