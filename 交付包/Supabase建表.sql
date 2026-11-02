-- ════════════════════════════════════════════════════════════
--  进销存 ERP · Supabase 云同步建表脚本
--
--  用法：Supabase 控制台 → 左侧 SQL Editor → New query
--        → 把下面整段粘进去 → 点 Run（只需跑一次，重复跑也安全）
--
--  跑完应该看到：Success. No rows returned
--  ════════════════════════════════════════════════════════════

-- 1) 建表：整本账存成一行（id = 'main'），ver 用来防止两台设备互相覆盖
create table if not exists public.erp_doc (
  id          text primary key,
  ver         bigint      not null default 0,
  doc         jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- 2) 打开行级安全（RLS）。不开的话 Supabase 会直接拒绝匿名访问
alter table public.erp_doc enable row level security;

-- 3) 允许持有 anon / publishable key 的设备读写这一张表
--    （重复执行不会报错，所以先 drop 再 create）
drop policy if exists "erp anon read"   on public.erp_doc;
drop policy if exists "erp anon insert" on public.erp_doc;
drop policy if exists "erp anon update" on public.erp_doc;

create policy "erp anon read"   on public.erp_doc for select to anon using (true);
create policy "erp anon insert" on public.erp_doc for insert to anon with check (true);
create policy "erp anon update" on public.erp_doc for update to anon using (true) with check (true);

-- 4) 插入那唯一的一行（已存在就跳过，不会覆盖你的数据）
insert into public.erp_doc (id, ver, doc)
values ('main', 0, '{}'::jsonb)
on conflict (id) do nothing;

-- ════════════════════════════════════════════════════════════
--  跑完之后验证一下（把下面两行取消注释，再点一次 Run）
--  应该看到 1 行：id=main，ver=0（或更大的数字），doc_size 几十字节
-- ════════════════════════════════════════════════════════════
-- select id, ver, updated_at,
--        pg_size_pretty(pg_column_size(doc)::bigint) as doc_size
--   from public.erp_doc;

-- ════════════════════════════════════════════════════════════
--  说明：为什么只有一张表、一行数据？
--  这个进销存把「商品 / 往来单位 / 进货 / 销售 / 库存」全部装在一个
--  JSON 里，整本账原子写入，所以用乐观锁（ver 字段）就能保证不会
--  「两台设备各写一半」。存储占用极小，500MB 免费额度够用很多年。
-- ════════════════════════════════════════════════════════════
