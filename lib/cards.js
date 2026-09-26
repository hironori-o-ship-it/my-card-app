export const STATUSES = ['現役', '異動・転職 保留', 'ゴミ箱'];
export const EDIT_FIELDS = ['group', 'company', 'company_kana', 'department', 'title', 'name', 'name_kana', 'address', 'phone', 'mobile', 'email', 'website', 'memo'];

export function clip(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max || 500);
}

export function normalizeStatus(value) {
  const s = clip(value, 50);
  return STATUSES.includes(s) ? s : '現役';
}

// 画像がデータ本体（data:～）で保存されている場合は、一覧には載せず画像用APIのURLを返す
function imageLink(value, id, kind) {
  const v = String(value || '');
  if (!v) return '';
  if (v.indexOf('data:') === 0) return '/api/cards/image?id=' + encodeURIComponent(id) + (kind ? '&kind=' + kind : '');
  if (/^https:\/\//i.test(v)) return v;
  return '';
}

export function formatCard(c) {
  return {
    id: c.id, owner: c.owner, status: c.status, memo: c.memo, group: c.group,
    company: c.company, company_kana: c.company_kana, department: c.department, title: c.title,
    name: c.name, name_kana: c.name_kana, address: c.address, phone: c.phone, mobile: c.mobile,
    email: c.email, website: c.website,
    fileUrl: imageLink(c.file_url, c.id, ''),
    avatarUrl: imageLink(c.avatar_url, c.id, 'avatar'),
    createdAt: c.created_at
  };
}

export async function updateStatus(auth, ids, status) {
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, count: 0 };
  if (ids.length > 1000) return { ok: false, code: 400, error: '一度に変更できる件数を超えています' };
  if (!STATUSES.includes(status)) return { ok: false, code: 400, error: '状態の指定が正しくありません' };
  const cleanIds = ids.map((id) => clip(id, 200)).filter(Boolean);
  const { data, error } = await auth.supabase.from('cards')
    .update({ status, updated_at: new Date().toISOString() })
    .in('id', cleanIds)
    .select('id');
  if (error) throw error;
  return { ok: true, count: data ? data.length : 0, ids: cleanIds };
}
