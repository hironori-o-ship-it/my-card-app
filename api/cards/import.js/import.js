import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const MAX_BATCH = 100;
const APP_FIELDS = ['group', 'company', 'company_kana', 'department', 'title', 'name', 'name_kana', 'address', 'phone', 'mobile', 'email', 'website', 'status', 'memo'];

function valueOrBlank(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, 5000);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end('Method Not Allowed');
  }

  try {
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
        owner: 'Webユーザー'
      };
      APP_FIELDS.forEach((field) => { card[field] = valueOrBlank(source && source[field]); });
      return card;
    });

    const { data, error } = await supabase.from('cards').insert(rows).select('id');
    if (error) throw error;
    return res.status(200).json({ success: true, importedCount: data ? data.length : rows.length });
  } catch (error) {
    console.error('CSV Import API Error:', error);
    return res.status(500).json({ success: false, error: '外部データの登録に失敗しました' });
  }
}
