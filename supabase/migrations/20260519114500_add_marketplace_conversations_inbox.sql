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
language plpgsql
security definer
set search_path = public
stable
as $$
declare
    caller_id uuid := auth.uid();
begin
    if caller_id is null then
        raise exception 'Log in to view messages.' using errcode = '42501';
    end if;

    return query
    select
        conversation.public_id as conversation_public_id,
        conversation.booking_public_id,
        conversation.listing_public_id,
        conversation.listing_title,
        conversation.guest_display_name,
        conversation.host_display_name,
        case
            when caller_id = conversation.host_user_id then conversation.guest_display_name
            else conversation.host_display_name
        end as other_display_name,
        case
            when caller_id = conversation.host_user_id then 'guest'
            else 'host'
        end as other_role,
        coalesce(booking.status, '') as booking_status,
        coalesce(last_message.body, '') as last_message_body,
        conversation.last_message_at,
        conversation.created_at
    from public.marketplace_conversations conversation
    left join public.short_term_bookings booking
      on booking.id = conversation.booking_id
    left join lateral (
        select message.body
        from public.marketplace_messages message
        where message.conversation_id = conversation.id
        order by message.created_at desc, message.id desc
        limit 1
    ) last_message on true
    where caller_id = conversation.guest_user_id
       or caller_id = conversation.host_user_id
       or public.is_admin_user()
    order by coalesce(conversation.last_message_at, conversation.created_at) desc;
end;
$$;

grant execute on function public.get_my_marketplace_conversations() to authenticated;
