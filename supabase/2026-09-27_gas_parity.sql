-- 2026-09-27 GAS版と同じ機能にそろえる（チームの名刺・自分だけのメモ・グループ・名刺交換日・次回連絡日・ゴミ箱の自動削除・AI利用状況・錦織教授への質問）
-- Supabase の SQL Editor に貼り付けて「Run」してください（何度実行しても安全です）
-- 先に 2026-09-26_login_and_audit.sql と 2026-09-26_members_and_tenant.sql を実行しておいてください

-- 1) 名刺に項目を足す（名刺交換日・交換場所・次回連絡日は「2026-09-27」の形の文字、ゴミ箱に入れた日時）
alter table public.cards add column if not exists met_date text not null default '';
alter table public.cards add column if not exists met_place text not null default '';
alter table public.cards add column if not exists next_contact text not null default '';
alter table public.cards add column if not exists trashed_at timestamptz;
-- 一覧を軽くするため、画像そのものは一覧に載せず「画像があるか」だけを持つ（自動で計算される）
alter table public.cards add column if not exists has_file boolean generated always as (coalesce(file_url, '') <> '') stored;
alter table public.cards add column if not exists has_avatar boolean generated always as (coalesce(avatar_url, '') <> '') stored;

-- 2) チームの名刺：同じ team の記号を持つ人どうしが、チームの名刺を一緒に見られる（空ならチームの名刺は使えない）
alter table public.members add column if not exists team text not null default '';
alter table public.members add column if not exists team_name text not null default '';

-- 3) チームの名刺に付ける「自分だけのメモ」（本人しか見られない）
create table if not exists public.card_private_memos (
  card_id text not null,
  email text not null,
  memo text not null default '',
  updated_at timestamptz not null default now(),
  primary key (card_id, email)
);
alter table public.card_private_memos enable row level security;

-- 4) 自分で追加したグループ（台帳ごと）
create table if not exists public.ledger_groups (
  tenant text not null,
  name text not null,
  created_at timestamptz not null default now(),
  primary key (tenant, name)
);
alter table public.ledger_groups enable row level security;

-- 5) AI利用状況の概算（本人ごと）と、錦織教授への質問の回数（本人ごと・月5問まで）
create table if not exists public.ai_usage (
  email text primary key,
  month_key text not null default '',
  month_count integer not null default 0,
  month_yen double precision not null default 0,
  total_count integer not null default 0,
  total_yen double precision not null default 0,
  since text not null default '',
  last_reset text not null default '',
  ask_month_key text not null default '',
  ask_count integer not null default 0
);
alter table public.ai_usage enable row level security;

-- ▼ チームの名刺を使う人を決める（例：小田島組のチーム）。同じ記号の人どうしがチームの名刺を共有する
-- update public.members set team = 'team_odashima', team_name = '小田島組 チームの名刺' where email in ('hironori-o@odashima.co.jp');
-- ▼ 外すとき
-- update public.members set team = '', team_name = '' where email = 'その人のメールアドレス';
