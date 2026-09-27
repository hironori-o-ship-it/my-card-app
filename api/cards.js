import { requireUser, writeAuditLog } from '../lib/auth.js';
import { EDIT_FIELDS, clip, formatCard, updateStatus } from '../lib/cards.js';

export default async function handler(req, res) {
  const { method } = req;

  try {
    const auth = await requireUser(req, res);
    if (!auth) return;

    if (method === 'GET') {
      const { data, error } = await auth.supabase.from('cards').select('*').eq('tenant', auth.tenant).order('created_at', { ascending: false });
      if (error) throw error;
      await writeAuditLog(auth.supabase, { email: auth.email, tenant: auth.tenant, ip: auth.ip, action: 'list_cards', detail: { count: data.length } });
      return res.status(200).json({ success: true, cards: data.map(formatCard) });
    }

    if (method === 'PUT') {
      const card = req.body;
      if (!card || !card.id) return res.status(400).json({ success: false, error: 'カードIDが指定されていません' });
      const update = { updated_at: new Date().toISOString() };
      EDIT_FIELDS.forEach((field) => { update[field] = clip(card[field], field === 'memo' ? 20000 : 500); });
      if (!update.name) return res.status(400).json({ success: false, error: '氏名を入力してください' });
      const { data, error } = await auth.supabase.from('cards').update(update).eq('tenant', auth.tenant).eq('id', clip(card.id, 200)).select('id');
      if (error) throw error;
      if (!data || data.length === 0) return res.status(404).json({ success: false, error: '更新対象の名刺が見つかりません' });
      await writeAuditLog(auth.supabase, { email: auth.email, tenant: auth.tenant, ip: auth.ip, action: 'update_card', targetIds: [data[0].id] });
      return res.status(200).json({ success: true });
    }

    // 旧画面との互換用（状態変更は /api/cards/status と同じ処理）
    if (method === 'POST') {
      const { ids, status } = req.body || {};
      const result = await updateStatus(auth, ids, status);
      if (!result.ok) return res.status(result.code).json({ success: false, error: result.error });
      if (result.count) await writeAuditLog(auth.supabase, { email: auth.email, tenant: auth.tenant, ip: auth.ip, action: 'change_status', targetIds: result.ids, detail: { status } });
      return res.status(200).json({ success: true, count: result.count });
    }

    res.setHeader('Allow', ['GET', 'PUT', 'POST']);
    return res.status(405).end('Method ' + method + ' Not Allowed');
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ success: false, error: '処理に失敗しました。時間をおいて再度お試しください' });
  }
}
