import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const UNIT_PRICE_YEN = 0.02;
const OWNER = process.env.SUPABASE_USAGE_OWNER || 'default-account';

function monthKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

export default async function handler(req, res) {
  try {
    const month = monthKey();
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('ocr_usage').select('*').eq('owner', OWNER).maybeSingle();
      if (error) throw error;
      const row = data || { month_key: month, month_count: 0, total_count: 0 };
      return res.status(200).json({ success: true, monthCount: row.month_key === month ? row.month_count : 0, totalCount: row.total_count || 0, unitPriceYen: UNIT_PRICE_YEN });
    }
    if (req.method === 'POST') {
      const action = req.body && req.body.action;
      const { data: current, error: readError } = await supabase.from('ocr_usage').select('*').eq('owner', OWNER).maybeSingle();
      if (readError) throw readError;
      const base = current || { owner: OWNER, month_key: month, month_count: 0, total_count: 0 };
      const next = action === 'reset' ? { ...base, month_key: month, month_count: 0, total_count: 0 } : { ...base, month_key: month, month_count: base.month_key === month ? (base.month_count || 0) + 1 : 1, total_count: (base.total_count || 0) + 1 };
      const { data, error } = await supabase.from('ocr_usage').upsert(next, { onConflict: 'owner' }).select().single();
      if (error) throw error;
      return res.status(200).json({ success: true, monthCount: data.month_count, totalCount: data.total_count, unitPriceYen: UNIT_PRICE_YEN });
    }
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).end('Method ' + req.method + ' Not Allowed');
  } catch (err) {
    console.error('Usage API Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
