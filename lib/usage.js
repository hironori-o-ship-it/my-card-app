// AI読み取り（Gemini）の利用枚数を台帳ごと・月ごとに数える
export function monthKeyJst() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

export async function readUsage(supabase, tenant) {
  const month = monthKeyJst();
  const { data, error } = await supabase.from('ocr_usage').select('*').eq('owner', tenant).maybeSingle();
  if (error) throw error;
  const row = data || { owner: tenant, month_key: month, month_count: 0, total_count: 0 };
  return { row, month, monthCount: row.month_key === month ? (row.month_count || 0) : 0 };
}

// 上限に達していれば false（limit が null / undefined なら無制限）
export async function checkOcrLimit(auth) {
  const usage = await readUsage(auth.supabase, auth.tenant);
  const limit = auth.ocrLimit;
  const allowed = limit === null || limit === undefined || usage.monthCount < limit;
  return { allowed, monthCount: usage.monthCount, limit };
}

export async function addOcrUsage(auth) {
  const { row, month, monthCount } = await readUsage(auth.supabase, auth.tenant);
  const next = { ...row, owner: auth.tenant, month_key: month, month_count: monthCount + 1, total_count: (row.total_count || 0) + 1 };
  const { error } = await auth.supabase.from('ocr_usage').upsert(next, { onConflict: 'owner' });
  if (error) console.error('OCR usage update error:', error.message);
  return next.month_count;
}
