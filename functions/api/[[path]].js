// Cloudflare Pages 用の入口。/api/〜 への呼び出しを、Vercel用に書いた api/ の処理にそのまま渡す
// （中身は Vercel版と共通。直すのは api/ と lib/ だけでよい）
import auth from '../../api/auth.js';
import rpc from '../../api/rpc.js';
import cards from '../../api/cards.js';
import ocr from '../../api/ocr.js';
import usage from '../../api/usage.js';
import cardsImage from '../../api/cards/image.js';
import cardsImport from '../../api/cards/import.js';
import cardsOcr from '../../api/cards/ocr.js';
import cardsStatus from '../../api/cards/status.js';

const routes = {
  auth, rpc, cards, ocr, usage,
  'cards/image': cardsImage, 'cards/import': cardsImport, 'cards/ocr': cardsOcr, 'cards/status': cardsStatus
};

// Vercel の res（status / setHeader / json / send / end）と同じ使い方ができる入れ物
class ResponseShim {
  constructor() { this.statusCode = 200; this.headers = new Headers(); this.body = null; }
  status(code) { this.statusCode = code; return this; }
  setHeader(name, value) {
    this.headers.delete(name);
    [].concat(value).forEach((v) => this.headers.append(name, String(v)));
    return this;
  }
  getHeader(name) { return this.headers.get(name); }
  json(obj) {
    if (!this.headers.has('Content-Type')) this.headers.set('Content-Type', 'application/json; charset=utf-8');
    this.body = JSON.stringify(obj);
    return this;
  }
  send(body) { this.body = body; return this; }
  end(body) { if (body !== undefined) this.body = body; return this; }
  toResponse() {
    const noBody = this.statusCode === 204 || this.statusCode === 304;
    return new Response(noBody ? null : this.body, { status: this.statusCode, headers: this.headers });
  }
}

export async function onRequest(context) {
  const { request, env, params } = context;
  // 設定（SUPABASE_URL など）は Cloudflare の環境変数から process.env に写す
  for (const [k, v] of Object.entries(env || {})) if (typeof v === 'string') process.env[k] = v;

  const path = [].concat(params.path || []).join('/');
  const handler = routes[path];
  if (!handler) return new Response(JSON.stringify({ success: false, error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  if (!headers['x-forwarded-for'] && headers['cf-connecting-ip']) headers['x-forwarded-for'] = headers['cf-connecting-ip'];

  let body = {};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const text = await request.text();
    if (text.length > 4.5 * 1024 * 1024) return new Response(JSON.stringify({ success: false, error: '画像が大きすぎます。もう一度撮り直してください' }), { status: 413, headers: { 'Content-Type': 'application/json' } });
    if (String(headers['content-type'] || '').includes('json') && text) {
      try { body = JSON.parse(text); } catch (e) { body = {}; }
    }
  }

  const req = { method: request.method, headers, body, query: Object.fromEntries(url.searchParams), socket: { remoteAddress: headers['cf-connecting-ip'] || '' } };
  const res = new ResponseShim();
  try {
    await handler(req, res);
  } catch (err) {
    console.error('Pages function error:', err);
    return new Response(JSON.stringify({ success: false, error: '処理に失敗しました' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  return res.toResponse();
}
