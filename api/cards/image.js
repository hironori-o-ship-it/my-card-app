import { requireUser, writeAuditLog } from '../../lib/auth.js';
import { clip } from '../../lib/cards.js';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];

// 名刺原本・顔写真を、ログインした人にだけ返す
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end('Method Not Allowed');
  }
  try {
    const auth = await requireUser(req, res);
    if (!auth) return;
    let id = clip(req.query && req.query.id, 200);
    const column = req.query && req.query.kind === 'avatar' ? 'avatar_url' : 'file_url';
    if (column === 'avatar_url' && id.indexOf('a-') === 0) id = id.slice(2); // 新しい画面の顔写真の印（a-名刺ID）
    if (!id) return res.status(400).json({ success: false, error: 'IDが指定されていません' });

    // 本人の台帳と、本人が入っているチームの台帳の画像だけ
    const tenants = [auth.tenant].concat(auth.team ? [auth.team] : []);
    const { data, error } = await auth.supabase.from('cards').select(column).in('tenant', tenants).eq('id', id).maybeSingle();
    if (error) throw error;
    const value = data ? String(data[column] || '') : '';
    const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
    if (!match || !IMAGE_TYPES.includes(match[1].toLowerCase())) return res.status(404).json({ success: false, error: '画像がありません' });

    await writeAuditLog(auth.supabase, { email: auth.email, tenant: auth.tenant, ip: auth.ip, action: column === 'avatar_url' ? 'view_avatar' : 'view_card_image', targetIds: [id] });
    res.setHeader('Content-Type', match[1].toLowerCase());
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(Buffer.from(match[2], 'base64'));
  } catch (err) {
    console.error('Image API Error:', err);
    return res.status(500).json({ success: false, error: '画像の取得に失敗しました' });
  }
}
