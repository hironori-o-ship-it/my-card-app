-- 2026-09-26 ログイン導入・操作ログ
-- Supabase の SQL Editor に貼り付けて「Run」してください（何度実行しても安全です）

-- 1) 操作ログのテーブル（誰が・いつ・何をしたか）
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_email text not null default '',
  action text not null,
  target_ids text[] not null default '{}',
  detail jsonb not null default '{}'::jsonb,
  ip text not null default ''
);
create index if not exists audit_logs_at_idx on public.audit_logs (at desc);
create index if not exists audit_logs_user_idx on public.audit_logs (user_email, at desc);

-- 2) 行レベルセキュリティを有効にする
--    アプリのサーバー（service_role キー）だけが読み書きでき、
--    公開キー（anon）やログイン利用者が直接テーブルに触ることはできなくなる
alter table public.cards enable row level security;
alter table public.audit_logs enable row level security;
do $$ begin
  if to_regclass('public.ocr_usage') is not null then
    execute 'alter table public.ocr_usage enable row level security';
  end if;
end $$;
