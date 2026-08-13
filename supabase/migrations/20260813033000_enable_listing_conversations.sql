alter table public.marketplace_conversations
    add column if not exists marketplace_listing_id uuid references public.marketplace_listings(id) on delete set null;

alter table public.marketplace_conversations
    drop constraint if exists marketplace_conversations_booking_type_check;

alter table public.marketplace_conversations
    add constraint marketplace_conversations_booking_type_check
    check (booking_type in ('short_term', 'vehicle_rental', 'marketplace_listing', 'short_term_inquiry'));

create unique index if not exists marketplace_conversations_listing_guest_unique
    on public.marketplace_conversations (marketplace_listing_id, guest_user_id)
    where marketplace_listing_id is not null;

create unique index if not exists marketplace_conversations_stay_inquiry_guest_unique
    on public.marketplace_conversations (listing_id, guest_user_id)
    where listing_id is not null and booking_id is null;

create or replace function public.get_or_create_listing_conversation(
    p_listing_public_id text,
    p_listing_source text default 'marketplace'
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
    listing_ref text := trim(coalesce(p_listing_public_id, ''));
    source_key text := lower(trim(coalesce(p_listing_source, 'marketplace')));
    marketplace_row public.marketplace_listings%rowtype;
    stay_row public.short_term_listings%rowtype;
    conversation_row public.marketplace_conversations%rowtype;
    host_id uuid;
    resolved_title text := 'Listing';
    resolved_guest_name text := '6ixo member';
    resolved_host_name text := 'Seller';
begin
    if caller_id is null then
        raise exception 'Log in to message this seller.' using errcode = '42501';
    end if;

    if listing_ref = '' then
        raise exception 'Listing is required.' using errcode = '22023';
    end if;

    select nullif(trim(profile.display_name), '')
    into resolved_guest_name
    from public.marketplace_profiles profile
    where profile.user_id = caller_id
    limit 1;

    if resolved_guest_name is null then
        select nullif(trim(coalesce(profile.full_name, concat_ws(' ', profile.first_name, profile.last_name))), '')
        into resolved_guest_name
        from public.profiles profile
        where profile.id = caller_id
        limit 1;
    end if;
    resolved_guest_name := coalesce(resolved_guest_name, '6ixo member');

    if source_key in ('short_term', 'short-term', 'stay', 'short_term_listings') then
        select *
        into stay_row
        from public.short_term_listings listing
        where (listing.public_id = listing_ref or listing.id::text = listing_ref)
          and listing.status = 'published'
        limit 1;

        if not found then
            raise exception 'Short-term listing not found.' using errcode = '22023';
        end if;

        host_id := stay_row.user_id;
        resolved_title := coalesce(nullif(trim(stay_row.title), ''), 'Stay');
        resolved_host_name := coalesce(
            nullif(trim(stay_row.listing_payload -> 'realestate' ->> 'hostName'), ''),
            nullif(trim(stay_row.listing_payload ->> 'seller'), ''),
            'Host'
        );

        if caller_id = host_id then
            raise exception 'This is your own listing. Open Messages from your profile to reply to guests.' using errcode = '22023';
        end if;

        insert into public.marketplace_conversations (
            booking_type,
            listing_id,
            listing_public_id,
            listing_title,
            guest_user_id,
            host_user_id,
            guest_display_name,
            host_display_name
        )
        values (
            'short_term_inquiry',
            stay_row.id,
            stay_row.public_id,
            resolved_title,
            caller_id,
            host_id,
            resolved_guest_name,
            resolved_host_name
        )
        on conflict (listing_id, guest_user_id) where listing_id is not null and booking_id is null do update
        set
            booking_type = 'short_term_inquiry',
            listing_public_id = excluded.listing_public_id,
            listing_title = excluded.listing_title,
            guest_display_name = excluded.guest_display_name,
            host_display_name = excluded.host_display_name
        returning * into conversation_row;
    else
        select *
        into marketplace_row
        from public.marketplace_listings listing
        where (listing.public_id = listing_ref or listing.id::text = listing_ref)
          and listing.status = 'published'
        limit 1;

        if not found then
            raise exception 'Marketplace listing not found.' using errcode = '22023';
        end if;

        host_id := marketplace_row.user_id;
        resolved_title := coalesce(nullif(trim(marketplace_row.title), ''), 'Listing');

        select nullif(trim(profile.display_name), '')
        into resolved_host_name
        from public.marketplace_profiles profile
        where profile.user_id = host_id
        limit 1;
        resolved_host_name := coalesce(
            resolved_host_name,
            nullif(trim(marketplace_row.listing_payload ->> 'seller'), ''),
            'Seller'
        );

        if caller_id = host_id then
            raise exception 'This is your own listing. Open Messages from your profile to reply to buyers.' using errcode = '22023';
        end if;

        insert into public.marketplace_conversations (
            booking_type,
            marketplace_listing_id,
            listing_public_id,
            listing_title,
            guest_user_id,
            host_user_id,
            guest_display_name,
            host_display_name
        )
        values (
            'marketplace_listing',
            marketplace_row.id,
            marketplace_row.public_id,
            resolved_title,
            caller_id,
            host_id,
            resolved_guest_name,
            resolved_host_name
        )
        on conflict (marketplace_listing_id, guest_user_id) where marketplace_listing_id is not null do update
        set
            booking_type = 'marketplace_listing',
            listing_public_id = excluded.listing_public_id,
            listing_title = excluded.listing_title,
            guest_display_name = excluded.guest_display_name,
            host_display_name = excluded.host_display_name
        returning * into conversation_row;
    end if;

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
        end,
        conversation_row.created_at,
        conversation_row.last_message_at;
end;
$$;

revoke execute on function public.get_or_create_listing_conversation(text, text) from public, anon;
grant execute on function public.get_or_create_listing_conversation(text, text) to authenticated;

create or replace function public.get_my_marketplace_conversations()
returns table (
    conversation_public_id text,
    booking_public_id text,
    listing_public_id text,
    listing_title text,
    guest_display_name text,
    host_display_name text,
    other_display_name text,
    other_role text,
    booking_status text,
    last_message_body text,
    last_message_at timestamptz,
    created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
    select
        conversation.public_id,
        conversation.booking_public_id,
        conversation.listing_public_id,
        conversation.listing_title,
        conversation.guest_display_name,
        conversation.host_display_name,
        case
            when auth.uid() = conversation.host_user_id then conversation.guest_display_name
            else conversation.host_display_name
        end,
        case
            when auth.uid() = conversation.host_user_id then 'guest'
            else 'host'
        end,
        coalesce(stay_booking.status, vehicle_booking.status, ''),
        coalesce(last_message.body, ''),
        conversation.last_message_at,
        conversation.created_at
    from public.marketplace_conversations conversation
    left join public.short_term_bookings stay_booking
      on stay_booking.id = conversation.booking_id
    left join public.vehicle_rental_bookings vehicle_booking
      on vehicle_booking.id = conversation.vehicle_rental_booking_id
    left join lateral (
        select message.body
        from public.marketplace_messages message
        where message.conversation_id = conversation.id
        order by message.created_at desc, message.id desc
        limit 1
    ) last_message on true
    where auth.uid() is not null
      and (
          auth.uid() = conversation.guest_user_id
          or auth.uid() = conversation.host_user_id
          or public.is_admin_user()
      )
    order by coalesce(conversation.last_message_at, conversation.created_at) desc;
$$;

revoke execute on function public.get_my_marketplace_conversations() from public, anon;
grant execute on function public.get_my_marketplace_conversations() to authenticated;
