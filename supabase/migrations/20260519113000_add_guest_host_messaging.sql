create table if not exists public.marketplace_conversations (
    id uuid primary key default gen_random_uuid(),
    public_id text not null unique default ('conv_' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 20)),
    booking_id uuid unique references public.short_term_bookings(id) on delete set null,
    booking_public_id text,
    listing_id uuid references public.short_term_listings(id) on delete set null,
    listing_public_id text,
    listing_title text not null default 'Stay',
    guest_user_id uuid not null references auth.users(id) on delete cascade,
    host_user_id uuid not null references auth.users(id) on delete cascade,
    guest_display_name text not null default 'Guest',
    host_display_name text not null default 'Host',
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    last_message_at timestamptz
);

create table if not exists public.marketplace_messages (
    id uuid primary key default gen_random_uuid(),
    public_id text not null unique default ('msg_' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 20)),
    conversation_id uuid not null references public.marketplace_conversations(id) on delete cascade,
    sender_user_id uuid not null references auth.users(id) on delete cascade,
    body text not null,
    created_at timestamptz not null default timezone('utc', now()),
    constraint marketplace_messages_body_check check (
        length(trim(body)) between 1 and 4000
    )
);

create index if not exists marketplace_conversations_guest_idx
    on public.marketplace_conversations (guest_user_id, last_message_at desc nulls last, created_at desc);

create index if not exists marketplace_conversations_host_idx
    on public.marketplace_conversations (host_user_id, last_message_at desc nulls last, created_at desc);

create index if not exists marketplace_messages_conversation_idx
    on public.marketplace_messages (conversation_id, created_at asc);

create or replace function public.marketplace_conversations_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = timezone('utc', now());
    return new;
end;
$$;

drop trigger if exists marketplace_conversations_set_updated_at on public.marketplace_conversations;
create trigger marketplace_conversations_set_updated_at
before update on public.marketplace_conversations
for each row
execute function public.marketplace_conversations_set_updated_at();

alter table public.marketplace_conversations enable row level security;
alter table public.marketplace_messages enable row level security;

drop policy if exists "marketplace_conversations_participant_select" on public.marketplace_conversations;
create policy "marketplace_conversations_participant_select"
    on public.marketplace_conversations
    for select
    to authenticated
    using (
        auth.uid() = guest_user_id
        or auth.uid() = host_user_id
        or public.is_admin_user()
    );

drop policy if exists "marketplace_messages_participant_select" on public.marketplace_messages;
create policy "marketplace_messages_participant_select"
    on public.marketplace_messages
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.marketplace_conversations conversation
            where conversation.id = marketplace_messages.conversation_id
              and (
                auth.uid() = conversation.guest_user_id
                or auth.uid() = conversation.host_user_id
                or public.is_admin_user()
              )
        )
    );

drop policy if exists "marketplace_messages_participant_insert" on public.marketplace_messages;
create policy "marketplace_messages_participant_insert"
    on public.marketplace_messages
    for insert
    to authenticated
    with check (
        sender_user_id = auth.uid()
        and exists (
            select 1
            from public.marketplace_conversations conversation
            where conversation.id = marketplace_messages.conversation_id
              and (
                auth.uid() = conversation.guest_user_id
                or auth.uid() = conversation.host_user_id
                or public.is_admin_user()
              )
        )
    );

grant select on public.marketplace_conversations to authenticated;
grant select, insert on public.marketplace_messages to authenticated;

create or replace function public.get_or_create_short_term_booking_conversation(
    p_booking_public_id text
)
returns table (
    conversation_public_id text,
    booking_public_id text,
    listing_public_id text,
    listing_title text,
    guest_display_name text,
    host_display_name text,
    other_display_name text,
    created_at timestamptz,
    last_message_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
    caller_id uuid := auth.uid();
    booking_ref text := trim(coalesce(p_booking_public_id, ''));
    booking_row public.short_term_bookings%rowtype;
    listing_row public.short_term_listings%rowtype;
    conversation_row public.marketplace_conversations%rowtype;
    resolved_host_name text := 'Host';
    is_admin boolean := false;
begin
    if caller_id is null then
        raise exception 'Log in to message the host or guest.' using errcode = '42501';
    end if;

    if booking_ref = '' then
        raise exception 'Booking is required.' using errcode = '22023';
    end if;

    is_admin := public.is_admin_user();

    select *
    into booking_row
    from public.short_term_bookings
    where public_id = booking_ref or id::text = booking_ref
    limit 1;

    if not found then
        raise exception 'Booking not found.' using errcode = '22023';
    end if;

    if booking_row.guest_user_id is null then
        raise exception 'This booking was created without a logged-in guest account.' using errcode = '42501';
    end if;

    if caller_id <> booking_row.guest_user_id and caller_id <> booking_row.host_user_id and is_admin = false then
        raise exception 'Only the guest and host can open this conversation.' using errcode = '42501';
    end if;

    select *
    into listing_row
    from public.short_term_listings
    where id = booking_row.listing_id
    limit 1;

    if found then
        resolved_host_name := nullif(trim(coalesce(listing_row.listing_payload -> 'realestate' ->> 'hostName', '')), '');
        if resolved_host_name is null then
            resolved_host_name := nullif(trim(coalesce(listing_row.listing_payload ->> 'seller', '')), '');
        end if;
    end if;
    resolved_host_name := coalesce(resolved_host_name, 'Host');

    insert into public.marketplace_conversations (
        booking_id,
        booking_public_id,
        listing_id,
        listing_public_id,
        listing_title,
        guest_user_id,
        host_user_id,
        guest_display_name,
        host_display_name
    )
    values (
        booking_row.id,
        booking_row.public_id,
        booking_row.listing_id,
        booking_row.listing_public_id,
        coalesce(nullif(trim(coalesce(listing_row.title, booking_row.booking_payload ->> 'listingTitle', '')), ''), 'Stay'),
        booking_row.guest_user_id,
        booking_row.host_user_id,
        coalesce(nullif(trim(booking_row.guest_name), ''), 'Guest'),
        resolved_host_name
    )
    on conflict (booking_id) do update
    set
        booking_public_id = excluded.booking_public_id,
        listing_id = excluded.listing_id,
        listing_public_id = excluded.listing_public_id,
        listing_title = excluded.listing_title,
        guest_display_name = excluded.guest_display_name,
        host_display_name = excluded.host_display_name
    returning * into conversation_row;

    return query
    select
        conversation_row.public_id,
        conversation_row.booking_public_id,
        conversation_row.listing_public_id,
        conversation_row.listing_title,
        conversation_row.guest_display_name,
        conversation_row.host_display_name,
        case
            when caller_id = conversation_row.host_user_id then conversation_row.guest_display_name
            else conversation_row.host_display_name
        end as other_display_name,
        conversation_row.created_at,
        conversation_row.last_message_at;
end;
$$;

grant execute on function public.get_or_create_short_term_booking_conversation(text) to authenticated;

create or replace function public.get_marketplace_conversation_messages(
    p_conversation_public_id text
)
returns table (
    message_public_id text,
    conversation_public_id text,
    sender_user_id uuid,
    sender_is_me boolean,
    sender_role text,
    body text,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
    caller_id uuid := auth.uid();
    conversation_ref text := trim(coalesce(p_conversation_public_id, ''));
    conversation_row public.marketplace_conversations%rowtype;
    is_admin boolean := false;
begin
    if caller_id is null then
        raise exception 'Log in to view messages.' using errcode = '42501';
    end if;

    if conversation_ref = '' then
        raise exception 'Conversation is required.' using errcode = '22023';
    end if;

    is_admin := public.is_admin_user();

    select *
    into conversation_row
    from public.marketplace_conversations
    where public_id = conversation_ref or id::text = conversation_ref
    limit 1;

    if not found then
        raise exception 'Conversation not found.' using errcode = '22023';
    end if;

    if caller_id <> conversation_row.guest_user_id and caller_id <> conversation_row.host_user_id and is_admin = false then
        raise exception 'Only conversation participants can view messages.' using errcode = '42501';
    end if;

    return query
    select
        message.public_id as message_public_id,
        conversation_row.public_id as conversation_public_id,
        message.sender_user_id,
        message.sender_user_id = caller_id as sender_is_me,
        case
            when message.sender_user_id = conversation_row.host_user_id then 'host'
            when message.sender_user_id = conversation_row.guest_user_id then 'guest'
            else 'member'
        end as sender_role,
        message.body,
        message.created_at
    from public.marketplace_messages message
    where message.conversation_id = conversation_row.id
    order by message.created_at asc, message.id asc;
end;
$$;

grant execute on function public.get_marketplace_conversation_messages(text) to authenticated;

create or replace function public.send_marketplace_conversation_message(
    p_conversation_public_id text,
    p_body text
)
returns table (
    message_public_id text,
    conversation_public_id text,
    sender_user_id uuid,
    sender_is_me boolean,
    sender_role text,
    body text,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
    caller_id uuid := auth.uid();
    conversation_ref text := trim(coalesce(p_conversation_public_id, ''));
    message_body text := trim(coalesce(p_body, ''));
    conversation_row public.marketplace_conversations%rowtype;
    message_row public.marketplace_messages%rowtype;
    is_admin boolean := false;
begin
    if caller_id is null then
        raise exception 'Log in to send messages.' using errcode = '42501';
    end if;

    if conversation_ref = '' then
        raise exception 'Conversation is required.' using errcode = '22023';
    end if;

    if length(message_body) < 1 then
        raise exception 'Message cannot be empty.' using errcode = '22023';
    end if;

    if length(message_body) > 4000 then
        raise exception 'Message is too long.' using errcode = '22023';
    end if;

    is_admin := public.is_admin_user();

    select *
    into conversation_row
    from public.marketplace_conversations
    where public_id = conversation_ref or id::text = conversation_ref
    for update;

    if not found then
        raise exception 'Conversation not found.' using errcode = '22023';
    end if;

    if caller_id <> conversation_row.guest_user_id and caller_id <> conversation_row.host_user_id and is_admin = false then
        raise exception 'Only conversation participants can send messages.' using errcode = '42501';
    end if;

    insert into public.marketplace_messages (
        conversation_id,
        sender_user_id,
        body
    )
    values (
        conversation_row.id,
        caller_id,
        message_body
    )
    returning * into message_row;

    update public.marketplace_conversations
    set last_message_at = message_row.created_at
    where id = conversation_row.id;

    return query
    select
        message_row.public_id,
        conversation_row.public_id,
        message_row.sender_user_id,
        true,
        case
            when caller_id = conversation_row.host_user_id then 'host'
            when caller_id = conversation_row.guest_user_id then 'guest'
            else 'member'
        end,
        message_row.body,
        message_row.created_at;
end;
$$;

grant execute on function public.send_marketplace_conversation_message(text, text) to authenticated;
