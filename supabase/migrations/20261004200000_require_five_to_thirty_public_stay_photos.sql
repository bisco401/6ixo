-- Enforce the public listing range on creation, publication, and photo changes.
-- Existing stays can still update availability without changing their photos.
create or replace function public.enforce_short_term_listing_photo_count()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
    photos jsonb := coalesce(new.listing_payload -> 'images', 'null'::jsonb);
begin
    if lower(coalesce(new.status, '')) <> 'published' then return new; end if;
    if tg_op = 'UPDATE' then
        if old.status is not distinct from new.status
           and coalesce(old.listing_payload -> 'images', 'null'::jsonb) is not distinct from photos then
            return new;
        end if;
    end if;

    if jsonb_typeof(photos) <> 'array' then
        raise exception 'Published stays require between 5 and 30 persistent HTTPS property photos.' using errcode = '22023';
    end if;
    if jsonb_array_length(photos) not between 5 and 30
       or exists (
           select 1 from jsonb_array_elements(photos) photo
           where jsonb_typeof(photo) <> 'string'
              or trim(photo #>> '{}') !~ '^https://[^[:space:]]+$'
       ) then
        raise exception 'Published stays require between 5 and 30 persistent HTTPS property photos.' using errcode = '22023';
    end if;
    return new;
end;
$$;

revoke all on function public.enforce_short_term_listing_photo_count() from public, anon, authenticated;
create trigger short_term_listings_property_photo_count
before insert or update of status, listing_payload on public.short_term_listings
for each row execute function public.enforce_short_term_listing_photo_count();
