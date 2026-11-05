-- Knowledge base: documents a client uploads (Markdown or plain text) that its agents answer from.
--
-- A document belongs to a client (account). It is used by every agent of that client unless its
-- agent_ids list names particular agents (null = all, empty = none). Each document is cut into
-- small passages (knowledge_chunks) when it is saved, so an agent can search them while it talks.
-- Knowledge is live: a change applies to the next call or chat, with no publish step.
--
-- Writes of a document go through knowledge_save (one transaction: the document and its passages).
-- The worker reads through knowledge_for_agent and knowledge_search with the project's secret key.

create table if not exists public.knowledge_docs (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts (id) on delete cascade,
  title       text not null check (length(title) between 1 and 200),
  filename    text not null default '' check (length(filename) <= 200),
  content     text not null check (length(content) between 1 and 200000),
  agent_ids   uuid[],
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists knowledge_docs_account on public.knowledge_docs (account_id);

create table if not exists public.knowledge_chunks (
  id       bigint generated always as identity primary key,
  doc_id   uuid not null references public.knowledge_docs (id) on delete cascade,
  idx      integer not null,
  heading  text not null default '' check (length(heading) <= 300),
  content  text not null check (length(content) between 1 and 4000),
  tsv      tsvector generated always as (to_tsvector('english', heading || ' ' || content)) stored
);
create index if not exists knowledge_chunks_doc on public.knowledge_chunks (doc_id, idx);
create index if not exists knowledge_chunks_tsv on public.knowledge_chunks using gin (tsv);

alter table public.knowledge_docs   enable row level security;
alter table public.knowledge_chunks enable row level security;

create policy knowledge_docs_read on public.knowledge_docs for select to authenticated
  using (private.has_role(account_id, array['owner', 'editor', 'viewer']));
create policy knowledge_docs_update on public.knowledge_docs for update to authenticated
  using (private.has_role(account_id, array['owner', 'editor']))
  with check (private.has_role(account_id, array['owner', 'editor']));
create policy knowledge_docs_delete on public.knowledge_docs for delete to authenticated
  using (private.has_role(account_id, array['owner', 'editor']));
create policy knowledge_chunks_read on public.knowledge_chunks for select to authenticated
  using (exists (
    select 1 from public.knowledge_docs d
    where d.id = doc_id and private.has_role(d.account_id, array['owner', 'editor', 'viewer'])
  ));

-- A signed-in person can rename a document and choose its agents directly; its text only changes
-- through knowledge_save, so the passages can never disagree with it.
revoke all on public.knowledge_docs, public.knowledge_chunks from anon, authenticated;
grant select on public.knowledge_docs, public.knowledge_chunks to authenticated;
grant update (title, agent_ids) on public.knowledge_docs to authenticated;
grant delete on public.knowledge_docs to authenticated;

-- Create a document (p_doc null) or replace one's text. p_chunks is a JSON list of
-- {"heading": "...", "content": "..."} made by the web app.
create or replace function public.knowledge_save(
  p_account uuid, p_doc uuid, p_title text, p_filename text, p_content text,
  p_agent_ids uuid[], p_chunks jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  doc uuid;
  v_title text := btrim(coalesce(p_title, ''));
  agents uuid[] := null;
  n integer;
begin
  if not private.has_role(p_account, array['owner', 'editor']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_title) not between 1 and 200 then
    raise exception 'The title must be 1 to 200 characters.' using errcode = '22023';
  end if;
  if length(coalesce(p_content, '')) not between 1 and 200000 then
    raise exception 'The document must be 1 to 200000 characters.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_chunks) is distinct from 'array'
     or jsonb_array_length(p_chunks) not between 1 and 400 then
    raise exception 'The document has no readable text.' using errcode = '22023';
  end if;
  if p_agent_ids is not null then
    select coalesce(array_agg(a.id), '{}') into agents
      from public.agents a where a.account_id = p_account and a.id = any (p_agent_ids);
  end if;

  if p_doc is null then
    select count(*) into n from public.knowledge_docs where account_id = p_account;
    if n >= 100 then
      raise exception 'A client can keep up to 100 documents. Delete one first.' using errcode = '53400';
    end if;
  end if;
  select coalesce(sum(length(content)), 0) into n from public.knowledge_docs
    where account_id = p_account and id is distinct from p_doc;
  if n + length(p_content) > 3000000 then
    raise exception 'That would take this client past its limit of about 3 MB of documents.' using errcode = '53400';
  end if;

  if p_doc is null then
    insert into public.knowledge_docs (account_id, title, filename, content, agent_ids, created_by)
    values (p_account, v_title, left(coalesce(p_filename, ''), 200), p_content, agents, (select auth.uid()))
    returning id into doc;
  else
    update public.knowledge_docs
       set title = v_title, content = p_content, updated_at = now(),
           filename = coalesce(nullif(left(coalesce(p_filename, ''), 200), ''), filename),
           agent_ids = coalesce(agents, public.knowledge_docs.agent_ids)
     where id = p_doc and account_id = p_account
    returning id into doc;
    if doc is null then
      raise exception 'We could not find that document.' using errcode = 'P0002';
    end if;
    delete from public.knowledge_chunks where doc_id = doc;
  end if;

  insert into public.knowledge_chunks (doc_id, idx, heading, content)
  select doc, (t.ord - 1)::integer, left(coalesce(t.c ->> 'heading', ''), 300), left(t.c ->> 'content', 4000)
    from jsonb_array_elements(p_chunks) with ordinality as t(c, ord)
   where length(btrim(coalesce(t.c ->> 'content', ''))) > 0;
  return doc;
end;
$$;

-- For the worker: what an agent knows. Small knowledge is returned whole (so the agent has it
-- from the first word); larger knowledge is only counted, and the agent searches it.
create or replace function public.knowledge_for_agent(p_agent uuid, p_inline_max integer default 20000)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with mine as (
    select d.title, d.content
      from public.knowledge_docs d
      join public.agents a on a.account_id = d.account_id
     where a.id = p_agent and (d.agent_ids is null or p_agent = any (d.agent_ids))
  ), total as (
    select count(*) as n, coalesce(sum(length(content)), 0) as chars from mine
  )
  select jsonb_build_object(
    'count', total.n,
    'total_chars', total.chars,
    'docs', case when total.n > 0 and total.chars <= p_inline_max
                 then (select jsonb_agg(jsonb_build_object('title', title, 'content', content) order by title) from mine)
                 else '[]'::jsonb end
  ) from total;
$$;

-- For the worker: the passages that best match what the caller asked. Any of the words may match
-- (the more of them, the higher it ranks), beginnings of words count, and common words are ignored.
create or replace function public.knowledge_search(p_agent uuid, p_query text, p_limit integer default 4)
returns table (title text, heading text, content text, rank real)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare q tsquery;
begin
  select to_tsquery('english', string_agg(quote_literal(w) || ':*', ' | '))
    into q
    from (
      select distinct w
        from regexp_split_to_table(lower(left(coalesce(p_query, ''), 300)), '[^[:alnum:]]+') as w
       where length(w) >= 2
       limit 12
    ) words;
  if q is null then return; end if;
  return query
    select d.title, c.heading, c.content, ts_rank_cd(c.tsv, q)::real as rank
      from public.knowledge_chunks c
      join public.knowledge_docs d on d.id = c.doc_id
      join public.agents a on a.account_id = d.account_id
     where a.id = p_agent and (d.agent_ids is null or p_agent = any (d.agent_ids)) and c.tsv @@ q
     order by rank desc, d.title, c.idx
     limit greatest(least(coalesce(p_limit, 4), 8), 1);
end;
$$;

revoke all on function public.knowledge_save(uuid, uuid, text, text, text, uuid[], jsonb) from public, anon;
grant execute on function public.knowledge_save(uuid, uuid, text, text, text, uuid[], jsonb) to authenticated;
revoke all on function public.knowledge_for_agent(uuid, integer) from public, anon, authenticated;
revoke all on function public.knowledge_search(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.knowledge_for_agent(uuid, integer) to service_role;
grant execute on function public.knowledge_search(uuid, text, integer) to service_role;
