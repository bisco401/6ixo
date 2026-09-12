-- Auditable property tax configuration and immutable booking financial terms.
create table public.rental_listing_finance (
 listing_id uuid primary key references public.short_term_listings(id) on delete cascade,
 time_zone text not null, checkin_time time not null default '15:00',
 tax_rules jsonb not null default '[]', review_notes text not null,
 reviewed_by uuid not null references auth.users(id), reviewed_at timestamptz not null default now()
);
alter table public.rental_listing_finance enable row level security;
revoke all on public.rental_listing_finance from public,anon,authenticated;
grant select on public.rental_listing_finance to authenticated;
grant all on public.rental_listing_finance to service_role;
create policy rental_finance_admin_select on public.rental_listing_finance for select to authenticated using (public.is_admin_user() or exists(select 1 from public.short_term_listings l where l.id=listing_id and l.user_id=auth.uid()));

create table public.rental_booking_finance (
 booking_id uuid primary key references public.short_term_bookings(id),
 booking_public_id text not null unique, host_user_id uuid not null references auth.users(id),
 currency text not null, total_cents bigint not null check(total_cents>0),
 service_fee_cents bigint not null check(service_fee_cents>=0),
 tax_cents bigint not null check(tax_cents>=0), host_amount_cents bigint not null check(host_amount_cents>0),
 tax_breakdown jsonb not null, checkin_at timestamptz not null,
 cancellation_deadline timestamptz not null, payout_due_at timestamptz not null,
 stripe_destination text, stripe_transfer_id text unique, stripe_charge_id text,
 payout_status text not null default 'pending' check(payout_status in ('pending','transferred','held','reversed','cancelled')),
 last_error text, attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 transferred_at timestamptz, reversed_at timestamptz, created_at timestamptz not null default now()
);
alter table public.rental_booking_finance enable row level security;
revoke all on public.rental_booking_finance from public,anon,authenticated;
grant select on public.rental_booking_finance to authenticated;
grant all on public.rental_booking_finance to service_role;
create policy rental_booking_finance_participant_read on public.rental_booking_finance for select to authenticated using(public.is_admin_user() or exists(select 1 from public.short_term_bookings b where b.id=booking_id and auth.uid() in(b.host_user_id,b.guest_user_id)));
create index rental_payout_due on public.rental_booking_finance(payout_due_at,next_attempt_at) where payout_status in ('pending','held','transferred');

create or replace function public.configure_rental_listing_finance(p_listing_id uuid,p_time_zone text,p_checkin_time time,p_tax_rules jsonb,p_review_notes text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare rule jsonb;
begin
 if not public.is_admin_user() then raise exception 'Administrator access required.' using errcode='42501'; end if;
 if not exists(select 1 from pg_timezone_names where name=p_time_zone) then raise exception 'Choose a valid property time zone.'; end if;
 if p_checkin_time is null or length(trim(coalesce(p_review_notes,'')))<10 then raise exception 'Record the tax review and check-in time.'; end if;
 if jsonb_typeof(p_tax_rules) is distinct from 'array' or jsonb_array_length(p_tax_rules)>10 then raise exception 'Invalid tax rules.'; end if;
 for rule in select * from jsonb_array_elements(p_tax_rules) loop
  if length(trim(coalesce(rule->>'label','')))<2 or coalesce(rule->>'recipient','') not in ('host','platform')
    or coalesce(rule->>'kind','') not in ('percent','per_night')
    or coalesce(rule->>'rate','') !~ '^[0-9]+(\.[0-9]{1,4})?$' then raise exception 'Each tax needs a name, rate, calculation, and remitting party.'; end if;
  if (rule->>'rate')::numeric>100 then raise exception 'Tax rate is out of range.'; end if;
  if rule->>'kind'='percent' and not (coalesce((rule->>'accommodation')::boolean,false) or coalesce((rule->>'cleaning')::boolean,false) or coalesce((rule->>'service')::boolean,false)) then raise exception 'Choose the charges each tax applies to.'; end if;
 end loop;
 insert into public.rental_listing_finance values(p_listing_id,p_time_zone,p_checkin_time,p_tax_rules,trim(p_review_notes),auth.uid(),now())
 on conflict(listing_id) do update set time_zone=excluded.time_zone,checkin_time=excluded.checkin_time,tax_rules=excluded.tax_rules,review_notes=excluded.review_notes,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at;
end $$;
revoke all on function public.configure_rental_listing_finance(uuid,text,time,jsonb,text) from public,anon;
grant execute on function public.configure_rental_listing_finance(uuid,text,time,jsonb,text) to authenticated;

create or replace function public.snapshot_rental_booking_finance()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare terms public.rental_listing_finance; rule jsonb; lines jsonb:='[]'; tax bigint:=0; host_tax bigint:=0; amount bigint; basis numeric; arrival timestamptz;
begin
 select * into terms from public.rental_listing_finance where listing_id=new.listing_id for share;
 if not found then raise exception 'This property is awaiting its tax and payout setup. Please contact the host.' using errcode='55000'; end if;
 arrival := (new.checkin_date+terms.checkin_time) at time zone terms.time_zone;
 for rule in select * from jsonb_array_elements(terms.tax_rules) loop
  if coalesce((rule->>'exemptCalendarMonth')::boolean,false) and new.checkout_date >= (new.checkin_date + interval '1 month')::date then continue; end if;
  if rule->>'kind'='per_night' then amount:=round((rule->>'rate')::numeric*new.nights*100);
  else
   basis:=case when coalesce((rule->>'accommodation')::boolean,false) then new.nightly_rate*new.nights else 0 end
     +case when coalesce((rule->>'cleaning')::boolean,false) then new.cleaning_fee else 0 end
     +case when coalesce((rule->>'service')::boolean,false) then new.service_fee else 0 end
     +case when coalesce((rule->>'includePriorTaxes')::boolean,false) then tax/100.0 else 0 end;
   amount:=round(basis*(rule->>'rate')::numeric);
  end if;
  tax:=tax+amount;
  if rule->>'recipient'='host' then host_tax:=host_tax+amount; end if;
  lines:=lines||jsonb_build_array(rule||jsonb_build_object('amountCents',amount));
 end loop;
 new.total:=new.total+tax/100.0;
 new.booking_payload:=coalesce(new.booking_payload,'{}')||jsonb_build_object(
  'payoutMode','delayed_transfer','taxAmountCents',tax,'taxBreakdown',lines,
  'hostAmountCents',round((new.nightly_rate*new.nights+new.cleaning_fee)*100)+host_tax,
  'checkinAt',arrival,'propertyTimeZone',terms.time_zone,'cancellationDeadline',arrival-interval '24 hours',
  'payoutDueAt',arrival+interval '24 hours','financialTermsVersion',terms.reviewed_at);
 return new;
end $$;
create trigger rental_finance_snapshot before insert on public.short_term_bookings for each row execute function public.snapshot_rental_booking_finance();
revoke all on function public.snapshot_rental_booking_finance() from public,anon,authenticated;

create or replace function public.insert_rental_booking_finance()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.rental_booking_finance(booking_id,booking_public_id,host_user_id,currency,total_cents,service_fee_cents,tax_cents,host_amount_cents,tax_breakdown,checkin_at,cancellation_deadline,payout_due_at)
 values(new.id,new.public_id,new.host_user_id,new.currency,round(new.total*100),round(new.service_fee*100),(new.booking_payload->>'taxAmountCents')::bigint,(new.booking_payload->>'hostAmountCents')::bigint,new.booking_payload->'taxBreakdown',(new.booking_payload->>'checkinAt')::timestamptz,(new.booking_payload->>'cancellationDeadline')::timestamptz,(new.booking_payload->>'payoutDueAt')::timestamptz);
 return new;
end $$;
create trigger rental_finance_insert after insert on public.short_term_bookings for each row execute function public.insert_rental_booking_finance();
revoke all on function public.insert_rental_booking_finance() from public,anon,authenticated;

-- Only money handlers can change the status; their audit payload may grow, but the quote never changes.
create or replace function public.protect_rental_financial_quote()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if old.booking_payload->>'payoutMode'='delayed_transfer' and (new.total is distinct from old.total or new.service_fee is distinct from old.service_fee or new.currency is distinct from old.currency or new.booking_payload is distinct from old.booking_payload or new.checkin_date is distinct from old.checkin_date or new.checkout_date is distinct from old.checkout_date) then
  raise exception 'Booking financial terms are immutable. Cancel and create a new booking.';
 end if;
 return new;
end $$;
create trigger rental_finance_immutable before update on public.short_term_bookings for each row execute function public.protect_rental_financial_quote();
revoke all on function public.protect_rental_financial_quote() from public,anon,authenticated;

alter table public.rental_notification_outbox add column attempts integer not null default 0,
 add column next_attempt_at timestamptz not null default now(),add column last_attempt_at timestamptz;

create or replace function public.get_rental_maintenance_bookings()
returns setof jsonb language sql security definer set search_path=public,pg_temp as $$
 select to_jsonb(b)||jsonb_build_object('finance',to_jsonb(f)) from public.short_term_bookings b
 join public.rental_booking_finance f on f.booking_id=b.id
 where f.next_attempt_at<=now() and (
  (f.payout_status in ('pending','held') and b.status='confirmed' and b.payment_status='paid' and f.payout_due_at<=now())
  or (f.stripe_transfer_id is not null and f.payout_status<>'reversed' and (b.status in ('cancelled','declined') or b.payment_status in ('refunded','disputed'))))
 order by f.next_attempt_at limit 10;
$$;
revoke all on function public.get_rental_maintenance_bookings() from public,anon,authenticated;
grant execute on function public.get_rental_maintenance_bookings() to service_role;

create or replace function public.get_rental_finance_admin()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_admin_user() then raise exception 'Administrator access required.' using errcode='42501'; end if;
 return jsonb_build_object('listings',(select coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('finance',to_jsonb(f))),'[]') from (select id,public_id,title,city,country,currency,listing_payload from short_term_listings where status<>'archived' order by created_at desc limit 100) l left join rental_listing_finance f on f.listing_id=l.id),
 'payouts',(select coalesce(jsonb_agg(to_jsonb(f)),'[]') from (select * from rental_booking_finance order by created_at desc limit 100) f),
 'pendingEmails',(select count(*) from rental_notification_outbox where sent_at is null));
end $$;
revoke all on function public.get_rental_finance_admin() from public,anon;
grant execute on function public.get_rental_finance_admin() to authenticated;

alter table public.short_term_bookings drop constraint short_term_bookings_payment_status_check;
alter table public.short_term_bookings add constraint short_term_bookings_payment_status_check check(payment_status in ('unpaid','requires_payment_method','authorized','paid','processing','cancelled','refunded','failed','disputed'));
create or replace function public.guard_short_term_payment_transition()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if old.payment_status='refunded' and new.payment_status<>'refunded' then return null; end if;
 if old.stripe_payment_intent_id is not distinct from new.stripe_payment_intent_id then
  if old.payment_status='paid' and new.payment_status in ('unpaid','requires_payment_method','authorized','processing','failed','cancelled')
   and not(new.status in ('cancelled','declined') and new.payment_status='processing' and (coalesce(new.payment_payload->>'stripeRefundId','')<>'' or coalesce(new.payment_payload->>'latePaymentRefundId','')<>'')) then return null; end if;
  if old.payment_status='authorized' and new.payment_status in ('unpaid','requires_payment_method','failed') then return null; end if;
 end if;
 new.payment_payload:=coalesce(old.payment_payload,'{}')||coalesce(new.payment_payload,'{}');return new;
end $$;

create table public.rental_bank_payouts (
 stripe_payout_id text primary key,stripe_account_id text not null,amount_cents bigint not null,currency text not null,
 status text not null,arrival_date timestamptz,failure_message text,updated_at timestamptz not null default now()
);
alter table public.rental_bank_payouts enable row level security;
revoke all on public.rental_bank_payouts from public,anon,authenticated;
grant select on public.rental_bank_payouts to authenticated;
grant all on public.rental_bank_payouts to service_role;
create policy rental_bank_payout_read on public.rental_bank_payouts for select to authenticated using(public.is_admin_user() or exists(select 1 from public.stripe_connected_accounts a where a.stripe_account_id=rental_bank_payouts.stripe_account_id and a.user_id=auth.uid()));

create or replace function public.claim_short_term_payment_action(p_booking_public_id text, p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare token uuid := gen_random_uuid();
begin
    update public.short_term_bookings set payment_action_token = token, payment_action_expires_at = now() + interval '5 minutes'
    where public_id = p_booking_public_id
      and (guest_user_id = p_actor_id or host_user_id = p_actor_id or exists (select 1 from public.profiles where id = p_actor_id and is_admin))
      and (payment_action_token is null or payment_action_expires_at < now());
    if not found then raise exception 'Another payment action is in progress. Refresh and retry.' using errcode = '40001'; end if;
    return token;
end;
$$;
