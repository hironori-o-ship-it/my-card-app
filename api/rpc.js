import { requireUser } from '../lib/auth.js';
import { functions } from '../lib/features.js';

// 画面（GAS版と同じ画面）からの呼び出し口。POST { fn: '関数名', args: [...] } → { success: true, result: 関数の戻り値 }
// ログインしていなければ 401（画面はログイン画面を出す）。関数名は決まったものだけ受け付ける
export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end('Method Not Allowed');
  }
  try {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const body = req.body || {};
    const fn = String(body.fn || '');
    const args = Array.isArray(body.args) ? body.args : [];
    if (!Object.prototype.hasOwnProperty.call(functions, fn)) return res.status(400).json({ success: false, error: '不明な操作です' });
    const result = await functions[fn](auth, ...args);
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error('RPC API Error:', err);
    return res.status(500).json({ success: false, error: '処理に失敗しました。時間をおいて再度お試しください' });
  }
}
