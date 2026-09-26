import { requireUser, writeAuditLog } from '../../lib/auth.js';
import { updateStatus } from '../../lib/cards.js';

// 現役 / 異動・転職 保留 / ゴミ箱 の切り替え（画面の「保留へ」「ゴミ箱へ」「現役復帰」）
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end('Method Not Allowed');
  }
  try {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { ids, status } = req.body || {};
    const result = await updateStatus(auth, ids, status);
    if (!result.ok) return res.status(result.code).json({ success: false, error: result.error });
    if (result.count) await writeAuditLog(auth.supabase, { email: auth.email, ip: auth.ip, action: 'change_status', targetIds: result.ids, detail: { status } });
    return res.status(200).json({ success: true, count: result.count });
  } catch (err) {
    console.error('Status API Error:', err);
    return res.status(500).json({ success: false, error: '状態の更新に失敗しました' });
  }
}
