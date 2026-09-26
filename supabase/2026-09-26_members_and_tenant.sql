-- 2026-09-26 利用者名簿と、会社（人）ごとの台帳分け
-- Supabase の SQL Editor に貼り付けて「Run」してください（何度実行しても安全です）
-- 今動いている本番の画面にも影響しません（既存の名刺は自動で「小田島組」の台帳に入ります）

-- 1) 利用者名簿：ここに載っている人だけがログインして使える
--    tenant = 見られる台帳の記号（同じ記号の人どうしだけが同じ名刺を見られる）
create table if not exists public.members (
  email text primary key,
  tenant text not null,
  tenant_name text not null default '',
  created_at timestamptz not null default now()
);
alter table public.members enable row level security;
-- 月のAI読み取り上限（枚・台帳全体の枚数に対して）。空（null）なら上限なし
alter table public.members add column if not exists ocr_monthly_limit integer;

-- AI読み取りの枚数（台帳ごと・月ごと）。owner に台帳の記号が入る
create table if not exists public.ocr_usage (
  owner text primary key,
  month_key text not null default '',
  month_count integer not null default 0,
  total_count integer not null default 0
);
alter table public.ocr_usage enable row level security;

-- 2) 名刺に「どの台帳のものか」を持たせる。既存の名刺はすべて小田島組
alter table public.cards add column if not exists tenant text not null default 'odashima';
create index if not exists cards_tenant_idx on public.cards (tenant, created_at desc);

-- 3) 操作ログにも台帳を記録
alter table public.audit_logs add column if not exists tenant text not null default '';

-- 4) 管理者を「小田島組」の台帳に結び付ける（既に自分専用の台帳ができていても小田島組に戻す）
--    （管理者はAI読み取りの上限なし）
insert into public.members (email, tenant, tenant_name, ocr_monthly_limit)
values ('hironori-o@odashima.co.jp', 'odashima', '小田島組 営業専用スマート名刺台帳', null)
on conflict (email) do update set tenant = excluded.tenant, tenant_name = excluded.tenant_name, ocr_monthly_limit = excluded.ocr_monthly_limit;

-- ▼ ある台帳に上限を付けるとき（例：月200枚に）
-- update public.members set ocr_monthly_limit = 200 where tenant = '台帳の記号';

-- ▼ 社内の人は Authentication > Users でアカウントを作るだけでよい。
--   初めてログインしたときに、自動で「小田島組」の台帳に入る。
-- ▼ 別の台帳に分けたい人がいるときだけ、次のひな形で1行足す（ログイン前でも後でもよい）
-- insert into public.members (email, tenant, tenant_name)
-- values ('その人のメールアドレス（小文字）', '台帳の記号（例 branch_a）', '台帳の名前')
-- on conflict (email) do update set tenant = excluded.tenant, tenant_name = excluded.tenant_name;
