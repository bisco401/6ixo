drop function if exists public.get_active_ad_campaigns_for_delivery(text, text, text, text);

create function public.get_active_ad_campaigns_for_delivery(
    p_country text default null,
    p_region text default null,
    p_city text default null,
    p_category text default null
)
returns table (
    id uuid,
    name text,
    placement text,
    resource_type text,
    resource_id text,
    creative_title text,
    creative_image_url text,
    destination_url text,
    target_country text,
    target_region text,
    target_city text,
    target_category text,
    starts_at timestamptz,
    ends_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
    select
        c.id, c.name, c.placement, c.resource_type, c.resource_id,
        c.creative_title, c.creative_image_url, c.destination_url,
        c.target_country, c.target_region, c.target_city, c.target_category,
        c.starts_at, c.ends_at
    from public.ad_campaigns c
    where c.status = 'active'
      and c.starts_at <= timezone('utc', now())
      and c.ends_at > timezone('utc', now())
      and (nullif(trim(c.target_country), '') is null or lower(trim(c.target_country)) = lower(trim(coalesce(p_country, ''))))
      and (nullif(trim(c.target_region), '') is null or lower(trim(c.target_region)) = lower(trim(coalesce(p_region, ''))))
      and (nullif(trim(c.target_city), '') is null or lower(trim(c.target_city)) = lower(trim(coalesce(p_city, ''))))
      and (
          nullif(trim(c.target_category), '') is null
          or nullif(trim(coalesce(p_category, '')), '') is null
          or lower(trim(c.target_category)) = lower(trim(p_category))
      )
    order by c.created_at desc
    limit 100;
$$;

revoke all on function public.get_active_ad_campaigns_for_delivery(text, text, text, text) from public;
grant execute on function public.get_active_ad_campaigns_for_delivery(text, text, text, text) to anon, authenticated;
