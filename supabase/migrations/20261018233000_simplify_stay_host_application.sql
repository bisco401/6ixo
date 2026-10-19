-- Optional hosting notes replace mandatory essays. Proof flags reflect uploaded files.
-- Existing photo-count, approval, privacy, and notification checks remain in force.
create or replace function public.mark_my_host_application_pending()
returns public.profiles language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
    caller_id uuid := auth.uid();
    application public.host_applications%rowtype;
    result_row public.profiles%rowtype;
begin
    if caller_id is null then raise exception 'Authentication required.' using errcode = '42501'; end if;
    select * into application from public.host_applications where user_id = caller_id for update;
    if not found or application.status <> 'pending' then
        raise exception 'A pending host application is required.' using errcode = '42501';
    end if;
    if not exists (select 1 from auth.users where id = caller_id and email_confirmed_at is not null) then
        raise exception 'Verified email required.' using errcode = '42501';
    end if;
    if not application.rules_acknowledged or nullif(trim(application.legal_name), '') is null
       or nullif(trim(application.phone), '') is null
       or nullif(trim(application.country), '') is null or nullif(trim(application.listing_city), '') is null
       or nullif(trim(application.property_type), '') is null
       or coalesce(application.bedrooms, -1) < 0 or coalesce(application.bathrooms, 0) <= 0
       or coalesce(application.max_guest_capacity, 0) < 1 then
        raise exception 'Complete the host application before submitting.' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.host_application_documents d join storage.objects o
        on o.bucket_id = 'host-documents' and o.name = d.storage_path
        where d.application_id = application.id and d.user_id = caller_id
          and d.document_type in ('government_id', 'property_proof', 'business_registration', 'other')
    ) then raise exception 'Upload an ID or property proof document before submitting.' using errcode = '22023'; end if;
    update public.host_applications set ready_for_review = true,
        doc_government_id = exists (select 1 from public.host_application_documents d join storage.objects o on o.bucket_id = 'host-documents' and o.name = d.storage_path where d.application_id = application.id and d.user_id = caller_id and d.document_type = 'government_id'),
        doc_property_proof = exists (select 1 from public.host_application_documents d join storage.objects o on o.bucket_id = 'host-documents' and o.name = d.storage_path where d.application_id = application.id and d.user_id = caller_id and d.document_type = 'property_proof'),
        doc_business_registration = exists (select 1 from public.host_application_documents d join storage.objects o on o.bucket_id = 'host-documents' and o.name = d.storage_path where d.application_id = application.id and d.user_id = caller_id and d.document_type = 'business_registration'),
        submitted_at = case when ready_for_review then submitted_at else now() end,
        email = (select lower(trim(email)) from auth.users where id = caller_id)
    where id = application.id;
    update public.profiles set host_status = 'pending', host_email_verified = true,
        host_approved_at = null, host_rejected_at = null, host_review_notes = null, updated_at = now()
    where id = caller_id returning * into result_row;
    if not found then raise exception 'Applicant profile not found.' using errcode = '42501'; end if;
    return result_row;
end;
$$;
revoke all on function public.mark_my_host_application_pending() from public, anon;
grant execute on function public.mark_my_host_application_pending() to authenticated;
