-- Account phone and account interests stay in the private profiles table.
-- Sellers explicitly opt in by filling the public phone or sharing their interests.
alter table public.marketplace_profiles
    add column if not exists public_phone text check (char_length(public_phone) <= 60),
    add column if not exists public_interests text[] check (cardinality(public_interests) <= 12);
