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

-- 4) 管理者（小田島組）を名簿に登録
insert into public.members (email, tenant, tenant_name)
values ('hironori-o@odashima.co.jp', 'odashima', '小田島組 営業専用スマート名刺台帳')
on conflict (email) do nothing;

-- ▼ 知人（モニター）を追加するときのひな形（Authentication > Users でアカウントを作ってから実行）
--   tenant は人ごとに別の記号にする（同じ会社の人どうしで共有したいときだけ同じ記号にする）
-- insert into public.members (email, tenant, tenant_name)
-- values ('知人のメールアドレス（小文字）', 'monitor_01', '〇〇さんの名刺台帳');
