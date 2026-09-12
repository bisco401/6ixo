import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function createRentalTestDatabase() {
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage; create schema extensions; create schema realtime;
create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.role() returns text language sql stable as $$select current_user::text$$;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, owner_id text, metadata jsonb);
alter table storage.objects enable row level security;
create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
grant usage on schema public,auth,storage to anon,authenticated,service_role;
grant select on auth.users to service_role;
grant all on storage.objects to authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
create publication supabase_realtime;
`);

const dir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const required = readdirSync(dir).filter(file => file.endsWith('.sql') && (file.slice(0,14) <= '20260803213000' || file.startsWith('20260912180000') || file.startsWith('20260912193000'))).sort();
for (const file of required) {
  // PGlite provides gen_random_uuid in core; Supabase installs pgcrypto too.
  const sql = readFileSync(`${dir}/${file}`, 'utf8').replace(/create extension if not exists pgcrypto[^;]*;/gi, '');
  try { await db.exec(sql); } catch (error) { await db.close(); throw new Error(`Rental test schema failed at ${file}: ${error.message}`); }
}
return db;
}
export async function asUser(db, id, fn, role='authenticated') {
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [id || '', JSON.stringify({sub:id,email:`${id}@example.test`})]);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
