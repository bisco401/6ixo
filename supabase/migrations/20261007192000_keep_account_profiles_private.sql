-- Account names/contact details belong to the private profile, while public
-- seller identities are read from marketplace_profiles.
drop policy if exists profiles_select_public on public.profiles;
drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
    for select to authenticated using (public.is_admin_user());

-- The legacy active-profile policy bypassed the newer discoverability setting.
drop policy if exists dating_profiles_select_public on public.dating_profiles;

notify pgrst, 'reload schema';
