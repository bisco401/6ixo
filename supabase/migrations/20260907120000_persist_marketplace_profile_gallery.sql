-- Store durable public image URLs so profile galleries survive reloads/devices.
alter table public.marketplace_profiles
    add column if not exists photo_urls text[] not null default '{}';

update public.marketplace_profiles
set photo_urls = array[photo_url]
where cardinality(photo_urls) = 0 and photo_url ~* '^https?://';

alter table public.marketplace_profiles
    add constraint marketplace_profile_gallery_size check (cardinality(photo_urls) <= 3);
