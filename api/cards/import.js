import { requireUser, writeAuditLog } from '../../lib/auth.js';
import { clip, normalizeStatus } from '../../lib/cards.js';

const MAX_BATCH = 100;
const APP_FIELDS = ['group', 'company', 'company_kana', 'department', 'title', 'name', 'name_kana', 'address', 'phone', 'mobile', 'email', 'website', 'memo'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end('Method Not Allowed');
  }

  try {
    const auth = await requireUser(req, res);
    if (!auth) return;

    const incoming = req.body && req.body.cards;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ success: false, error: '取り込む名刺データがありません' });
    }
    if (incoming.length > MAX_BATCH) {
      return res.status(413).json({ success: false, error: '一度に取り込める件数を超えています' });
    }

    const timestamp = Date.now();
    const rows = incoming.map((source, index) => {
      const card = {
        id: 'csv_' + timestamp + '_' + index + '_' + Math.random().toString(36).slice(2, 8),
        owner: auth.email,
        tenant: auth.tenant,
        status: normalizeStatus(source && source.status)
      };
      APP_FIELDS.forEach((field) => { card[field] = clip(source && source[field], field === 'memo' ? 5000 : 500); });
      return card;
    });

    const { data, error } = await auth.supabase.from('cards').insert(rows).select('id');
    if (error) throw error;
    const ids = data ? data.map((r) => r.id) : [];
    await writeAuditLog(auth.supabase, { email: auth.email, tenant: auth.tenant, ip: auth.ip, action: 'import_csv', targetIds: ids, detail: { count: ids.length } });
    return res.status(200).json({ success: true, importedCount: ids.length || rows.length });
  } catch (error) {
    console.error('CSV Import API Error:', error);
    return res.status(500).json({ success: false, error: '外部データの登録に失敗しました' });
  }
}
