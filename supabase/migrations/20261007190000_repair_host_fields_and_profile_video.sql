-- Repair drift in the deployed host schema without changing review/ownership rules.
alter table public.host_applications
    add column if not exists owns_property boolean,
    add column if not exists has_owner_permission boolean,
    add column if not exists bedrooms integer,
    add column if not exists bathrooms numeric(4,1),
    add column if not exists max_guest_capacity integer,
    add column if not exists is_furnished boolean,
    add column if not exists lives_at_property boolean,
    add column if not exists has_smoke_detectors boolean,
    add column if not exists has_carbon_monoxide_detectors boolean,
    add column if not exists has_fire_extinguisher boolean,
    add column if not exists meets_health_safety_standards boolean,
    add column if not exists complies_local_laws boolean,
    add column if not exists has_emergency_exits boolean,
    add column if not exists has_insurance boolean,
    add column if not exists insurance_provider text,
    add column if not exists insurance_policy_number text,
    add column if not exists hosted_before boolean,
    add column if not exists suspended_elsewhere boolean,
    add column if not exists suspension_explanation text,
    add column if not exists provides_house_rules boolean,
    add column if not exists maintains_cleanliness boolean,
    add column if not exists responds_timely boolean,
    add column if not exists agrees_guest_safety boolean,
    add column if not exists agrees_truthful_listing boolean,
    add column if not exists doc_government_id boolean not null default false,
    add column if not exists doc_property_proof boolean not null default false,
    add column if not exists doc_utility_bill boolean not null default false,
    add column if not exists doc_insurance boolean not null default false,
    add column if not exists doc_property_photos boolean not null default false,
    add column if not exists doc_business_registration boolean not null default false,
    add column if not exists doc_short_term_permit boolean not null default false,
    add column if not exists has_relevant_conviction boolean,
    add column if not exists conviction_explanation text;

-- Profile clips use the existing public marketplace-media bucket and owner policies.
alter table public.marketplace_profiles
    add column if not exists profile_video_url text;

do $$ begin
    if not exists (select 1 from pg_constraint
        where conrelid = 'public.marketplace_profiles'::regclass
        and conname = 'marketplace_profile_video_https') then
        alter table public.marketplace_profiles
            add constraint marketplace_profile_video_https
            check (profile_video_url is null or profile_video_url ~ '^https://');
    end if;
end $$;

notify pgrst, 'reload schema';
