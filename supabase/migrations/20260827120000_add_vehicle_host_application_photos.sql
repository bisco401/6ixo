-- Allow vehicle owners and rental operators to attach representative vehicle
-- photos to their private provider application alongside compliance documents.
alter table public.vehicle_host_application_documents
    drop constraint if exists vehicle_host_application_documents_type_check;

alter table public.vehicle_host_application_documents
    add constraint vehicle_host_application_documents_type_check
    check (document_type in (
        'vehicle_driver_license',
        'vehicle_registration',
        'vehicle_rental_insurance',
        'vehicle_photo'
    )) not valid;

alter table public.vehicle_host_application_documents
    validate constraint vehicle_host_application_documents_type_check;

create index if not exists vehicle_host_application_photos_application_idx
    on public.vehicle_host_application_documents (application_id, created_at desc)
    where document_type = 'vehicle_photo';
