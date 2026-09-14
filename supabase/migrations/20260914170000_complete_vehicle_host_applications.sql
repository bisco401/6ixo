-- Complete car host submission and make email delivery durable.
alter table public.vehicle_host_applications add column if not exists ready_for_review boolean not null default false;
update public.vehicle_host_applications set ready_for_review=true where status<>'pending';

create or replace function public.prepare_vehicle_host_application_draft()
returns trigger language plpgsql set search_path = public, auth, pg_temp as $$
begin
    if current_user in ('authenticated', 'anon') then
        if auth.uid() is null or new.user_id <> auth.uid() then
            raise exception 'Your own host application is required.' using errcode = '42501';
        end if;
        if tg_op = 'UPDATE' and old.ready_for_review and old.status in ('pending', 'approved') then
            raise exception 'This application is already under review or approved.' using errcode = '42501';
        end if;
        new.ready_for_review := false;
        new.status := 'pending';
        new.reviewed_at := null;
        new.reviewed_by := null;
        new.review_notes := null;
        new.submitted_at := now();
        new.email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
        if new.email = '' then raise exception 'Account email is required.' using errcode = '22023'; end if;
    end if;
    return new;
end;
$$;
drop trigger if exists vehicle_host_application_prepare_draft on public.vehicle_host_applications;
create trigger vehicle_host_application_prepare_draft before insert or update on public.vehicle_host_applications
for each row execute function public.prepare_vehicle_host_application_draft();

-- A user cannot attach another user's document or a path without an uploaded object.
drop policy if exists vehicle_host_application_documents_insert_own on public.vehicle_host_application_documents;
create policy vehicle_host_application_documents_insert_own on public.vehicle_host_application_documents for insert to authenticated
with check (
    auth.uid() = user_id
    and exists (select 1 from public.vehicle_host_applications a where a.id = application_id and a.user_id = auth.uid() and not a.ready_for_review)
    and split_part(storage_path, '/', 1) = auth.uid()::text
    and split_part(storage_path, '/', 2) = application_id::text
    and exists (select 1 from storage.objects o where o.bucket_id = 'host-documents' and o.name = storage_path)
);
drop policy if exists vehicle_host_application_documents_delete_own_or_admin on public.vehicle_host_application_documents;
create policy vehicle_host_application_documents_delete_own_or_admin on public.vehicle_host_application_documents for delete to authenticated
using (public.is_admin_user() or (auth.uid() = user_id and exists (
    select 1 from public.vehicle_host_applications a where a.id = application_id and a.user_id = auth.uid() and not a.ready_for_review
)));

create table if not exists public.vehicle_notification_outbox (
    id uuid primary key default gen_random_uuid(),
    application_id uuid references public.vehicle_host_applications(id) on delete cascade,
    recipient_user_id uuid not null references auth.users(id) on delete cascade,
    recipient_role text not null check (recipient_role in ('host', 'admin', 'guest')),
    event_type text not null ,
    event_version timestamptz not null,
    created_at timestamptz not null default now(),
    sent_at timestamptz,
    attempts integer not null default 0, next_attempt_at timestamptz not null default now(), last_attempt_at timestamptz,
    booking_id uuid references public.vehicle_rental_bookings(id) on delete cascade,
    last_error text,
    unique (application_id, recipient_user_id, event_type, event_version)
);
alter table public.vehicle_notification_outbox enable row level security;
revoke all on public.vehicle_notification_outbox from public, anon, authenticated;
grant select on public.vehicle_notification_outbox to authenticated;
grant all on public.vehicle_notification_outbox to service_role;
create policy rental_notification_recipient_select on public.vehicle_notification_outbox for select to authenticated
using (auth.uid() = recipient_user_id or public.is_admin_user());

create or replace function public.queue_vehicle_host_application_notification()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
    event_name text;
    version_at timestamptz;
begin
    if not new.ready_for_review then return new; end if;
    if tg_op = 'UPDATE' and old.ready_for_review and old.status = new.status then return new; end if;
    event_name := case when new.status = 'pending' then 'submitted' else new.status end;
    version_at := case when new.status = 'pending' then new.submitted_at else new.reviewed_at end;
    insert into public.vehicle_notification_outbox(application_id, recipient_user_id, recipient_role, event_type, event_version)
    values(new.id, new.user_id, 'host', event_name, coalesce(version_at, now())) on conflict do nothing;
    if new.status = 'pending' then
        insert into public.vehicle_notification_outbox(application_id, recipient_user_id, recipient_role, event_type, event_version)
        select new.id, p.id, 'admin', event_name, coalesce(version_at, now()) from public.profiles p
        where p.is_admin and p.id <> new.user_id on conflict do nothing;
    end if;
    return new;
end;
$$;
revoke all on function public.queue_vehicle_host_application_notification() from public, anon, authenticated;
create trigger vehicle_host_application_notification after insert or update on public.vehicle_host_applications
for each row execute function public.queue_vehicle_host_application_notification();



create or replace function public.assert_vehicle_application_complete(p_application_id uuid)
returns void language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare a public.vehicle_host_applications;
begin
 select * into a from vehicle_host_applications where id=p_application_id;
 if not found or not exists(select 1 from auth.users where id=a.user_id and email_confirmed_at is not null) then raise exception 'Verified applicant email required.'; end if;
 if not (a.owns_vehicles or a.has_rental_authorization) or not a.has_valid_driver_license or not a.vehicles_registered
 or not a.has_rental_insurance or not a.vehicles_roadworthy or not a.has_maintenance_plan or not a.has_roadside_support
 or not a.complies_local_laws or not a.agrees_vehicle_safety or not a.agrees_renter_verification or not a.agrees_truthful_listing or not a.rules_acknowledged
 or length(trim(a.legal_name))<2 or length(trim(a.rental_city))<2 or length(trim(a.country))<2
 or length(trim(a.insurance_provider))<2 or length(trim(a.insurance_policy_number))<2 or length(trim(a.phone))<5 then
 raise exception 'Complete the ownership, rental insurance, safety, and provider requirements before submission.'; end if;
 if exists(select 1 from unnest(array['vehicle_driver_license','vehicle_registration','vehicle_rental_insurance','vehicle_photo']) required(kind)
 where not exists(select 1 from vehicle_host_application_documents d join storage.objects o on o.bucket_id='host-documents' and o.name=d.storage_path
 where d.application_id=a.id and d.user_id=a.user_id and d.document_type=required.kind
 and split_part(d.storage_path,'/',1)=a.user_id::text and split_part(d.storage_path,'/',2)=a.id::text)) then
 raise exception 'Upload your driver licence, registration, rental-use insurance, and at least one vehicle photo.'; end if;
end $$;
revoke all on function public.assert_vehicle_application_complete(uuid) from public,anon,authenticated;

create or replace function public.mark_my_vehicle_host_application_pending()
returns public.profiles language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare a public.vehicle_host_applications; result public.profiles;
begin
 if auth.uid() is null then raise exception 'Authentication required.' using errcode='42501'; end if;
 select * into a from vehicle_host_applications where user_id=auth.uid() for update;
 if not found or a.status<>'pending' then raise exception 'A pending car host application is required.'; end if;
 perform public.assert_vehicle_application_complete(a.id);
 update vehicle_host_applications set ready_for_review=true,submitted_at=case when ready_for_review then submitted_at else now() end,
 email=(select lower(trim(email)) from auth.users where id=auth.uid()) where id=a.id;
 update profiles set vehicle_host_status='pending',vehicle_host_email_verified=true,vehicle_host_approved_at=null,
 vehicle_host_rejected_at=null,vehicle_host_review_notes=null where id=auth.uid() returning * into result;
 return result;
end $$;
revoke all on function public.mark_my_vehicle_host_application_pending() from public,anon;
grant execute on function public.mark_my_vehicle_host_application_pending() to authenticated;

create or replace function public.review_vehicle_host_application(
    p_application_id uuid,
    p_status text,
    p_review_notes text default null
)
returns public.vehicle_host_applications
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
    caller_id uuid := auth.uid();
    next_status text := lower(trim(coalesce(p_status, '')));
    review_notes_value text := nullif(trim(coalesce(p_review_notes, '')), '');
    reviewed_at_value timestamptz := now();
    application_row public.vehicle_host_applications%rowtype;
    email_is_verified boolean := false;
begin
    if caller_id is null or public.is_admin_user() = false then
        raise exception 'Administrator access required.' using errcode = '42501';
    end if;
    if p_application_id is null or next_status not in ('approved', 'rejected', 'needs_more_info') then
        raise exception 'Unsupported car rental review status.' using errcode = '22023';
    end if;
    select * into application_row
      from public.vehicle_host_applications
     where id = p_application_id
     for update;
    if not found then raise exception 'Car rental application not found.' using errcode = '22023'; end if;

    if not application_row.ready_for_review then raise exception 'This application is a draft.'; end if;
    if application_row.status=next_status then return application_row; end if;
    if application_row.status<>'pending' then raise exception 'Only submitted pending applications can be reviewed.'; end if;
    if next_status<>'approved' and length(coalesce(review_notes_value,''))<3 then raise exception 'Explain the decision to the host.'; end if;
    if next_status='approved' then perform public.assert_vehicle_application_complete(application_row.id); end if;
    if next_status = 'approved' and exists (
        select 1
          from unnest(array['vehicle_driver_license', 'vehicle_registration', 'vehicle_rental_insurance']::text[]) required(document_type)
         where not exists (
             select 1 from public.vehicle_host_application_documents document
             where document.application_id = application_row.id
               and document.user_id = application_row.user_id
               and lower(trim(document.document_type)) = required.document_type
         )
    ) then
        raise exception 'All three required vehicle documents must be uploaded before approval.' using errcode = '22023';
    end if;

    update public.vehicle_host_applications
       set status = next_status,
           reviewed_at = reviewed_at_value,
           reviewed_by = caller_id,
           review_notes = review_notes_value
     where id = application_row.id
     returning * into application_row;

    select user_row.email_confirmed_at is not null
      into email_is_verified
      from auth.users user_row
     where user_row.id = application_row.user_id;

    update public.profiles
       set vehicle_host_status = next_status,
           vehicle_host_email_verified = coalesce(email_is_verified, false),
           vehicle_host_review_notes = review_notes_value,
           vehicle_host_approved_at = case when next_status = 'approved' then reviewed_at_value else null end,
           vehicle_host_rejected_at = case when next_status = 'rejected' then reviewed_at_value else null end,
           updated_at = reviewed_at_value
     where id = application_row.user_id;
    if not found then raise exception 'Applicant profile not found.' using errcode = '42501'; end if;
    return application_row;
end;
$$;

revoke all on function public.review_vehicle_host_application(uuid, text, text) from public, anon;
grant execute on function public.review_vehicle_host_application(uuid, text, text) to authenticated;



create or replace function public.protect_vehicle_host_profile()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if current_user in ('authenticated','anon') and (
 new.vehicle_host_status is distinct from old.vehicle_host_status or new.vehicle_host_email_verified is distinct from old.vehicle_host_email_verified
 or new.vehicle_host_approved_at is distinct from old.vehicle_host_approved_at or new.vehicle_host_rejected_at is distinct from old.vehicle_host_rejected_at
 or new.vehicle_host_review_notes is distinct from old.vehicle_host_review_notes) then raise exception 'Car host approval is managed by the review process.' using errcode='42501'; end if;
 return new;
end $$;
create trigger vehicle_host_profile_guard before update on public.profiles for each row execute function public.protect_vehicle_host_profile();
revoke all on function public.protect_vehicle_host_profile() from public,anon,authenticated;
