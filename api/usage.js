import { requireUser } from '../lib/auth.js';
import { readUsage } from '../lib/usage.js';

const UNIT_PRICE_YEN = 0.02;

// 今月のAI読み取り枚数と上限（台帳ごと）。数え上げは /api/ocr だけが行う
// （以前あった POST のリセットは、利用者が上限を外せてしまうため廃止）
export default async function handler(req, res) {
  try {
    const auth = await requireUser(req, res);
    if (!auth) return;
    if (req.method === 'GET') {
      const usage = await readUsage(auth.supabase, auth.tenant);
      return res.status(200).json({ success: true, monthCount: usage.monthCount, totalCount: usage.row.total_count || 0, limit: auth.ocrLimit, unitPriceYen: UNIT_PRICE_YEN });
    }
    res.setHeader('Allow', ['GET']);
    return res.status(405).end('Method ' + req.method + ' Not Allowed');
  } catch (err) {
    console.error('Usage API Error:', err);
    return res.status(500).json({ success: false, error: '利用状況の取得に失敗しました' });
  }
}
