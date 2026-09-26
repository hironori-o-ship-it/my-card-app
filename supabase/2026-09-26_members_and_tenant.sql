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

-- 2) 名刺に「どの台帳のものか」を持たせる。既存の名刺はすべて小田島組
alter table public.cards add column if not exists tenant text not null default 'odashima';
create index if not exists cards_tenant_idx on public.cards (tenant, created_at desc);

-- 3) 操作ログにも台帳を記録
alter table public.audit_logs add column if not exists tenant text not null default '';

-- 4) 管理者を「小田島組」の台帳に結び付ける（既に自分専用の台帳ができていても小田島組に戻す）
insert into public.members (email, tenant, tenant_name)
values ('hironori-o@odashima.co.jp', 'odashima', '小田島組 営業専用スマート名刺台帳')
on conflict (email) do update set tenant = excluded.tenant, tenant_name = excluded.tenant_name;

-- ▼ 知人（モニター）は Authentication > Users でアカウントを作るだけでよい。
--   初めてログインしたときに、その人専用の台帳が自動で作られる。
-- ▼ 社内の人を「小田島組」の台帳に入れたいときだけ、次のひな形で1行足す（ログイン前でも後でもよい）
-- insert into public.members (email, tenant, tenant_name)
-- values ('社内の人のメールアドレス（小文字）', 'odashima', '小田島組 営業専用スマート名刺台帳')
-- on conflict (email) do update set tenant = excluded.tenant, tenant_name = excluded.tenant_name;
