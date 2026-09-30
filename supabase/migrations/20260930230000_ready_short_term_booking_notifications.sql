-- Only operationally ready stays enter public booking search. Financial and
-- account details remain private; callers receive the existing listing fields.
create or replace function public.get_bookable_short_term_listings()
returns setof public.short_term_listings
language sql stable security definer set search_path=public,pg_temp as $$
 select l.* from public.short_term_listings l
 join public.profiles p on p.id=l.user_id
 join public.stripe_connected_accounts a on a.user_id=l.user_id
 join public.rental_listing_finance f on f.listing_id=l.id
 join auth.users u on u.id=l.user_id
 where l.status='published' and l.price>0 and p.host_status='approved'
   and u.email_confirmed_at is not null
   and a.details_submitted and a.payouts_enabled
   and a.metadata#>>'{capabilities,transfers}'='active'
   and f.reviewed_at is not null
 order by l.created_at desc;
$$;
revoke all on function public.get_bookable_short_term_listings() from public;
grant execute on function public.get_bookable_short_term_listings() to anon,authenticated,service_role;

create or replace function public.get_rental_finance_admin()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_admin_user() then raise exception 'Administrator access required.' using errcode='42501'; end if;
 return jsonb_build_object(
 'listings',(select coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('finance',to_jsonb(f))),'[]') from (select id,public_id,title,city,country,currency,listing_payload from short_term_listings where status<>'archived' order by created_at desc limit 100) l left join rental_listing_finance f on f.listing_id=l.id),
 'payouts',(select coalesce(jsonb_agg(to_jsonb(f)),'[]') from (select * from rental_booking_finance order by created_at desc limit 100) f),
 'pendingEmails',(select count(*) from rental_notification_outbox where sent_at is null),
 'pendingStayEmails',(select count(*) from stay_booking_notification_outbox where sent_at is null and skipped_at is null),
 'failedStayEmails',(select count(*) from stay_booking_notification_outbox where sent_at is null and skipped_at is null and last_error is not null));
end $$;

create table public.stay_booking_notification_outbox (
 id uuid primary key default gen_random_uuid(),
 booking_id uuid not null references public.short_term_bookings(id) on delete cascade,
 recipient_user_id uuid not null references auth.users(id) on delete cascade,
 recipient_role text not null check(recipient_role in ('guest','host')),
 event_type text not null check(event_type in ('booking_requested','booking_confirmed','booking_declined','booking_cancelled','booking_refunded','payment_disputed')),
 created_at timestamptz not null default now(),
 sent_at timestamptz, provider_message_id text, skipped_at timestamptz,
 attempts integer not null default 0 check(attempts>=0),
 last_attempt_at timestamptz,last_error text,next_attempt_at timestamptz not null default now(),
 unique(booking_id,event_type,recipient_user_id)
);
alter table public.stay_booking_notification_outbox enable row level security;
revoke all on public.stay_booking_notification_outbox from public,anon,authenticated;
grant all on public.stay_booking_notification_outbox to service_role;
create index stay_booking_mail_due on public.stay_booking_notification_outbox(next_attempt_at)
 where sent_at is null and skipped_at is null;

create or replace function public.queue_stay_booking_notifications()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare events text[]:='{}';event_name text;
begin
 if new.status='requested' and new.payment_status='authorized'
   and (old.status is distinct from new.status or old.payment_status is distinct from new.payment_status) then
  events:=array_append(events,'booking_requested');
 end if;
 if new.status='confirmed' and new.payment_status='paid'
   and (old.status is distinct from new.status or old.payment_status is distinct from new.payment_status) then
  events:=array_append(events,'booking_confirmed');
 end if;
 if new.status in ('declined','cancelled') and old.status is distinct from new.status
   and new.payment_status<>'refunded'
   and (old.stripe_payment_intent_id is not null or old.payment_status in ('authorized','processing','paid')) then
  events:=array_append(events,case when new.status='declined' then 'booking_declined' else 'booking_cancelled' end);
 end if;
 if new.payment_status='refunded' and old.payment_status is distinct from new.payment_status then
  events:=array_append(events,'booking_refunded');
 end if;
 if new.payment_status='disputed' and old.payment_status is distinct from new.payment_status then
  events:=array_append(events,'payment_disputed');
 end if;
 foreach event_name in array events loop
  insert into public.stay_booking_notification_outbox(booking_id,recipient_user_id,recipient_role,event_type)
  select new.id,recipient.user_id,recipient.role,event_name
  from (values(new.guest_user_id,'guest'),(new.host_user_id,'host')) recipient(user_id,role)
  where recipient.user_id is not null
  on conflict(booking_id,event_type,recipient_user_id) do nothing;
 end loop;
 return new;
end $$;
revoke all on function public.queue_stay_booking_notifications() from public,anon,authenticated;
create trigger stay_booking_notifications after update of status,payment_status
 on public.short_term_bookings for each row execute function public.queue_stay_booking_notifications();

-- Do not backfill emails for older bookings: future state transitions produce
-- notifications once, after the authoritative payment state has been saved.

-- Releasing an authorization must also close the unpaid host ledger. Transfers
-- already made are recovered by the existing settlement worker instead.
create or replace function public.close_cancelled_stay_finance()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status in ('cancelled','declined') or new.payment_status in ('cancelled','refunded') then
  update public.rental_booking_finance set payout_status='cancelled',last_error=null
  where booking_id=new.id and stripe_transfer_id is null and payout_status<>'reversed';
 end if;
 return new;
end $$;
revoke all on function public.close_cancelled_stay_finance() from public,anon,authenticated;
create trigger close_cancelled_stay_finance after update of status,payment_status
 on public.short_term_bookings for each row execute function public.close_cancelled_stay_finance();
