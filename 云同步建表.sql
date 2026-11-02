-- 进销存 ERP 云同步建表脚本
-- 用法：Supabase 控制台 → SQL Editor → 新建查询 → 粘贴整段 → Run（只需跑一次）

create table if not exists public.erp_doc (
  id          text primary key,
  ver         bigint      not null default 0,
  doc         jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.erp_doc enable row level security;

drop policy if exists "erp anon read"   on public.erp_doc;
drop policy if exists "erp anon insert" on public.erp_doc;
drop policy if exists "erp anon update" on public.erp_doc;

create policy "erp anon read"   on public.erp_doc for select to anon using (true);
create policy "erp anon insert" on public.erp_doc for insert to anon with check (true);
create policy "erp anon update" on public.erp_doc for update to anon using (true) with check (true);

insert into public.erp_doc (id, ver, doc)
values ('main', 0, '{}'::jsonb)
on conflict (id) do nothing;

-- 可选：确认建好了
-- select id, ver, updated_at, pg_size_pretty(pg_column_size(doc)::bigint) as doc_size from public.erp_doc;
