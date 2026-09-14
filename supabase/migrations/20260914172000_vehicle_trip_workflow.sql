-- Private licence evidence, pickup/return condition records, and issue review.
create table public.vehicle_rental_booking_documents (
 id uuid primary key default gen_random_uuid(), booking_id uuid not null references vehicle_rental_bookings(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade, document_type text not null check(document_type='driver_license'),
 storage_path text not null unique, file_name text not null, created_at timestamptz not null default now(), unique(booking_id,document_type)
);
create table public.vehicle_trip_state (
 booking_id uuid primary key references vehicle_rental_bookings(id) on delete cascade,
 driver_review_status text not null default 'pending' check(driver_review_status in ('pending','approved','rejected')),
 driver_review_notes text, driver_reviewed_by uuid references auth.users(id),driver_reviewed_at timestamptz,
 picked_up_at timestamptz,returned_at timestamptz
);
create table public.vehicle_trip_checks (
 id uuid primary key default gen_random_uuid(),booking_id uuid not null references vehicle_rental_bookings(id) on delete cascade,
 user_id uuid not null references auth.users(id),phase text not null check(phase in ('pickup','return')),
 odometer numeric not null check(odometer>=0),fuel_percent integer not null check(fuel_percent between 0 and 100),notes text not null default '',
 photo_paths text[] not null,created_at timestamptz not null default now(),unique(booking_id,user_id,phase)
);
create table public.vehicle_trip_issues (
 id uuid primary key default gen_random_uuid(),booking_id uuid not null references vehicle_rental_bookings(id) on delete cascade,
 user_id uuid not null references auth.users(id),details text not null check(length(details)>=10),
 status text not null default 'open' check(status in ('open','resolved')),resolution text,resolved_by uuid references auth.users(id),created_at timestamptz not null default now(),resolved_at timestamptz
);
create or replace function public.can_view_vehicle_trip(p_booking_id uuid)
returns boolean language sql security definer set search_path=public,pg_temp stable as $$
 select auth.uid() is not null and (public.is_admin_user() or exists(select 1 from vehicle_rental_bookings where id=p_booking_id and auth.uid() in(host_user_id,guest_user_id)));
$$;
revoke all on function public.can_view_vehicle_trip(uuid) from public,anon;grant execute on function public.can_view_vehicle_trip(uuid) to authenticated;
do $$ declare t text;begin
 foreach t in array array['vehicle_rental_booking_documents','vehicle_trip_state','vehicle_trip_checks','vehicle_trip_issues'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 execute format('create policy participant_read on public.%I for select to authenticated using(public.can_view_vehicle_trip(booking_id))',t);
 end loop;
end $$;
grant insert on vehicle_rental_booking_documents to authenticated;
create policy guest_license_upload on vehicle_rental_booking_documents for insert to authenticated with check(
 user_id=auth.uid() and exists(select 1 from vehicle_rental_bookings b where b.id=booking_id and b.guest_user_id=auth.uid() and b.status in ('requested','confirmed'))
 and split_part(storage_path,'/',1)=auth.uid()::text and split_part(storage_path,'/',2)=booking_id::text
 and exists(select 1 from storage.objects o where o.bucket_id='vehicle-trip-documents' and o.name=storage_path)
);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('vehicle-trip-documents','vehicle-trip-documents',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf']) on conflict(id) do nothing;
create policy vehicle_trip_upload on storage.objects for insert to authenticated with check(bucket_id='vehicle-trip-documents'
 and split_part(name,'/',1)=auth.uid()::text and exists(select 1 from vehicle_rental_bookings b where b.id::text=split_part(name,'/',2) and auth.uid() in(b.host_user_id,b.guest_user_id) and b.status in ('requested','confirmed')));
create policy vehicle_trip_private_read on storage.objects for select to authenticated using(bucket_id='vehicle-trip-documents'
 and exists(select 1 from vehicle_rental_bookings b where b.id::text=split_part(name,'/',2) and public.can_view_vehicle_trip(b.id)));
create policy vehicle_trip_cleanup on storage.objects for delete to authenticated using(bucket_id='vehicle-trip-documents' and split_part(name,'/',1)=auth.uid()::text
 and not exists(select 1 from vehicle_rental_booking_documents d where d.storage_path=name)
 and not exists(select 1 from vehicle_trip_checks c where name=any(c.photo_paths)));

create or replace function public.initialize_vehicle_trip()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin insert into vehicle_trip_state(booking_id) values(new.id);return new;end $$;
create trigger vehicle_trip_init after insert on vehicle_rental_bookings for each row execute function initialize_vehicle_trip();
insert into vehicle_trip_state(booking_id) select id from vehicle_rental_bookings on conflict do nothing;
revoke all on function public.initialize_vehicle_trip() from public,anon,authenticated;

create or replace function public.review_vehicle_trip_driver(p_booking_public_id text,p_status text,p_notes text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.vehicle_rental_bookings;
begin
 select * into b from vehicle_rental_bookings where public_id=p_booking_public_id for update;
 if not found or auth.uid() is null or (auth.uid()<>b.host_user_id and not public.is_admin_user()) then raise exception 'Host or administrator access required.' using errcode='42501'; end if;
 if b.status not in ('requested','confirmed') or p_status not in ('approved','rejected') or length(trim(coalesce(p_notes,'')))<10 then raise exception 'Record the driver identity and licence review.'; end if;
 if exists(select 1 from vehicle_trip_state where booking_id=b.id and picked_up_at is not null) then raise exception 'Driver review cannot change after pickup.'; end if;
 if not exists(select 1 from vehicle_rental_booking_documents d join storage.objects o on o.bucket_id='vehicle-trip-documents' and o.name=d.storage_path where d.booking_id=b.id and d.user_id=b.guest_user_id) then raise exception 'The guest must upload their licence first.'; end if;
 update vehicle_trip_state set driver_review_status=p_status,driver_review_notes=trim(p_notes),driver_reviewed_by=auth.uid(),driver_reviewed_at=now() where booking_id=b.id;
end $$;
revoke all on function public.review_vehicle_trip_driver(text,text,text) from public,anon;grant execute on function public.review_vehicle_trip_driver(text,text,text) to authenticated;

create or replace function public.record_vehicle_trip_check(p_booking_public_id text,p_phase text,p_odometer numeric,p_fuel_percent integer,p_notes text,p_photo_paths text[])
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.vehicle_rental_bookings;s public.vehicle_trip_state;previous numeric;photo text;
begin
 select * into b from vehicle_rental_bookings where public_id=p_booking_public_id for update;
 if not found or auth.uid() is null or auth.uid() not in(b.host_user_id,b.guest_user_id) then raise exception 'Booking participant access required.' using errcode='42501'; end if;
 select * into s from vehicle_trip_state where booking_id=b.id for update;
 if b.status<>'confirmed' or b.payment_status<>'paid' then raise exception 'A confirmed paid booking is required.'; end if;
 if p_phase not in ('pickup','return') or p_odometer is null or p_odometer<0 or p_fuel_percent is null or p_fuel_percent not between 0 and 100 then raise exception 'Valid odometer and fuel/charge readings are required.'; end if;
 if p_phase='pickup' and (s.driver_review_status<>'approved' or now()<(b.booking_payload->>'pickupAt')::timestamptz-interval '1 hour' or now()>=(b.booking_payload->>'returnAt')::timestamptz or s.returned_at is not null) then raise exception 'Review the driver and complete pickup around the scheduled trip start.'; end if;
 if p_phase='return' and s.picked_up_at is null then raise exception 'Complete pickup first.'; end if;
 if coalesce(array_length(p_photo_paths,1),0)<2 or array_length(p_photo_paths,1)>12 then raise exception 'Add between 2 and 12 trip condition photos.'; end if;
 foreach photo in array p_photo_paths loop
 if split_part(photo,'/',1)<>auth.uid()::text or split_part(photo,'/',2)<>b.id::text or not exists(select 1 from storage.objects where bucket_id='vehicle-trip-documents' and name=photo and lower(coalesce(metadata->>'mimetype','')) in ('image/jpeg','image/png','image/webp')) then raise exception 'Upload private condition photos for this trip.'; end if;
 end loop;
 if p_phase='return' then
 select max(odometer) into previous from vehicle_trip_checks where booking_id=b.id and phase='pickup';
 if p_odometer<previous then raise exception 'Return odometer cannot be below the pickup reading.'; end if;
 end if;
 insert into vehicle_trip_checks(booking_id,user_id,phase,odometer,fuel_percent,notes,photo_paths) values(b.id,auth.uid(),p_phase,p_odometer,p_fuel_percent,coalesce(p_notes,''),p_photo_paths);
 -- The host records handover; both participants retain their own evidence.
 if auth.uid()=b.host_user_id then
 update vehicle_trip_state set picked_up_at=case when p_phase='pickup' then coalesce(picked_up_at,now()) else picked_up_at end,
 returned_at=case when p_phase='return' then coalesce(returned_at,now()) else returned_at end where booking_id=b.id;
 end if;
end $$;
revoke all on function public.record_vehicle_trip_check(text,text,numeric,integer,text,text[]) from public,anon;grant execute on function public.record_vehicle_trip_check(text,text,numeric,integer,text,text[]) to authenticated;

create or replace function public.report_vehicle_trip_issue(p_booking_public_id text,p_details text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.vehicle_rental_bookings; result uuid;
begin
 select * into b from vehicle_rental_bookings where public_id=p_booking_public_id for update;
 if not found or not public.can_view_vehicle_trip(b.id) then raise exception 'Booking participant access required.' using errcode='42501'; end if;
 if length(trim(coalesce(p_details,'')))<10 then raise exception 'Describe the trip issue.'; end if;
 insert into vehicle_trip_issues(booking_id,user_id,details) values(b.id,auth.uid(),trim(p_details)) returning id into result;
 update vehicle_booking_finance set payout_status=case when payout_status='pending' then 'held' else payout_status end,last_error='Trip issue awaiting administrator review.' where booking_id=b.id;
 insert into vehicle_notification_outbox(booking_id,recipient_user_id,recipient_role,event_type,event_version)
 select b.id,id,'admin','trip_issue',now() from profiles where is_admin;
 return result;
end $$;
revoke all on function public.report_vehicle_trip_issue(text,text) from public,anon;grant execute on function public.report_vehicle_trip_issue(text,text) to authenticated;
create or replace function public.resolve_vehicle_trip_issue(p_issue_id uuid,p_resolution text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_admin_user() then raise exception 'Administrator access required.' using errcode='42501'; end if;
 if length(trim(coalesce(p_resolution,'')))<10 then raise exception 'Record how the issue was resolved.'; end if;
 update vehicle_trip_issues set status='resolved',resolution=p_resolution,resolved_by=auth.uid(),resolved_at=now() where id=p_issue_id;
end $$;
revoke all on function public.resolve_vehicle_trip_issue(uuid,text) from public,anon;grant execute on function public.resolve_vehicle_trip_issue(uuid,text) to authenticated;

create unique index vehicle_booking_email_once on vehicle_notification_outbox(booking_id,recipient_user_id,event_type,event_version) where booking_id is not null;
alter table vehicle_notification_outbox add constraint vehicle_notification_source check(num_nonnulls(application_id,booking_id)=1);
create or replace function public.queue_vehicle_booking_notification()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare event_name text;version_at timestamptz:=now();
begin
 if tg_op='UPDATE' and old.status=new.status and old.payment_status=new.payment_status then return new;end if;
 event_name:=case when new.payment_status='refunded' then 'booking_refunded'
 when new.status='declined' then 'booking_declined' when new.status='cancelled' then 'booking_cancelled'
 when new.status='confirmed' and new.payment_status='paid' then 'booking_confirmed'
 when new.status='requested' and new.payment_status='authorized' then 'booking_requested' else null end;
 if event_name is null then return new;end if;
 insert into vehicle_notification_outbox(booking_id,recipient_user_id,recipient_role,event_type,event_version)
 values(new.id,new.guest_user_id,'guest',event_name,version_at),(new.id,new.host_user_id,'host',event_name,version_at);
 return new;
end $$;
create trigger vehicle_booking_notifications after insert or update on vehicle_rental_bookings for each row execute function queue_vehicle_booking_notification();
revoke all on function public.queue_vehicle_booking_notification() from public,anon,authenticated;

create or replace function public.get_vehicle_trip_details(p_booking_public_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.vehicle_rental_bookings; payload jsonb;
begin
 select * into b from vehicle_rental_bookings where public_id=p_booking_public_id;
 if not found or not public.can_view_vehicle_trip(b.id) then raise exception 'Booking participant access required.' using errcode='42501';end if;
 payload:=to_jsonb(b);
 if b.payment_status<>'paid' then payload:=jsonb_set(payload,'{booking_payload}',b.booking_payload-'pickupInstructions'-'returnInstructions'); end if;
 return jsonb_build_object('booking',payload,'state',(select to_jsonb(s) from vehicle_trip_state s where booking_id=b.id),
 'documents',(select coalesce(jsonb_agg(to_jsonb(d)),'[]') from vehicle_rental_booking_documents d where booking_id=b.id),
 'checks',(select coalesce(jsonb_agg(to_jsonb(c) order by created_at),'[]') from vehicle_trip_checks c where booking_id=b.id),
 'issues',(select coalesce(jsonb_agg(to_jsonb(i) order by created_at),'[]') from vehicle_trip_issues i where booking_id=b.id),
 'finance',(select to_jsonb(f) from vehicle_booking_finance f where booking_id=b.id));
end $$;
revoke all on function public.get_vehicle_trip_details(text) from public,anon;grant execute on function public.get_vehicle_trip_details(text) to authenticated;

create or replace function public.get_vehicle_rental_operations()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_admin_user() then raise exception 'Administrator access required.' using errcode='42501'; end if;
 return jsonb_build_object('listings',(select coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('finance',to_jsonb(f))),'[]') from (select id,public_id,title,city,country,currency,status,user_id,listing_payload from marketplace_listings where category='vehicles' and subcategory='rentals' and status<>'archived' order by created_at desc limit 100) l left join vehicle_listing_finance f on f.listing_id=l.id),
 'payouts',(select coalesce(jsonb_agg(to_jsonb(f)),'[]') from(select * from vehicle_booking_finance order by created_at desc limit 100) f),
 'issues',(select coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('booking_public_id',b.public_id)),'[]') from vehicle_trip_issues i join vehicle_rental_bookings b on b.id=i.booking_id where i.status='open'),
 'pendingEmails',(select count(*) from vehicle_notification_outbox where sent_at is null));
end $$;
revoke all on function public.get_vehicle_rental_operations() from public,anon;grant execute on function public.get_vehicle_rental_operations() to authenticated;
