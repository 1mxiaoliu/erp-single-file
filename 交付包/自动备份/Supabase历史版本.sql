-- ════════════════════════════════════════════════════════════
--  进销存 ERP · 云端自动留历史版本
--
--  作用：每次有设备保存数据，旧的版本自动存进 erp_doc_history。
--        出事了可以回到「几小时前」「昨天」「上周」的样子。
--
--  用法：Supabase 控制台 → 左侧 SQL Editor → New query
--        → 把下面整段粘进去 → 点 Run
--  跑完应该看到：Success. No rows returned
--
--  这段可以重复跑，不会报错，也不会动你现有的数据。
-- ════════════════════════════════════════════════════════════

-- 1) 历史版本表（只给触发器写，不给网页读）
create table if not exists public.erp_doc_history (
  id        bigserial primary key,
  ver       bigint,
  doc       jsonb  not null,
  saved_at  timestamptz not null default now()
);

create index if not exists erp_doc_history_saved_at_idx
  on public.erp_doc_history (saved_at desc);

-- 2) 前端 key 一律不许碰这张表（历史账目只有你本人在后台能看）
alter table public.erp_doc_history enable row level security;

-- 3) 核心：保存前把旧版本存一份
create or replace function public.erp_doc_archive()
returns trigger
language plpgsql
security definer                 -- 以表所有者的身份写，绕过上面的 RLS
set search_path = public
as $$
begin
  -- 内容真的变了才存（避免没改动也堆一条）
  if new.doc is distinct from old.doc then
    insert into public.erp_doc_history (ver, doc, saved_at)
    values (old.ver, old.doc, now());

    -- 保留策略：
    -- · 最近 24 小时：每次保存都留着（能精确回到出错的上一分钟）
    -- · 24 小时以前：每天只留最后一版
    -- · 超过 180 天：删掉
    delete from public.erp_doc_history h
      using public.erp_doc_history k
     where h.saved_at < now() - interval '24 hours'
       and k.saved_at::date = h.saved_at::date
       and k.saved_at > h.saved_at;

    delete from public.erp_doc_history
     where saved_at < now() - interval '180 days';
  end if;

  return new;
end $$;

-- 4) 挂到主表上（重复执行只会重新挂一次）
drop trigger if exists erp_doc_archive on public.erp_doc;

create trigger erp_doc_archive
  before update on public.erp_doc
  for each row
  execute function public.erp_doc_archive();


-- ════════════════════════════════════════════════════════════
--  验证：跑完上面整段后，把下面三行取消注释，再点一次 Run
-- ════════════════════════════════════════════════════════════
-- select count(*) as 版本数,
--        pg_size_pretty(coalesce(sum(pg_column_size(doc)),0)::bigint) as 占用
--   from public.erp_doc_history;
