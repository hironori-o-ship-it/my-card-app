import { createClient } from '@supabase/supabase-js';

// ログイン状態はブラウザのJSから読めないCookie（HttpOnly）に入れる
const ACCESS_COOKIE = 'mc_at';
const REFRESH_COOKIE = 'mc_rt';
const REFRESH_MAX_AGE = 60 * 60 * 24 * 7; // 7日間操作がなければ再ログイン
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'my-card-app';

export function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase environment variables are missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

// 使ってよいメールアドレスか（既定は会社ドメインのみ）
export function isAllowedEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return false;
  const emails = String(process.env.ALLOWED_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (emails.includes(value)) return true;
  const domains = String(process.env.ALLOWED_EMAIL_DOMAINS || 'odashima.co.jp').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return domains.some((d) => value.endsWith('@' + d));
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const name = part.slice(0, i).trim();
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { out[name] = ''; }
  });
  return out;
}

function cookie(name, value, maxAge) {
  return name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAge;
}

export function setSessionCookies(res, session) {
  res.setHeader('Set-Cookie', [
    cookie(ACCESS_COOKIE, session.access_token, session.expires_in || 3600),
    cookie(REFRESH_COOKIE, session.refresh_token, REFRESH_MAX_AGE)
  ]);
}

export function clearSessionCookies(res) {
  res.setHeader('Set-Cookie', [cookie(ACCESS_COOKIE, '', 0), cookie(REFRESH_COOKIE, '', 0)]);
}

// 他サイトからの書き換え要求（CSRF）を防ぐ。GET以外は自アプリの目印ヘッダーを必須にする
export function checkCsrf(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  if (String(req.headers[CSRF_HEADER] || '') === CSRF_VALUE) return true;
  res.status(403).json({ success: false, error: '不正なリクエストです' });
  return false;
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
}

// 全APIの入口。ログインしていなければ 401 を返して null を返す
export async function requireUser(req, res) {
  if (!checkCsrf(req, res)) return null;
  res.setHeader('Cache-Control', 'no-store');
  const cookies = parseCookies(req);
  const supabase = getSupabase();
  let user = null;

  if (cookies[ACCESS_COOKIE]) {
    const { data, error } = await supabase.auth.getUser(cookies[ACCESS_COOKIE]);
    if (!error && data && data.user) user = data.user;
  }
  if (!user && cookies[REFRESH_COOKIE]) {
    // refreshSession はクライアントに利用者のセッションを載せるので、DB操作用とは別のクライアントで行う
    const { data, error } = await getSupabase().auth.refreshSession({ refresh_token: cookies[REFRESH_COOKIE] });
    if (!error && data && data.session) {
      setSessionCookies(res, data.session);
      user = data.session.user;
    }
  }

  if (!user) {
    clearSessionCookies(res);
    res.status(401).json({ success: false, needLogin: true, error: 'ログインが必要です' });
    return null;
  }
  if (!isAllowedEmail(user.email)) {
    clearSessionCookies(res);
    res.status(403).json({ success: false, needLogin: true, error: 'このアカウントには利用権限がありません' });
    return null;
  }
  return { email: String(user.email).toLowerCase(), id: user.id, supabase, ip: clientIp(req) };
}

// 操作ログ（Pマーク用）。記録に失敗しても本来の操作は止めない
export async function writeAuditLog(supabase, entry) {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      user_email: entry.email || '',
      action: entry.action,
      target_ids: entry.targetIds || [],
      detail: entry.detail || {},
      ip: entry.ip || ''
    });
    if (error) console.error('Audit log error:', error.message);
  } catch (err) {
    console.error('Audit log exception:', err);
  }
}
