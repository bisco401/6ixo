-- Keep property photos separate from private ID and property proof documents.
-- Lock the application to serialize uploads and submission for each applicant.
create or replace function public.enforce_host_property_photo_upload_limit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
    photo_count integer;
begin
    if new.document_type <> 'property_photo' then return new; end if;
    perform 1 from public.host_applications where id = new.application_id for update;
    if new.mime_type is null or new.mime_type not in ('image/jpeg', 'image/png', 'image/webp')
       or new.size_bytes is null or new.size_bytes <= 0 or new.size_bytes > 10485760 then
        raise exception 'Property photos must be non-empty JPEG, PNG, or WebP images up to 10 MB.' using errcode = '22023';
    end if;
    select count(*) into photo_count from public.host_application_documents
    where application_id = new.application_id and document_type = 'property_photo' and id <> new.id;
    if photo_count >= 30 then
        raise exception 'You can upload up to 30 property photos per application.' using errcode = '22023';
    end if;
    return new;
end;
$$;
revoke all on function public.enforce_host_property_photo_upload_limit() from public, anon, authenticated;
create trigger host_property_photo_upload_limit before insert or update on public.host_application_documents
for each row execute function public.enforce_host_property_photo_upload_limit();

create or replace function public.validate_host_application_property_photo_count()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
    photo_count integer;
begin
    select count(*) into photo_count
    from public.host_application_documents d
    join storage.objects o on o.bucket_id = 'host-documents' and o.name = d.storage_path
    where d.application_id = new.id and d.user_id = new.user_id
      and d.document_type = 'property_photo'
      and d.mime_type in ('image/jpeg', 'image/png', 'image/webp')
      and d.size_bytes > 0 and d.size_bytes <= 10485760;
    if photo_count < 5 or photo_count > 30 then
        raise exception 'Upload between 5 and 30 property photos before submitting.' using errcode = '22023';
    end if;
    new.doc_property_photos := true;
    return new;
end;
$$;
revoke all on function public.validate_host_application_property_photo_count() from public, anon, authenticated;
create trigger host_application_property_photo_count before update on public.host_applications
for each row when (not old.ready_for_review and new.ready_for_review)
execute function public.validate_host_application_property_photo_count();
