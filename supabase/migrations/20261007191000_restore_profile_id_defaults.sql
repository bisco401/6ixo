-- These defaults were absent in production despite the section-profile migration
-- being recorded as applied. New profile upserts omit public_id by design.
alter table public.marketplace_profiles
    alter column public_id set default ('mp_' || lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))),
    alter column map_visible set default false;

alter table public.dating_profiles
    alter column public_id set default ('dp_' || lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)));

notify pgrst, 'reload schema';
