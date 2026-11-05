-- A public bucket for the logos shown on website buttons. PNG, JPEG or WebP, at most 512 KB.
-- Logos live under a folder named for the agent. Owners and editors of the agent's client may add,
-- replace and remove them; anyone may view them (they are shown on public websites).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('embed-logos', 'embed-logos', true, 524288, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 524288,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

create policy embed_logos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'embed-logos' and exists (
      select 1 from public.agents a
      where a.id::text = (storage.foldername(name))[1]
        and private.has_role(a.account_id, array['owner', 'editor'])
    )
  );
create policy embed_logos_update on storage.objects for update to authenticated
  using (
    bucket_id = 'embed-logos' and exists (
      select 1 from public.agents a
      where a.id::text = (storage.foldername(name))[1]
        and private.has_role(a.account_id, array['owner', 'editor'])
    )
  );
create policy embed_logos_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'embed-logos' and exists (
      select 1 from public.agents a
      where a.id::text = (storage.foldername(name))[1]
        and private.has_role(a.account_id, array['owner', 'editor'])
    )
  );
