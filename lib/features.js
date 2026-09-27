// GAS版と同じ機能（画面の google.script.run の呼び出し名と同じ名前・同じ返し方）を、Supabase の上で動かす
// 画面は /api/rpc に { fn, args } を送り、ここの関数が答える。どの関数も、ログインした本人の台帳（とチームの台帳）しか触らない
import { writeAuditLog } from './auth.js';
import { clip, normalizeStatus, STATUSES } from './cards.js';
import { addOcrUsage, checkOcrLimit, readUsage, monthKeyJst } from './usage.js';

const DEFAULT_GROUPS = ['主要取引先', '見込み客', '協力会社', 'その他'];
const LIST_COLUMNS = 'id, owner, tenant, status, memo, group, company, company_kana, department, title, name, name_kana, address, phone, mobile, email, website, created_at, updated_at, met_date, met_place, next_contact, trashed_at, has_file, has_avatar';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const AI_PRICE = { MODEL: 'gemini-2.5-flash', USD_PER_M_INPUT: 0.30, USD_PER_M_OUTPUT: 2.50, JPY_PER_USD: 150 };
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=';

// ===== 共通 =====
function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = parseInt(String(raw).trim(), 10);
  if (isNaN(n)) return fallback;
  return n <= 0 ? null : n;
}
function trashRetentionDays() { const n = positiveIntEnv('TRASH_RETENTION_DAYS', 30); return n || 30; }
function askMonthlyLimit() { return positiveIntEnv('ASK_MONTHLY_LIMIT', 5); }

function jstParts(date) {
  const d = new Date((date ? new Date(date) : new Date()).getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return { ymd: d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()), hms: p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) };
}
function todayJst() { return jstParts().ymd; }
function jstDateTime(value) { if (!value) return ''; const t = new Date(value); if (isNaN(t.getTime())) return String(value); const p = jstParts(t); return p.ymd + ' ' + p.hms; }
function cleanDate(v) { const m = String(v || '').trim().match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/); return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : ''; }

class UserError extends Error {}

// ledger: 'shared' ならチームの台帳（members.team）、それ以外は本人の台帳
function ledgerTenant(auth, ledger) {
  if (ledger === 'shared') {
    if (!auth.team) throw new UserError('チームの名刺を見る権限がありません。管理者に共有を依頼してください。');
    return auth.team;
  }
  return auth.tenant;
}
function isShared(ledger) { return ledger === 'shared'; }

function friendly(err) {
  if (err instanceof UserError) return err.message;
  console.error('RPC error:', err);
  return '処理に失敗しました。時間をおいて再度お試しください';
}

async function log(auth, ledger, action, cards, detail) {
  let tenant = auth.tenant;
  try { tenant = ledgerTenant(auth, ledger); } catch (e) { /* チームが無ければ本人の台帳に残す */ }
  const list = (cards || []).map((c) => ({ id: c.id || '', name: c.name || '', company: c.company || '' }));
  await writeAuditLog(auth.supabase, { email: auth.email, tenant, ip: auth.ip, action, targetIds: list.map((c) => c.id).filter(Boolean), detail: { cards: list.slice(0, 50), note: detail || '' } });
}

async function must(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

function brief(r) {
  return { id: String(r.id || ''), owner: String(r.owner || ''), status: String(r.status || '現役'), company: String(r.company || ''), name: String(r.name || ''), title: String(r.title || ''), department: String(r.department || ''), email: String(r.email || ''), createdAt: jstDateTime(r.created_at) };
}

// 画像は一覧に載せず、印（f-名刺ID / a-名刺ID）だけを渡す。表示は apiGetImageData で本人の権限を確かめてから
function toCard(r) {
  return {
    id: String(r.id), owner: String(r.owner || ''), status: String(r.status || '現役'), memo: String(r.memo || ''), group: String(r.group || '主要取引先'),
    company: r.company || '', company_kana: r.company_kana || '', department: r.department || '', title: r.title || '',
    name: r.name || '', name_kana: r.name_kana || '', address: r.address || '', phone: r.phone || '', mobile: r.mobile || '',
    email: r.email || '', website: r.website || '',
    fileId: r.has_file ? 'f-' + r.id : '',
    fileUrl: r.has_file ? '/api/cards/image?id=' + encodeURIComponent(r.id) : '',
    avatarUrl: r.has_avatar ? '/api/cards/image?kind=avatar&id=a-' + r.id : '',
    createdAt: jstDateTime(r.created_at),
    metDate: r.met_date || '', metPlace: r.met_place || '', nextContact: r.next_contact || '',
    trashedAt: jstDateTime(r.trashed_at),
    customFields: {}
  };
}

async function readGroups(auth, tenant, rows) {
  const groups = DEFAULT_GROUPS.slice();
  const data = await must(auth.supabase.from('ledger_groups').select('name').eq('tenant', tenant).order('created_at', { ascending: true }));
  (data || []).forEach((g) => { if (g.name && !groups.includes(g.name)) groups.push(g.name); });
  (rows || []).forEach((c) => { if (c.group && !groups.includes(c.group)) groups.push(c.group); });
  return groups;
}

async function readPrivateMemos(auth, ids) {
  if (!ids.length) return {};
  const data = await must(auth.supabase.from('card_private_memos').select('card_id, memo').eq('email', auth.email).in('card_id', ids));
  const map = {};
  (data || []).forEach((m) => { map[m.card_id] = m.memo || ''; });
  return map;
}

async function setPrivateMemo(auth, cardId, memo) {
  const text = String(memo || '').slice(0, 20000);
  if (text) await must(auth.supabase.from('card_private_memos').upsert({ card_id: cardId, email: auth.email, memo: text, updated_at: new Date().toISOString() }, { onConflict: 'card_id,email' }));
  else await must(auth.supabase.from('card_private_memos').delete().eq('card_id', cardId).eq('email', auth.email));
}

async function findRow(auth, tenant, id, columns) {
  return must(auth.supabase.from('cards').select(columns || LIST_COLUMNS).eq('tenant', tenant).eq('id', clip(id, 200)).maybeSingle());
}

// ===== ゴミ箱：〇日たったら自動で完全に削除 =====
async function purgeExpiredTrash(auth, ledger, tenant) {
  const rows = await must(auth.supabase.from('cards').select('id, name, company, trashed_at').eq('tenant', tenant).eq('status', 'ゴミ箱'));
  const days = trashRetentionDays();
  const limit = Date.now() - days * 24 * 3600 * 1000;
  const noDate = [], expired = [];
  (rows || []).forEach((r) => {
    if (!r.trashed_at) noDate.push(r.id); // 以前ゴミ箱に入れた名刺は、今日から数え始める
    else if (new Date(r.trashed_at).getTime() < limit) expired.push(r);
  });
  if (noDate.length) await must(auth.supabase.from('cards').update({ trashed_at: new Date().toISOString() }).eq('tenant', tenant).in('id', noDate));
  if (!expired.length) return 0;
  const ids = expired.map((r) => r.id);
  await must(auth.supabase.from('cards').delete().eq('tenant', tenant).in('id', ids));
  await must(auth.supabase.from('card_private_memos').delete().in('card_id', ids));
  await log(auth, ledger, '自動削除（ゴミ箱' + days + '日経過）', expired, '');
  return expired.length;
}

// ===== AI利用料の概算（本人ごと） =====
async function readAiUsage(auth) {
  const row = await must(auth.supabase.from('ai_usage').select('*').eq('email', auth.email).maybeSingle());
  return row || { email: auth.email, month_key: '', month_count: 0, month_yen: 0, total_count: 0, total_yen: 0, since: '', last_reset: '', ask_month_key: '', ask_count: 0 };
}

async function recordAiUsage(auth, json, extra) {
  try {
    const meta = (json && json.usageMetadata) || {};
    const inputTokens = Number(meta.promptTokenCount || 0);
    const outputTokens = Number(meta.candidatesTokenCount || 0) + Number(meta.thoughtsTokenCount || 0);
    const yen = (inputTokens * AI_PRICE.USD_PER_M_INPUT + outputTokens * AI_PRICE.USD_PER_M_OUTPUT) / 1000000 * AI_PRICE.JPY_PER_USD;
    const u = await readAiUsage(auth);
    const month = monthKeyJst();
    if (u.month_key !== month) { u.month_key = month; u.month_count = 0; u.month_yen = 0; }
    if (!u.since) u.since = todayJst();
    u.month_count += 1; u.month_yen += yen; u.total_count += 1; u.total_yen += yen;
    Object.assign(u, extra || {});
    u.email = auth.email;
    await must(auth.supabase.from('ai_usage').upsert(u, { onConflict: 'email' }));
  } catch (e) {
    console.error('AI usage record error:', e && e.message); // 記録に失敗しても本来の操作は止めない
  }
}

async function usageSummary(auth) {
  const u = await readAiUsage(auth);
  const same = u.month_key === monthKeyJst();
  const ocr = await readUsage(auth.supabase, auth.tenant);
  return {
    success: true,
    ocrLimit: auth.ocrLimit === undefined ? null : auth.ocrLimit,
    ocrMonthCount: ocr.monthCount,
    monthCount: same ? u.month_count : 0, monthYen: same ? u.month_yen : 0,
    totalCount: u.total_count || 0, totalYen: u.total_yen || 0,
    since: u.since || '', lastReset: u.last_reset || '', price: AI_PRICE
  };
}

// ===== 重複チェック（同じメールアドレス、または同じ氏名＋同じ会社） =====
function normName(s) { return String(s || '').replace(/[\s　・,.，．]/g, '').toLowerCase(); }
function normCompany(s) { return normName(s).replace(/株式会社|有限会社|合同会社|\(株\)|（株）|㈱/g, ''); }
function isSamePerson(a, b) {
  const ea = String(a.email || '').trim().toLowerCase(), eb = String(b.email || '').trim().toLowerCase();
  if (ea && eb && ea === eb) return true;
  const na = normName(a.name), nb = normName(b.name);
  if (!na || na !== nb) return false;
  const ca = normCompany(a.company), cb = normCompany(b.company);
  return !ca || !cb || ca === cb;
}

// ===== 画面から呼ばれる関数（名前と返し方はGAS版と同じ） =====
export const functions = {
  async apiGetCardsFromSheet(auth, ledger) {
    const ledgerName = isShared(ledger) ? 'shared' : 'personal';
    const sharedInfo = { configured: true, available: !!auth.team, url: '', folderUrl: '' };
    try {
      const tenant = ledgerTenant(auth, ledger);
      let purged = 0;
      try { purged = await purgeExpiredTrash(auth, ledger, tenant); } catch (e) { console.error('purge error:', e && e.message); }
      const rows = await must(auth.supabase.from('cards').select(LIST_COLUMNS).eq('tenant', tenant).order('created_at', { ascending: false }));
      const cards = (rows || []).map(toCard);
      if (isShared(ledger)) {
        const memos = await readPrivateMemos(auth, cards.map((c) => c.id));
        cards.forEach((c) => { c.privateMemo = memos[c.id] || ''; });
      }
      await writeAuditLog(auth.supabase, { email: auth.email, tenant, ip: auth.ip, action: 'list_cards', detail: { count: cards.length } });
      return JSON.stringify({
        success: true, count: cards.length, cards, customHeaders: [], spreadsheetUrl: '', ledger: ledgerName,
        groups: await readGroups(auth, tenant, cards), trashRetentionDays: trashRetentionDays(), purgedCount: purged,
        logUrl: '#operation-log', sharedInfo, personalFolderUrl: '',
        me: { email: auth.email, tenantName: auth.tenantName, teamName: auth.teamName }
      });
    } catch (err) {
      return JSON.stringify({ success: false, error: friendly(err), cards: [], customHeaders: [], ledger: ledgerName, sharedInfo });
    }
  },

  async apiUpdateCard(auth, card, ledger) {
    try {
      if (!card || !card.id) return { success: false, error: '名刺IDが指定されていません' };
      const tenant = ledgerTenant(auth, ledger);
      const update = { updated_at: new Date().toISOString() };
      ['company', 'company_kana', 'department', 'title', 'name', 'name_kana', 'address', 'phone', 'mobile', 'email', 'website'].forEach((f) => { update[f] = clip(card[f], 500); });
      update.memo = clip(card.memo, 20000);
      update.group = clip(card.group, 30) || '主要取引先';
      if (card.metDate !== undefined) update.met_date = cleanDate(card.metDate);
      if (card.metPlace !== undefined) update.met_place = clip(card.metPlace, 200);
      if (card.nextContact !== undefined) update.next_contact = cleanDate(card.nextContact);
      const data = await must(auth.supabase.from('cards').update(update).eq('tenant', tenant).eq('id', clip(card.id, 200)).select('id'));
      if (!data || !data.length) return { success: false, error: '更新対象の名刺が見つかりません' };
      if (isShared(ledger) && card.privateMemo !== undefined) await setPrivateMemo(auth, String(card.id), card.privateMemo);
      await log(auth, ledger, '編集', [{ id: card.id, name: update.name, company: update.company }], '');
      return { success: true };
    } catch (err) {
      return { success: false, error: friendly(err) };
    }
  },

  async apiUpdateCardsStatus(auth, cardIds, newStatus, ledger) {
    try {
      if (!Array.isArray(cardIds) || !cardIds.length) return { success: true };
      if (!STATUSES.includes(newStatus)) return { success: false, error: '状態の指定が正しくありません' };
      if (cardIds.length > 1000) return { success: false, error: '一度に変更できる件数を超えています' };
      const tenant = ledgerTenant(auth, ledger);
      const now = new Date().toISOString();
      const data = await must(auth.supabase.from('cards').update({ status: newStatus, updated_at: now, trashed_at: newStatus === 'ゴミ箱' ? now : null })
        .eq('tenant', tenant).in('id', cardIds.map((id) => clip(id, 200))).select('id, name, company'));
      if (data && data.length) await log(auth, ledger, newStatus === '現役' ? '現役に戻す' : newStatus + 'へ移動', data, '');
      return { success: true };
    } catch (err) {
      return { success: false, error: friendly(err) };
    }
  },

  // 名刺の読み取りは、いつも有料版のAI（Gemini。入力はAIの学習に使われない）
  async apiSaveImageToDriveAndOcr(auth, base64Image, optionalFileName, ledger) {
    try {
      const tenant = ledgerTenant(auth, ledger);
      if (!base64Image || typeof base64Image !== 'string') return JSON.stringify({ success: false, error: '画像データが送信されていません' });
      const header = base64Image.match(/^data:([^;,]+);base64,/);
      if (!header || !IMAGE_TYPES.includes(header[1].toLowerCase())) return JSON.stringify({ success: false, error: '画像の形式に対応していません（JPEG / PNG / WebP）' });
      const quota = await checkOcrLimit(auth);
      if (!quota.allowed) {
        await writeAuditLog(auth.supabase, { email: auth.email, tenant: auth.tenant, ip: auth.ip, action: 'ocr_limit_reached', detail: { monthCount: quota.monthCount, limit: quota.limit } });
        return JSON.stringify({ success: false, limitReached: true, error: '今月のAI読み取り上限（' + quota.limit + '枚）に達しました。来月1日から再び使えます。CSV取込や名刺の編集はこのまま使えます。' });
      }
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return JSON.stringify({ success: false, error: 'AIの設定がされていません。管理者に連絡してください' });

      const systemInstruction = '日本のビジネス名刺画像を解析し、JSONスキーマに従って精密に出力してください。複数枚並べて撮影されている場合は配列の中に全てのカードを抽出してください。会社名と氏名のひらがな（company_kana, name_kana）を推測付与し、市外局番と携帯番号を分別してください。未記載は空文字列にしてください。';
      const props = {};
      ['company', 'company_kana', 'department', 'title', 'name', 'name_kana', 'address', 'phone', 'mobile', 'email', 'website'].forEach((k) => { props[k] = { type: 'STRING' }; });
      const body = {
        contents: [{ parts: [{ text: systemInstruction }, { inlineData: { mimeType: header[1].toLowerCase(), data: base64Image.slice(header[0].length) } }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { cards: { type: 'ARRAY', items: { type: 'OBJECT', properties: props, required: ['company', 'name'] } } }, required: ['cards'] } }
      };
      const res = await fetch(GEMINI_URL + apiKey, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        console.error('Gemini API Error (' + res.status + '): ' + await res.text());
        return JSON.stringify({ success: false, error: 'AIの読み取りに失敗しました。時間をおいて再度お試しください' });
      }
      const json = await res.json();
      const monthCount = await addOcrUsage(auth); // AIが応答した時点で1枚と数える（読み取れなくても費用はかかるため）
      await recordAiUsage(auth, json);
      let cards = [];
      try { cards = JSON.parse(json.candidates[0].content.parts[0].text).cards || []; } catch (e) { cards = []; }
      if (!cards.length) return JSON.stringify({ success: false, error: '名刺を読み取れませんでした。明るい場所で、名刺全体が写るように撮り直してください', usage: { monthCount, limit: auth.ocrLimit } });

      const existing = await must(auth.supabase.from('cards').select('id, owner, status, company, name, title, department, email, created_at').eq('tenant', tenant));
      const now = new Date();
      const saved = [];
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        const row = {
          id: 'card_' + now.getTime() + '_' + i + '_' + Math.random().toString(36).slice(2, 8),
          owner: auth.email, tenant, status: '現役', group: '主要取引先', memo: '',
          company: clip(c.company), company_kana: clip(c.company_kana), department: clip(c.department), title: clip(c.title),
          name: clip(c.name), name_kana: clip(c.name_kana), address: clip(c.address), phone: clip(c.phone), mobile: clip(c.mobile),
          email: clip(c.email), website: clip(c.website), file_url: base64Image, met_date: todayJst(), met_place: '', next_contact: ''
        };
        const dup = (existing || []).find((b) => b.status !== 'ゴミ箱' && isSamePerson(row, b));
        await must(auth.supabase.from('cards').insert(row));
        const out = { ...c, id: row.id };
        if (dup) out.duplicateOf = brief(dup);
        saved.push(out);
      }
      await log(auth, ledger, '撮影して登録', saved, '');
      return JSON.stringify({ success: true, cards: saved, fileName: optionalFileName || '', error: null, usage: { monthCount, limit: auth.ocrLimit } });
    } catch (err) {
      return JSON.stringify({ success: false, error: '保存・解析エラー: ' + friendly(err) });
    }
  },

  // 名刺を「自分の台帳」と「チームの台帳」の間で移す。チームから自分へ戻せるのは、その名刺を登録した本人だけ
  async apiMoveCards(auth, cardIds, fromLedger, toLedger) {
    try {
      fromLedger = isShared(fromLedger) ? 'shared' : 'personal';
      toLedger = isShared(toLedger) ? 'shared' : 'personal';
      if (fromLedger === toLedger) return { success: false, error: '移動先が同じです' };
      if (!Array.isArray(cardIds) || !cardIds.length) return { success: true, moved: 0, denied: 0 };
      const from = ledgerTenant(auth, fromLedger), to = ledgerTenant(auth, toLedger);
      const rows = await must(auth.supabase.from('cards').select('id, owner, name, company, memo').eq('tenant', from).in('id', cardIds.map((id) => clip(id, 200))));
      let moved = 0, denied = 0;
      const briefs = [];
      const mine = fromLedger === 'shared' ? await readPrivateMemos(auth, (rows || []).map((r) => r.id)) : {};
      for (const r of rows || []) {
        if (fromLedger === 'shared' && String(r.owner || '').toLowerCase() !== auth.email) { denied++; continue; }
        let memo = String(r.memo || '');
        if (toLedger === 'shared') {
          // これまでの商談メモは共有せず「自分だけのメモ」に残す
          if (memo) await setPrivateMemo(auth, r.id, memo);
          memo = '';
        } else {
          memo = [mine[r.id] || '', memo].filter((x) => x).join('\n');
          if (mine[r.id]) await setPrivateMemo(auth, r.id, '');
        }
        await must(auth.supabase.from('cards').update({ tenant: to, memo, updated_at: new Date().toISOString() }).eq('tenant', from).eq('id', r.id));
        briefs.push(r);
        moved++;
      }
      if (briefs.length) {
        const label = toLedger === 'shared' ? 'チームの名刺に移す' : '自分の名刺に戻す';
        await log(auth, fromLedger, label, briefs, '');
        await log(auth, toLedger, label, briefs, '');
      }
      return { success: true, moved, denied };
    } catch (err) {
      return { success: false, error: friendly(err) };
    }
  },

  async apiImportCardsFromCsv(auth, cards, ledger) {
    try {
      if (!Array.isArray(cards) || !cards.length) return { success: false, error: '取り込む名刺データがありません' };
      if (cards.length > 100) return { success: false, error: '一度に取り込める件数を超えています' };
      const tenant = ledgerTenant(auth, ledger);
      const stamp = Date.now();
      const now = new Date().toISOString();
      const rows = cards.map((src, i) => {
        src = src || {};
        const status = normalizeStatus(src.status);
        const row = { id: 'csv_' + stamp + '_' + i + '_' + Math.random().toString(36).slice(2, 8), owner: auth.email, tenant, status };
        ['group', 'company', 'company_kana', 'department', 'title', 'name', 'name_kana', 'address', 'phone', 'mobile', 'email', 'website'].forEach((f) => { row[f] = clip(src[f], 500); });
        row.group = row.group || '主要取引先';
        row.memo = clip(src.memo, 5000);
        row.met_date = cleanDate(src.metDate);
        row.met_place = clip(src.metPlace, 200);
        row.next_contact = cleanDate(src.nextContact);
        row.trashed_at = status === 'ゴミ箱' ? now : null;
        return row;
      });
      await must(auth.supabase.from('cards').insert(rows));
      await log(auth, ledger, '外部CSVを取り込み', [], rows.length + '件');
      return { success: true, importedCount: rows.length };
    } catch (err) {
      return { success: false, error: '外部データの登録に失敗しました: ' + friendly(err) };
    }
  },

  async apiGetAiUsage(auth) {
    try { return await usageSummary(auth); } catch (err) { console.error(err); return { success: false, error: '利用状況を読み込めませんでした' }; }
  },

  // 表示を0に戻すだけ（月の上限の数え方 ocr_usage とは別なので、上限は外れない）
  async apiResetAiUsage(auth) {
    try {
      const u = await readAiUsage(auth);
      const today = todayJst();
      await must(auth.supabase.from('ai_usage').upsert({ ...u, email: auth.email, month_key: monthKeyJst(), month_count: 0, month_yen: 0, total_count: 0, total_yen: 0, since: today, last_reset: today }, { onConflict: 'email' }));
      return await usageSummary(auth);
    } catch (err) {
      console.error(err);
      return { success: false, error: 'リセットできませんでした' };
    }
  },

  // 顔写真の登録（AIは使わない）。画面で400px四方に切り抜いた画像を受け取る
  async apiSaveAvatarImage(auth, cardId, base64Image, ledger) {
    try {
      if (!cardId || !base64Image) return JSON.stringify({ success: false, error: 'カードIDまたは画像データが不足しています' });
      const header = String(base64Image).match(/^data:(image\/(?:jpeg|png|webp|heic|heif));base64,/i);
      if (!header) return JSON.stringify({ success: false, error: '画像の形式に対応していません' });
      if (base64Image.length > 3 * 1024 * 1024) return JSON.stringify({ success: false, error: '画像が大きすぎます' });
      const tenant = ledgerTenant(auth, ledger);
      const data = await must(auth.supabase.from('cards').update({ avatar_url: base64Image, updated_at: new Date().toISOString() }).eq('tenant', tenant).eq('id', clip(cardId, 200)).select('id, name, company'));
      if (!data || !data.length) return JSON.stringify({ success: false, error: '名刺が見つかりません' });
      await log(auth, ledger, '顔写真を登録', data, '');
      return JSON.stringify({ success: true, cardId, avatarUrl: '/api/cards/image?kind=avatar&id=a-' + cardId });
    } catch (err) {
      return JSON.stringify({ success: false, error: friendly(err) });
    }
  },

  async apiRemoveAvatar(auth, cardId, ledger) {
    try {
      const tenant = ledgerTenant(auth, ledger);
      const data = await must(auth.supabase.from('cards').update({ avatar_url: '', updated_at: new Date().toISOString() }).eq('tenant', tenant).eq('id', clip(cardId, 200)).select('id, name, company'));
      if (!data || !data.length) return { success: false, error: '名刺が見つかりません' };
      await log(auth, ledger, '顔写真を外す', data, '');
      return { success: true };
    } catch (err) {
      return { success: false, error: friendly(err) };
    }
  },

  // f-名刺ID = 名刺原本、a-名刺ID = 顔写真。本人の台帳か、本人が入っているチームの台帳のものだけ返す
  async apiGetImageData(auth, token) {
    try {
      const m = String(token || '').match(/^([fa])-(.+)$/);
      if (!m) return { success: false, error: '画像がありません' };
      const column = m[1] === 'a' ? 'avatar_url' : 'file_url';
      const tenants = [auth.tenant].concat(auth.team ? [auth.team] : []);
      const row = await must(auth.supabase.from('cards').select('id, tenant, ' + column).in('tenant', tenants).eq('id', clip(m[2], 200)).maybeSingle());
      const value = row ? String(row[column] || '') : '';
      const mm = value.match(/^data:([^;,]+);base64,/);
      if (!mm || !IMAGE_TYPES.concat(['image/gif']).includes(mm[1].toLowerCase())) return { success: false, error: 'この画像は表示できません' };
      await writeAuditLog(auth.supabase, { email: auth.email, tenant: row.tenant, ip: auth.ip, action: column === 'avatar_url' ? 'view_avatar' : 'view_card_image', targetIds: [row.id] });
      return { success: true, dataUrl: value };
    } catch (err) {
      console.error(err);
      return { success: false, error: '画像を読み込めませんでした' };
    }
  },

  // ゴミ箱の名刺を今すぐ完全に削除する（チームの名刺は、登録した本人だけ）
  async apiDeleteCardsPermanently(auth, cardIds, ledger) {
    try {
      if (!Array.isArray(cardIds) || !cardIds.length) return { success: true, deleted: 0, denied: 0 };
      const tenant = ledgerTenant(auth, ledger);
      const rows = await must(auth.supabase.from('cards').select('id, owner, status, name, company').eq('tenant', tenant).in('id', cardIds.map((id) => clip(id, 200))));
      let denied = 0;
      const targets = (rows || []).filter((r) => {
        if (r.status !== 'ゴミ箱') return false;
        if (isShared(ledger) && String(r.owner || '').toLowerCase() !== auth.email) { denied++; return false; }
        return true;
      });
      if (targets.length) {
        const ids = targets.map((r) => r.id);
        await must(auth.supabase.from('cards').delete().eq('tenant', tenant).in('id', ids));
        await must(auth.supabase.from('card_private_memos').delete().in('card_id', ids));
        await log(auth, ledger, '完全に削除', targets, '');
      }
      return { success: true, deleted: targets.length, denied };
    } catch (err) {
      return { success: false, error: friendly(err) };
    }
  },

  async apiAddGroup(auth, name, ledger) {
    try {
      const g = String(name || '').trim().slice(0, 30);
      if (!g) return { success: false, error: 'グループ名を入力してください' };
      const tenant = ledgerTenant(auth, ledger);
      const groups = await readGroups(auth, tenant, []);
      if (!groups.includes(g)) await must(auth.supabase.from('ledger_groups').upsert({ tenant, name: g }, { onConflict: 'tenant,name' }));
      await log(auth, ledger, 'グループを追加', [], g);
      return { success: true, groups: await readGroups(auth, tenant, []), added: g };
    } catch (err) {
      return { success: false, error: friendly(err) };
    }
  },

  async apiFindDuplicates(auth, ledger) {
    try {
      const tenant = ledgerTenant(auth, ledger);
      const rows = (await must(auth.supabase.from('cards').select('id, owner, status, company, name, title, department, email, created_at').eq('tenant', tenant).order('created_at', { ascending: true }))) || [];
      const pairs = [], used = {};
      for (let i = 0; i < rows.length; i++) {
        const a = rows[i];
        if (a.status === 'ゴミ箱' || used[a.id]) continue;
        for (let j = i + 1; j < rows.length; j++) {
          const b = rows[j];
          if (b.status === 'ゴミ箱' || used[b.id]) continue;
          if (isSamePerson(a, b)) { pairs.push({ keep: brief(a), newer: brief(b) }); used[b.id] = true; }
        }
      }
      return { success: true, pairs };
    } catch (err) {
      return { success: false, error: friendly(err) };
    }
  },

  // 新しい名刺の内容で古い名刺を置き換える。前の会社・部署・役職は商談メモに履歴として残し、新しい名刺は消す
  async apiMergeDuplicate(auth, newId, oldId, ledger) {
    try {
      if (!newId || !oldId || String(newId) === String(oldId)) return { success: false, error: 'まとめる名刺の指定が正しくありません' };
      const tenant = ledgerTenant(auth, ledger);
      const cols = LIST_COLUMNS + ', file_url, avatar_url';
      const nw = await findRow(auth, tenant, newId, cols), od = await findRow(auth, tenant, oldId, cols);
      if (!nw || !od) return { success: false, error: '名刺が見つかりません' };
      const before = [od.company, od.department, od.title].map((x) => String(x || '').trim());
      const after = [nw.company, nw.department, nw.title].map((x) => String(x || '').trim());
      let memo = String(od.memo || '');
      if (before.join('|') !== after.join('|')) {
        const line = '【' + todayJst().replace(/-/g, '/') + '】名刺を更新（前：' + before.filter((x) => x).join(' ') + '）';
        memo = memo ? line + '\n' + memo : line;
      }
      if (String(nw.memo || '').trim()) memo = String(nw.memo).trim() + '\n' + memo;
      const update = { memo, updated_at: new Date().toISOString() };
      ['company', 'company_kana', 'department', 'title', 'name', 'name_kana', 'address', 'phone', 'mobile', 'email', 'website'].forEach((f) => { if (String(nw[f] || '').trim()) update[f] = nw[f]; });
      if (nw.file_url) update.file_url = nw.file_url;
      if (cleanDate(nw.met_date) > cleanDate(od.met_date)) update.met_date = cleanDate(nw.met_date);
      if (String(nw.met_place || '').trim()) update.met_place = nw.met_place;
      if (nw.avatar_url && !od.avatar_url) update.avatar_url = nw.avatar_url;
      await must(auth.supabase.from('cards').update(update).eq('tenant', tenant).eq('id', od.id));
      await must(auth.supabase.from('cards').delete().eq('tenant', tenant).eq('id', nw.id));
      await log(auth, ledger, '重複をまとめる', [od], '新しい名刺 ' + newId + ' の内容で置き換え');
      return { success: true, keptId: String(oldId) };
    } catch (err) {
      return { success: false, error: friendly(err) };
    }
  },

  // 錦織教授への質問（有料・最後の手段）：使い方ガイドとよくある質問の文面だけをもとにAIが答える。名刺データは送らない
  async apiAskProfessor(auth, question, manualText) {
    try {
      const q = String(question || '').trim().slice(0, 500);
      if (!q) return { success: false, error: '質問を入力してください' };
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return { success: false, error: 'AIの設定がされていません。管理者に連絡してください' };
      const limit = askMonthlyLimit();
      const u = await readAiUsage(auth);
      const month = monthKeyJst();
      const used = u.ask_month_key === month ? (u.ask_count || 0) : 0;
      if (limit !== null && used >= limit) return { success: false, limitReached: true, error: '今月の錦織教授への質問の上限（' + limit + '回）に達しました。来月1日から再び使えます。' };
      const manual = String(manualText || '').slice(0, 40000);
      const instruction = 'あなたは名刺管理アプリ「らくらく名刺管理」の案内役「錦織教授」です。落ち着いた丁寧な口調で、日本語で、専門用語を避けて答えてください。' +
        '答えは次の【使い方ガイド】に書かれている機能・操作だけをもとにし、書かれていない機能は「このアプリにはその機能はありません」と正直に伝えてください。' +
        '操作は、押すボタンの名前と順番を具体的に示してください。300文字程度までにまとめてください。';
      const res = await fetch(GEMINI_URL + apiKey, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: instruction + '\n\n【使い方ガイド】\n' + manual }, { text: '【質問】\n' + q }] }], generationConfig: { temperature: 0.2 } })
      });
      if (!res.ok) return { success: false, error: '錦織教授がいま答えられません。時間をおいてお試しください' };
      const json = await res.json();
      await recordAiUsage(auth, json, { ask_month_key: month, ask_count: used + 1 });
      const parts = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
      const answer = parts ? parts.map((p) => p.text || '').join('') : '';
      await writeAuditLog(auth.supabase, { email: auth.email, tenant: auth.tenant, ip: auth.ip, action: 'ask_professor' });
      return { success: true, answer: answer || 'うまくお答えできませんでした。質問を言い換えてお試しください。', used: used + 1, limit };
    } catch (err) {
      return { success: false, error: friendly(err) };
    }
  },

  // 操作記録（Web版だけ。GAS版のスプレッドシート「操作記録」の代わりに画面で見る）
  async apiGetLogs(auth, ledger) {
    try {
      const tenant = ledgerTenant(auth, ledger);
      const rows = await must(auth.supabase.from('audit_logs').select('at, user_email, action, target_ids, detail').eq('tenant', tenant).order('at', { ascending: false }).limit(300));
      const hidden = ['list_cards', 'view_card_image', 'view_avatar'];
      return { success: true, logs: (rows || []).filter((r) => !hidden.includes(r.action)).map((r) => ({ at: jstDateTime(r.at), email: r.user_email, action: r.action, cards: (r.detail && r.detail.cards) || [], note: (r.detail && r.detail.note) || '' })) };
    } catch (err) {
      return { success: false, error: friendly(err) };
    }
  }
};
