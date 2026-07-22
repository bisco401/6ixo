create extension if not exists pgcrypto;
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;
create table if not exists public.escrow_transactions (
    id uuid primary key default gen_random_uuid(),
    public_id text not null unique default ('et_' || lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))),
    buyer_user_id uuid references auth.users(id) on delete set null,
    listing_public_id text,
    escrow_transaction_id text unique,
    buyer_email text not null,
    seller_email text not null,
    amount numeric not null,
    currency text not null default 'usd',
    status text not null default 'created',
    request_payload jsonb not null default '{}'::jsonb,
    response_payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists escrow_transactions_buyer_idx
    on public.escrow_transactions (buyer_user_id, created_at desc);
create index if not exists escrow_transactions_listing_idx
    on public.escrow_transactions (listing_public_id, created_at desc);
drop trigger if exists escrow_transactions_set_updated_at on public.escrow_transactions;
create trigger escrow_transactions_set_updated_at
before update on public.escrow_transactions
for each row execute function public.set_updated_at();
alter table public.escrow_transactions enable row level security;
drop policy if exists "escrow_transactions_select_own_buyer" on public.escrow_transactions;
create policy "escrow_transactions_select_own_buyer"
on public.escrow_transactions
for select
to authenticated
using (auth.uid() = buyer_user_id);
grant select on public.escrow_transactions to authenticated;
