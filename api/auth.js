import { checkCsrf, clearSessionCookies, clientIp, getSupabase, isAllowedEmail, requireUser, setSessionCookies, writeAuditLog } from '../lib/auth.js';

// GET: ログイン中の確認 / POST {action:'login'|'logout'}
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const auth = await requireUser(req, res);
      if (!auth) return;
      return res.status(200).json({ success: true, email: auth.email });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).end('Method Not Allowed');
    }
    if (!checkCsrf(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body || {};
    const supabase = getSupabase();
    const ip = clientIp(req);

    if (body.action === 'login') {
      const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
      const password = String(body.password || '').slice(0, 200);
      if (!email || !password) return res.status(400).json({ success: false, error: 'メールアドレスとパスワードを入力してください' });

      // サインインはDB操作用とは別のクライアントで行う（ログ書き込みが利用者権限にならないように）
      const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
      if (error || !data || !data.session) {
        await writeAuditLog(supabase, { email, ip, action: 'login_failed' });
        await new Promise((r) => setTimeout(r, 800)); // 総当たり対策で少し待たせる
        return res.status(401).json({ success: false, error: 'メールアドレスまたはパスワードが違います' });
      }
      if (!isAllowedEmail(data.user.email)) {
        await writeAuditLog(supabase, { email, ip, action: 'login_denied' });
        return res.status(403).json({ success: false, error: 'このアカウントには利用権限がありません' });
      }
      setSessionCookies(res, data.session);
      await writeAuditLog(supabase, { email, ip, action: 'login' });
      return res.status(200).json({ success: true, email });
    }

    if (body.action === 'logout') {
      const cookieHeader = String(req.headers.cookie || '');
      const m = cookieHeader.match(/(?:^|;\s*)mc_at=([^;]+)/);
      let email = '';
      if (m) {
        try {
          const token = decodeURIComponent(m[1]);
          const { data } = await supabase.auth.getUser(token);
          email = data && data.user ? data.user.email : '';
          await supabase.auth.admin.signOut(token);
        } catch (e) { /* 期限切れなどは無視してCookieだけ消す */ }
      }
      clearSessionCookies(res);
      if (email) await writeAuditLog(supabase, { email, ip, action: 'logout' });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: '不明な操作です' });
  } catch (err) {
    console.error('Auth API Error:', err);
    return res.status(500).json({ success: false, error: 'ログイン処理に失敗しました' });
  }
}
